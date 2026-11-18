import type { TLRecord } from '@tldraw/tlschema'
import type { HistoryEvent, HistoryMetadata, HistorySource } from '../shared/history'
import { CanvasApiError } from './canvas-api'
import { schema, withRoomHistory, type RoomHandle } from './rooms'
import { canonicalJson, contentOf, TEXT_CONTENT_TYPES } from './shape-content'

/**
 * Exact per-shape History, and targeted recovery of one shape's content.
 *
 * History already stores the COMPLETE before and after record of every change, so a shape's earlier content is recoverable from it exactly,
 * without a second revision store and without rolling the rest of the board back. Recovery is an ordinary edit of the SAME shape (same id,
 * no duplicate), recorded as a later `object.edited` event whose metadata says it is a recovery; the damaging edit stays in History.
 *
 * Authority: reading needs \`history\`; recovering needs \`history\` AND \`write\` (it reads an old version and writes it back to one object). It is not
 * the board-wide \`restore\` scope, whose meaning is unchanged.
 */

export const RESTORE_MODES = ['content', 'content-and-placement'] as const
export type RestoreMode = (typeof RESTORE_MODES)[number]

/** What each mode leaves exactly as it currently is. */
const PRESERVED: Record<RestoreMode, string[]> = {
	content: ['id', 'x', 'y', 'rotation', 'index', 'parentId', 'isLocked', 'opacity', 'meta', 'props other than richText', 'arrow bindings'],
	'content-and-placement': ['id', 'index', 'parentId', 'isLocked', 'opacity', 'meta', 'arrow bindings'],
}

interface ShapeLike { id: string; type?: unknown; x?: unknown; y?: unknown; rotation?: unknown; props?: Record<string, unknown> }

/** Top-level fields, and `props.<name>` entries, that differ between two records. */
function changedFields(before: unknown, after: unknown): string[] {
	const a = (before ?? {}) as Record<string, unknown>
	const b = (after ?? {}) as Record<string, unknown>
	const out: string[] = []
	for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
		if (key === 'props') {
			const pa = (a.props ?? {}) as Record<string, unknown>, pb = (b.props ?? {}) as Record<string, unknown>
			for (const name of new Set([...Object.keys(pa), ...Object.keys(pb)])) if (canonicalJson(pa[name]) !== canonicalJson(pb[name])) out.push(`props.${name}`)
		} else if (canonicalJson(a[key]) !== canonicalJson(b[key])) out.push(key)
	}
	return out.sort()
}

function recoveryOf(metadata: HistoryMetadata) {
	if (metadata.recovery !== true) return null
	return { sourceEventId: metadata.sourceEventId ?? null, sourceRevision: metadata.sourceRevision ?? null, mode: metadata.recoveryMode ?? null }
}

function currentRecord(handle: RoomHandle, shapeId: string): { state: ShapeLike & Record<string, unknown>; revision: number } | null {
	const document = handle.room.getCurrentSnapshot().documents.find((item) => (item.state as { id: string }).id === shapeId)
	if (!document || (document.state as { typeName?: string }).typeName !== 'shape') return null
	return { state: document.state as unknown as ShapeLike & Record<string, unknown>, revision: document.lastChangedClock }
}

/**
 * The revisions of one shape, newest first, each with its complete content at that point (never a preview). \`revision\` is the document clock at
 * which the event was committed, the same number a canvas read reports for the shape after that change.
 */
export function listShapeHistory(handle: RoomHandle, shapeId: string, options: { limit?: number; beforeEventId?: number } = {}) {
	handle.recorder.flush()
	const page = handle.history.listEventsTouchingRecord(shapeId, { limit: options.limit ?? 20, ...(options.beforeEventId === undefined ? {} : { beforeId: options.beforeEventId }) })
	const current = currentRecord(handle, shapeId)
	return {
		shapeId,
		current: { exists: Boolean(current), revision: current?.revision ?? null },
		events: page.events.map((event) => {
			const change = event.changes.find((item) => item.recordId === shapeId)!
			return {
				eventId: event.id, revision: event.documentClock, createdAt: event.createdAt, eventType: event.eventType, source: event.source, actorUserId: event.actorUserId,
				action: change.before === null ? 'created' : change.after === null ? 'deleted' : 'edited',
				changedFields: changedFields(change.before, change.after),
				recovery: recoveryOf(event.metadata),
				content: change.after ? contentOf(change.after as unknown as ShapeLike) : null,
			}
		}),
		nextCursor: page.nextCursor,
	}
}

export interface RestoreInput {
	shapeId: string
	eventId?: number
	revision?: number
	expectedCurrentRevision: number
	mode: RestoreMode
	dryRun: boolean
	actor: { actorUserId: string | null; displayName: string }
	source: HistorySource
}

