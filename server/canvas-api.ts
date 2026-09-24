import { getIndexAbove } from '@tldraw/utils'
import { toRichText, type TLPage, type TLRecord, type TLShape, type TLShapeId } from '@tldraw/tlschema'
import type { TLSocketRoom } from '@tldraw/sync-core'
import { z } from 'zod'
import { canvasActionSchema, type CanvasAction, type CanvasObject } from '../shared/ai'
import {
	ARCHIVED_STATUS,
	defaultStatusFor,
	engineeringEntitySchema,
	semanticActionSchema,
	SEMANTIC_CONTEXT_LIMITS,
	SEMANTIC_WRITE_LIMITS,
	semanticContextRequestSchema,
	type EngineeringEntity,
	type SemanticAction,
	type SemanticContextRequest,
} from '../shared/entities'
import { schema } from './rooms'

const SEMANTIC_TOOLS = new Set<SemanticAction['tool']>([
	'create_entity', 'update_entity', 'link_entities', 'unlink_entities',
	'record_experiment_result', 'attach_evidence', 'update_status',
])
function isSemanticAction(action: CanvasAction | SemanticAction): action is SemanticAction {
	return SEMANTIC_TOOLS.has(action.tool as SemanticAction['tool'])
}

/**
 * Deliberately a separate union from canvasActionSchema, not a merge into it -- shared/ai.ts is
 * unmodified by this feature. See docs/reviews/2026-09-22-chibi-entity-design-deepseek.md #3:
 * a test pins canvasActionSchema's exact shape so this file can never silently change it.
 */
const combinedActionSchema = z.union([canvasActionSchema, semanticActionSchema])
const combinedActionsSchema = z.array(combinedActionSchema).min(1).max(30)

export const actionRequestSchema = z.object({
	pageId: z.string().regex(/^page:[A-Za-z0-9_-]{1,80}$/).optional(),
	expectedClock: z.number().int().nonnegative().optional(),
	actions: combinedActionsSchema,
}).strict()

export class CanvasApiError extends Error {
	constructor(message: string, readonly statusCode = 422) { super(message) }
}

export interface SemanticActor {
	actorUserId: string
	displayName: string
}

function pages(items: TLRecord[]) { return items.filter((item): item is TLPage => item.typeName === 'page').sort((a, b) => a.index.localeCompare(b.index)) }
function shapes(items: TLRecord[]) { return items.filter((item): item is TLShape => item.typeName === 'shape') }
function selectedPage(items: TLRecord[], requested?: string) {
	const available = pages(items)
	const page = requested ? available.find((item) => item.id === requested) : available[0]
	if (!page) throw new CanvasApiError('Page not found', 404)
	return page
}
function plainText(value: unknown): string {
	const text: string[] = []
	function visit(node: unknown) {
		if (!node || typeof node !== 'object') return
		const item = node as Record<string, unknown>
		if (item.type === 'text' && typeof item.text === 'string') text.push(item.text)
		if (Array.isArray(item.content)) item.content.forEach(visit)
	}
	visit(value)
	return text.join(' ').slice(0, 500)
}
function objectFromShape(shape: TLShape): CanvasObject {
	const props = shape.props as unknown as Record<string, unknown>
	const start = props.start as { x: number; y: number } | undefined
	const end = props.end as { x: number; y: number } | undefined
	const width = typeof props.w === 'number' ? Math.abs(props.w) : start && end ? Math.abs(end.x - start.x) : 0
	const height = typeof props.h === 'number' ? Math.abs(props.h) : start && end ? Math.abs(end.y - start.y) : 0
	const connection = shape.meta.canvasApiConnection as { fromId?: string; toId?: string } | undefined
	return { id: shape.id, type: shape.type === 'geo' ? String(props.geo) : shape.type, text: plainText(props.richText), x: shape.x, y: shape.y, width, height,
		...(start && end ? { startX: shape.x + start.x, startY: shape.y + start.y, endX: shape.x + end.x, endY: shape.y + end.y } : {}),
		...(connection?.fromId && connection?.toId ? { fromId: connection.fromId, toId: connection.toId } : {}),
	}
}
function edgePoint(shape: TLShape, toward: { x: number; y: number }) {
	const object = objectFromShape(shape)
	const center = { x: object.x + object.width / 2, y: object.y + object.height / 2 }
	const dx = toward.x - center.x, dy = toward.y - center.y
	if (!dx && !dy) return center
	const rx = Math.max(object.width / 2, 1), ry = Math.max(object.height / 2, 1)
	const scale = object.type === 'ellipse'
		? 1 / Math.sqrt((dx / rx) ** 2 + (dy / ry) ** 2)
		: 1 / Math.max(Math.abs(dx) / rx, Math.abs(dy) / ry)
	return { x: center.x + dx * scale, y: center.y + dy * scale }
}