function resolveSource(handle: RoomHandle, input: RestoreInput): { event: HistoryEvent; after: ShapeLike } {
	let event: HistoryEvent | null = null
	if (input.eventId !== undefined) {
		event = handle.history.getEvent(input.eventId)
		if (!event || !event.changes.some((change) => change.recordId === input.shapeId)) throw new CanvasApiError(`History event ${input.eventId} did not change ${input.shapeId}`, 404, 'source_event_not_found')
		if (input.revision !== undefined && event.documentClock !== input.revision) throw new CanvasApiError(`Event ${input.eventId} is revision ${event.documentClock}, not ${input.revision}`, 422, 'revision_event_mismatch')
	} else {
		const matches: HistoryEvent[] = []
		let cursor: number | undefined
		for (let round = 0; round < 25; round += 1) {
			const page = handle.history.listEventsTouchingRecord(input.shapeId, { limit: 100, ...(cursor === undefined ? {} : { beforeId: cursor }) })
			for (const candidate of page.events) if (candidate.documentClock === input.revision) matches.push(candidate)
			if (page.nextCursor === null) break
			cursor = page.nextCursor
		}
		if (matches.length === 0) throw new CanvasApiError(`${input.shapeId} has no recorded revision ${input.revision}`, 404, 'revision_not_found')
		if (matches.length > 1) throw new CanvasApiError(`Revision ${input.revision} of ${input.shapeId} matches several events; name one with eventId`, 409, 'ambiguous_revision', { eventIds: matches.map((match) => match.id) })
		event = matches[0]
	}
	const after = event.changes.find((change) => change.recordId === input.shapeId)!.after as unknown as ShapeLike | null
	if (!after) throw new CanvasApiError(`Event ${event.id} deleted ${input.shapeId}; there is no content to recover from it`, 422, 'source_is_deletion')
	return { event, after }
}

/**
 * Restores one text shape's content from an earlier revision, or, with \`dryRun\`, says exactly what would change and writes nothing.
 * \`expectedCurrentRevision\` must be the shape's revision as the caller last read it; a shape changed since is a 409 and nothing is written.
 */
export function restoreShapeContent(handle: RoomHandle, input: RestoreInput) {
	handle.recorder.flush()
	const { event, after } = resolveSource(handle, input)
	const sourceContent = contentOf(after)
	if (!sourceContent) throw new CanvasApiError(`${input.shapeId} is not a text-bearing shape this API recovers (${[...TEXT_CONTENT_TYPES].join(', ')})`, 422, 'unsupported_shape_type')

	const current = currentRecord(handle, input.shapeId)
	if (!current) throw new CanvasApiError(`${input.shapeId} no longer exists on the board; restoring a deleted shape is not supported`, 404, 'shape_not_found')
	if (current.revision !== input.expectedCurrentRevision) {
		throw new CanvasApiError(`${input.shapeId} changed after revision ${input.expectedCurrentRevision} (it is now at ${current.revision}); read it again before restoring`, 409, 'revision_conflict', { id: input.shapeId, expectedCurrentRevision: input.expectedCurrentRevision, currentRevision: current.revision })
	}
	const currentContent = contentOf(current.state)
	if (!currentContent) throw new CanvasApiError(`${input.shapeId} is not a text-bearing shape this API recovers`, 422, 'unsupported_shape_type')
	if (current.state.type !== after.type) throw new CanvasApiError(`${input.shapeId} is a ${String(current.state.type)} now but a ${String(after.type)} at that revision`, 422, 'type_mismatch')

	const props = { ...(current.state.props ?? {}), ...(input.mode === 'content' ? { richText: after.props?.richText } : after.props) }
	const next = { ...current.state, props, ...(input.mode === 'content-and-placement' ? { x: after.x, y: after.y, rotation: after.rotation } : {}) }
	const fields = changedFields(current.state, next)
	const changed = fields.length > 0

	// What else happened to the board since the source revision, which a recovery of this one shape deliberately leaves alone.
	const later = handle.history.listEvents({ after: event.id, limit: 200, order: 'asc' })
	const touched = new Set<string>()
	for (const item of later.events) for (const change of item.changes) if (change.recordId !== input.shapeId) touched.add(change.recordId)
	const bySource: Record<string, number> = {}
	for (const item of later.events) bySource[item.source] = (bySource[item.source] ?? 0) + 1

	const preview = {
		shapeId: input.shapeId, mode: input.mode, dryRun: input.dryRun, changed, changedFields: fields,
		current: { revision: current.revision, originalLength: currentContent.originalLength, contentDigest: currentContent.contentDigest },
		source: { eventId: event.id, revision: event.documentClock, createdAt: event.createdAt, eventSource: event.source, actorUserId: event.actorUserId, originalLength: sourceContent.originalLength, contentDigest: sourceContent.contentDigest },
		preserved: PRESERVED[input.mode],
		unrelatedChangesSinceSource: { events: later.events.length, moreThanListed: later.nextCursor !== null, otherRecordsTouched: touched.size, eventsBySource: bySource },
	}
	if (input.dryRun || !changed) return { ...preview, restored: false as const }

	const metadata: HistoryMetadata = {
		recovery: true, recoveryMode: input.mode, targetShapeId: input.shapeId, sourceEventId: event.id, sourceRevision: event.documentClock,
		previousRevision: current.revision, previousLength: currentContent.originalLength, restoredLength: sourceContent.originalLength,
	}
	const { documentClock } = withRoomHistory(handle, {
		actorUserId: input.actor.actorUserId, actorDisplayName: input.actor.displayName, sessionId: null, source: input.source, immediate: true, metadata,
	}, () => handle.room.storage.transaction((txn) => {
		const live = txn.get(input.shapeId) as unknown as (TLRecord & Record<string, unknown>) | undefined
		// Defence in depth: the room is synchronous, but the write must be of exactly the record that was compared.
		if (!live || canonicalJson(live) !== canonicalJson(current.state)) throw new CanvasApiError(`${input.shapeId} changed while it was being restored; read it again`, 409, 'revision_conflict', { id: input.shapeId })
		schema.types.shape.validate(next as never, live as never)
		txn.set(input.shapeId, next as unknown as TLRecord)
	}))
	return { ...preview, restored: true as const, revision: documentClock, clock: documentClock }
}