export function readRoomCanvas<SessionMeta>(room: TLSocketRoom<TLRecord, SessionMeta>, requestedPageId?: string) {
	const snapshot = room.getCurrentSnapshot()
	const items = snapshot.documents.map((item) => item.state) as TLRecord[]
	const page = selectedPage(items, requestedPageId)
	return { pageId: page.id, pages: pages(items).map(({ id, name }) => ({ id, name })), clock: snapshot.documentClock, objects: shapes(items).filter((shape) => shape.parentId === page.id).map(objectFromShape) }
}

/* ------------------------------------------------------------ semantic layer -- */

/**
 * @tldraw/tlschema's exported `TLRecord` type is a fixed union of the library's own known
 * record types and does not widen to reflect custom records registered via createTLSchema's
 * `records` option, even though the runtime fully supports them (verified against the
 * installed package source; see docs/reviews/2026-09-22-chibi-entity-design-deepseek.md).
 * These casts are the narrow, deliberate workaround for that library typing gap, not a general
 * escape hatch -- they're confined to this file's semantic read/write boundary.
 */
function entities(items: TLRecord[]): EngineeringEntity[] {
	return items.filter((item) => (item.typeName as string) === 'engineering_entity') as unknown as EngineeringEntity[]
}

function byteSize(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

function applyCreateEntity(txn: { get(id: string): TLRecord | undefined; set(id: string, record: TLRecord): void }, entityCount: { current: number }, action: Extract<SemanticAction, { tool: 'create_entity' }>, actor: SemanticActor, now: number): EngineeringEntity {
	if (txn.get(action.id)) throw new CanvasApiError(`Entity ID already exists: ${action.id}`, 409)
	if (entityCount.current >= SEMANTIC_WRITE_LIMITS.maxEntitiesPerBoard) throw new CanvasApiError('This board has reached its engineering-entity limit', 422)
	const candidate = {
		typeName: 'engineering_entity' as const,
		id: action.id,
		entityType: action.entityType,
		...(action.shapeId ? { shapeId: action.shapeId } : {}),
		title: action.title,
		status: action.status ?? defaultStatusFor(action.entityType),
		relations: [],
		createdBy: actor.actorUserId,
		updatedBy: actor.actorUserId,
		createdAt: now,
		updatedAt: now,
		...(action.fields ?? {}),
	}
	const validated = engineeringEntitySchema.parse(candidate)
	if (byteSize(validated) > SEMANTIC_WRITE_LIMITS.maxEntityBytes) throw new CanvasApiError('Entity exceeds the per-record size limit', 422)
	txn.set(validated.id, validated as unknown as TLRecord)
	entityCount.current += 1
	return validated
}

function findEntity(txn: { get(id: string): TLRecord | undefined }, id: string): EngineeringEntity {
	const existing = txn.get(id)
	if (!existing || (existing.typeName as string) !== 'engineering_entity') throw new CanvasApiError(`Unknown entity: ${id}`, 404)
	return existing as unknown as EngineeringEntity
}

function applyUpdateEntity(txn: { get(id: string): TLRecord | undefined; set(id: string, record: TLRecord): void }, id: string, patch: { title?: string; status?: string; shapeId?: string | null; fields?: Record<string, unknown> }, actor: SemanticActor, now: number): EngineeringEntity {
	const existing = findEntity(txn, id)
	const candidate = {
		...existing,
		...(patch.title !== undefined ? { title: patch.title } : {}),
		...(patch.status !== undefined ? { status: patch.status } : {}),
		...(patch.shapeId !== undefined ? { shapeId: patch.shapeId ?? undefined } : {}),
		...(patch.fields ?? {}),
		updatedBy: actor.actorUserId,
		updatedAt: now,
	}
	const validated = engineeringEntitySchema.parse(candidate)
	if (byteSize(validated) > SEMANTIC_WRITE_LIMITS.maxEntityBytes) throw new CanvasApiError('Entity exceeds the per-record size limit', 422)
	txn.set(validated.id, validated as unknown as TLRecord)
	return validated
}

function applyLinkEntities(txn: { get(id: string): TLRecord | undefined; set(id: string, record: TLRecord): void }, id: string, relationType: EngineeringEntity['relations'][number]['type'], targetId: string, actor: SemanticActor, now: number): EngineeringEntity {
	const existing = findEntity(txn, id)
	findEntity(txn, targetId) // must resolve to a real entity; never a dangling reference
	if (existing.relations.some((relation) => relation.type === relationType && relation.targetId === targetId)) return existing
	const relations = [...existing.relations, { type: relationType, targetId }]
	const candidate = { ...existing, relations, updatedBy: actor.actorUserId, updatedAt: now }
	const validated = engineeringEntitySchema.parse(candidate)
	txn.set(validated.id, validated as unknown as TLRecord)
	return validated
}

function applyUnlinkEntities(txn: { get(id: string): TLRecord | undefined; set(id: string, record: TLRecord): void }, id: string, relationType: EngineeringEntity['relations'][number]['type'], targetId: string, actor: SemanticActor, now: number): EngineeringEntity {
	const existing = findEntity(txn, id)
	const relations = existing.relations.filter((relation) => !(relation.type === relationType && relation.targetId === targetId))
	const candidate = { ...existing, relations, updatedBy: actor.actorUserId, updatedAt: now }
	const validated = engineeringEntitySchema.parse(candidate)
	txn.set(validated.id, validated as unknown as TLRecord)
	return validated
}

function applySemanticAction(txn: { get(id: string): TLRecord | undefined; set(id: string, record: TLRecord): void }, entityCount: { current: number }, action: SemanticAction, actor: SemanticActor, now: number): void {
	switch (action.tool) {
		case 'create_entity': applyCreateEntity(txn, entityCount, action, actor, now); return
		case 'update_entity': applyUpdateEntity(txn, action.id, { title: action.title, status: action.status, shapeId: action.shapeId, fields: action.fields }, actor, now); return
		case 'link_entities': applyLinkEntities(txn, action.id, action.relationType, action.targetId, actor, now); return
		case 'unlink_entities': applyUnlinkEntities(txn, action.id, action.relationType, action.targetId, actor, now); return
		case 'record_experiment_result':
			applyUpdateEntity(txn, action.id, { status: action.status, fields: { result: action.result } }, actor, now)
			return
		case 'attach_evidence': {
			const evidence = findEntity(txn, action.evidenceId)
			if (evidence.entityType !== 'evidence') throw new CanvasApiError(`${action.evidenceId} is not an evidence entity`, 422)
			applyLinkEntities(txn, action.id, 'supported_by', action.evidenceId, actor, now)
			return
		}
		case 'update_status': applyUpdateEntity(txn, action.id, { status: action.status }, actor, now); return
	}
}

/** Compact, filtered, budget-capped semantic context -- never the full raw tldraw document. */
export function readRoomSemantics<SessionMeta>(room: TLSocketRoom<TLRecord, SessionMeta>, raw: unknown) {
	const request: SemanticContextRequest = semanticContextRequestSchema.parse(raw)
	const snapshot = room.getCurrentSnapshot()
	const items = snapshot.documents.map((item) => item.state) as TLRecord[]
	const all = entities(items)

	let selected = request.includeArchived ? all : all.filter((entity) => entity.status !== ARCHIVED_STATUS)
	if (request.entityTypes?.length) { const types = new Set(request.entityTypes); selected = selected.filter((entity) => types.has(entity.entityType)) }
	if (request.status?.length) { const statuses = new Set(request.status); selected = selected.filter((entity) => statuses.has(entity.status)) }
	if (request.ids?.length) { const ids = new Set(request.ids); selected = selected.filter((entity) => ids.has(entity.id)) }
	if (selected.length > SEMANTIC_CONTEXT_LIMITS.maxEntities) throw new CanvasApiError('Entity selection exceeds the compact-context limit; narrow the request', 422)

	let relationships: Array<{ from: string; type: string; to: string }> = []
	let referenced: EngineeringEntity[] = []
	if (request.relationsFor) {
		const source = all.find((entity) => entity.id === request.relationsFor)
		const outgoing = source ? source.relations.map((relation) => ({ from: source.id, type: relation.type, to: relation.targetId })) : []
		const incoming = all
			.filter((entity) => entity.id !== request.relationsFor)
			.flatMap((entity) => entity.relations
				.filter((relation) => relation.targetId === request.relationsFor)
				.map((relation) => ({ from: entity.id, type: relation.type, to: request.relationsFor as string })))
		relationships = [...outgoing, ...incoming]
		if (relationships.length > SEMANTIC_CONTEXT_LIMITS.maxRelationshipEdges) throw new CanvasApiError('Relationship edge limit exceeded; this entity has too many one-hop neighbors for a single response', 422)
		const neighborIds = new Set(relationships.flatMap((edge) => [edge.from, edge.to]))
		neighborIds.delete(request.relationsFor)
		referenced = all.filter((entity) => neighborIds.has(entity.id)).slice(0, SEMANTIC_CONTEXT_LIMITS.maxReferencedSummaries)
	}

	const payload = { clock: snapshot.documentClock, entities: selected, relationships, referenced }
	if (byteSize(payload) > SEMANTIC_CONTEXT_LIMITS.maxSerializedBytes) throw new CanvasApiError('Compact semantic context exceeds the serialized size limit; narrow the request', 422)
	return payload
}

export function applyRoomActions<SessionMeta>(room: TLSocketRoom<TLRecord, SessionMeta>, raw: unknown, actor: SemanticActor) {
	const request = actionRequestSchema.parse(raw)
	const { result, documentClock } = room.storage.transaction((txn) => {
		if (request.expectedClock !== undefined && txn.getClock() !== request.expectedClock) throw new CanvasApiError('Canvas changed; read it again and retry', 409)
		const items = [...txn.values()]
		const page = selectedPage(items, request.pageId)
		const pageShapes = shapes(items).filter((shape) => shape.parentId === page.id)
		const current = new Map<string, TLShape>(pageShapes.map((shape) => [shape.id, shape]))
		let topIndex = pageShapes.map((shape) => shape.index).sort().at(-1)
		const entityCount = { current: entities(items).length }
		const now = Date.now()
		for (const action of request.actions) {
			if (isSemanticAction(action)) { applySemanticAction(txn, entityCount, action, actor, now); continue }
			if (action.tool === 'create_shape' || action.tool === 'create_text' || action.tool === 'create_arrow' || action.tool === 'connect_shapes') {
				if (txn.get(action.id)) throw new CanvasApiError(`Object ID already exists: ${action.id}`, 409)
				topIndex = getIndexAbove(topIndex)
				const created = newShape(action, page.id, topIndex, current)
				schema.types.shape.validate(created)
				txn.set(created.id, created)
				current.set(created.id, created)
				continue
			}
			const existing = current.get(action.id)
			if (!existing) throw new CanvasApiError(`Unknown object on this page: ${action.id}`, 404)
			if (action.tool === 'delete_shape') { txn.delete(existing.id); current.delete(existing.id); continue }
			let updated: TLShape
			if (action.tool === 'move_shape') updated = { ...existing, x: action.x, y: action.y }
			else if (action.tool === 'update_text') {
				if (!['geo', 'text', 'note'].includes(existing.type)) throw new CanvasApiError(`Shape ${existing.id} does not support text`)
				updated = { ...existing, props: { ...existing.props, richText: toRichText(action.text) } } as TLShape
			} else {
				if (!['geo', 'frame'].includes(existing.type)) throw new CanvasApiError(`Shape ${existing.id} cannot be resized`)
				updated = { ...existing, props: { ...existing.props, w: action.width, h: action.height } } as TLShape
			}
			schema.types.shape.validate(updated, existing)
			txn.set(updated.id, updated)
			current.set(updated.id, updated)
		}
		return { pageId: page.id, applied: request.actions.length }
	})
	return { ...result, clock: documentClock }
}

function newShape(action: CanvasAction, pageId: TLPage['id'], index: TLShape['index'], current: Map<string, TLShape>): TLShape {
	let type: TLShape['type']
	let x: number
	let y: number
	let props: Record<string, unknown>
	if (action.tool === 'create_shape') {
		type = 'geo'; x = action.x; y = action.y
		props = { geo: action.type, w: action.width, h: action.height, color: 'black', labelColor: 'black', fill: 'none', dash: 'draw', size: 'm', font: 'draw', align: 'middle', verticalAlign: 'middle', richText: toRichText(action.text), url: '', growY: 0, scale: 1, flipX: false, flipY: false }
	} else if (action.tool === 'create_text') {
		type = 'text'; x = action.x; y = action.y
		props = { color: 'black', size: 'm', font: 'draw', textAlign: 'start', w: 200, richText: toRichText(action.text), scale: 1, autoSize: true }
	} else {
		let endX: number, endY: number
		if (action.tool === 'connect_shapes') {
			const from = current.get(action.fromId); const to = current.get(action.toId)
			if (!from || !to) throw new CanvasApiError('Connection references an unknown object on this page', 404)
			const a = objectFromShape(from); const b = objectFromShape(to)
			const aCenter = { x: a.x + a.width / 2, y: a.y + a.height / 2 }
			const bCenter = { x: b.x + b.width / 2, y: b.y + b.height / 2 }
			const start = edgePoint(from, bCenter); const end = edgePoint(to, aCenter)
			x = start.x; y = start.y; endX = end.x; endY = end.y
		} else if (action.tool === 'create_arrow') { x = action.x; y = action.y; endX = action.endX; endY = action.endY }
		else throw new CanvasApiError('Unsupported create action')
		type = 'arrow'
		props = { kind: 'arc', color: 'black', labelColor: 'black', fill: 'none', dash: 'draw', size: 'm', arrowheadStart: 'none', arrowheadEnd: 'arrow', font: 'draw', start: { x: 0, y: 0 }, end: { x: endX - x, y: endY - y }, bend: 0, richText: toRichText(''), labelPosition: 0.5, scale: 1, elbowMidPoint: 0.5 }
	}
	return { id: action.id as TLShapeId, typeName: 'shape', type, x, y, rotation: 0, index, parentId: pageId, isLocked: false, opacity: 1, props,
		meta: action.tool === 'connect_shapes' ? { canvasApiConnection: { fromId: action.fromId, toId: action.toId } } : {},
	} as unknown as TLShape
}
