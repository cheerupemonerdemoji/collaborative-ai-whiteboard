import { getIndexAbove } from '@tldraw/utils'
import { toRichText, type TLBinding, type TLPage, type TLRecord, type TLShape, type TLShapeId } from '@tldraw/tlschema'
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
import { describeLayout, layoutOf, LayoutQueryError, parseLayoutQuery, rerouteManagedArrows, translateShape } from './layout-service'
import { ALIGNMENT_TOLERANCE, LAYOUT_GAP, LAYOUT_TOOLS, layoutActionSchema, type LayoutAction, type LayoutTool, type Measurement } from '../shared/layout'
import { ancestorsOf, edgePoint, rectsCloserThan, type PageLayout, type ShapeLayout } from '../shared/layout-geometry'
import {
	alignMoves, blockersFor, distributeMoves, findFreeRegion, gridMoves, LayoutError, placeBelow, placeRightOf, rowMoves, stackMoves, verifyLayout,
	type LayoutVerification, type Move, type VerifyExpectation,
} from '../shared/layout-engine'

const SEMANTIC_TOOLS = new Set<SemanticAction['tool']>([
	'create_entity', 'update_entity', 'link_entities', 'unlink_entities',
	'record_experiment_result', 'attach_evidence', 'update_status',
])
function isSemanticAction(action: CanvasAction | SemanticAction | LayoutAction): action is SemanticAction {
	return SEMANTIC_TOOLS.has(action.tool as SemanticAction['tool'])
}
const LAYOUT_TOOL_SET: ReadonlySet<string> = new Set(LAYOUT_TOOLS)
function isLayoutAction(action: CanvasAction | SemanticAction | LayoutAction): action is LayoutAction {
	return LAYOUT_TOOL_SET.has(action.tool)
}

/**
 * Deliberately a separate union from canvasActionSchema, not a merge into it -- shared/ai.ts is
 * unmodified by this feature. See docs/reviews/2026-09-22-chibi-entity-design-deepseek.md #3:
 * a test pins canvasActionSchema's exact shape so this file can never silently change it.
 */
const combinedActionSchema = z.union([canvasActionSchema, semanticActionSchema, layoutActionSchema])
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
export function readRoomCanvas<SessionMeta>(room: TLSocketRoom<TLRecord, SessionMeta>, requestedPageId?: string) {
	const snapshot = room.getCurrentSnapshot()
	const items = snapshot.documents.map((item) => item.state) as TLRecord[]
	const page = selectedPage(items, requestedPageId)
	return { pageId: page.id, pages: pages(items).map(({ id, name }) => ({ id, name })), clock: snapshot.documentClock, objects: shapes(items).filter((shape) => shape.parentId === page.id).map(objectFromShape) }
}

/**
 * Authoritative-where-possible page-space geometry for every shape on a page, nested ones included. Bounds only: no text,
 * no props. Each entry says where its bounds came from (`measured` by a browser, `declared` by the record, or
 * `estimated`) and whether they are verified; an estimate is never presented as exact. `ids` and `types` narrow the
 * response, and a page too large to return whole is refused rather than truncated silently.
 */
export function readRoomLayout<SessionMeta>(room: TLSocketRoom<TLRecord, SessionMeta>, measurements: ReadonlyMap<string, Measurement>, requestedPageId: string | undefined, rawQuery: Record<string, string | undefined>) {
	const snapshot = room.getCurrentSnapshot()
	const items = snapshot.documents.map((item) => item.state) as TLRecord[]
	const page = selectedPage(items, requestedPageId)
	try {
		const layout = layoutOf(items, page.id, measurements)
		return { pages: pages(items).map(({ id, name }) => ({ id, name })), clock: snapshot.documentClock, ...describeLayout(layout, parseLayoutQuery(rawQuery)) }
	} catch (error) {
		if (error instanceof LayoutQueryError) throw new CanvasApiError(error.message, error.statusCode)
		throw error
	}
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

/**
 * The only place `reference` stops being a fully opaque label: for `kind: 'table'` it must name a
 * structured-table artifact registered to *this* board (the board the action is being applied
 * to), even if the acting user also legitimately belongs to the board that really owns it - see
 * docs/reviews/2026-10-01-cross-board-asset-isolation-root-cause.md. `isAssetInBoard` is omitted
 * (not merely false) wherever board/DB context genuinely isn't available, e.g. the low-level
 * tests in tests/chibi-semantics.test.ts that construct a room directly with no board at all; the
 * real HTTP route (server/app.ts) always provides it, and that is where this property is actually
 * proven under test (tests/evidence-tables.test.ts's cross-board isolation suite). 404, not 403,
 * matches this app's existing choice to never reveal a board-scoped resource's existence to a
 * request that isn't authorized to see it.
 */
function assertTableReferenceInBoard(candidate: { entityType?: string; kind?: unknown; reference?: unknown }, isAssetInBoard: ((uploadId: string) => boolean) | undefined): void {
	if (!isAssetInBoard) return
	if (candidate.entityType !== 'evidence' || candidate.kind !== 'table') return
	if (typeof candidate.reference !== 'string') return
	if (!isAssetInBoard(candidate.reference)) throw new CanvasApiError('Unknown entity: referenced table artifact not found on this board', 404)
}

function applyCreateEntity(txn: { get(id: string): TLRecord | undefined; set(id: string, record: TLRecord): void }, entityCount: { current: number }, action: Extract<SemanticAction, { tool: 'create_entity' }>, actor: SemanticActor, now: number, isAssetInBoard?: (uploadId: string) => boolean): EngineeringEntity {
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
		...(action.tableSummary ? { tableSummary: action.tableSummary } : {}),
	}
	assertTableReferenceInBoard(candidate, isAssetInBoard)
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

function applyUpdateEntity(txn: { get(id: string): TLRecord | undefined; set(id: string, record: TLRecord): void }, id: string, patch: { title?: string; status?: string; shapeId?: string | null; fields?: Record<string, unknown>; tableSummary?: { rows: number; columns: string[] } }, actor: SemanticActor, now: number, isAssetInBoard?: (uploadId: string) => boolean): EngineeringEntity {
	const existing = findEntity(txn, id)
	const candidate = {
		...existing,
		...(patch.title !== undefined ? { title: patch.title } : {}),
		...(patch.status !== undefined ? { status: patch.status } : {}),
		...(patch.shapeId !== undefined ? { shapeId: patch.shapeId ?? undefined } : {}),
		...(patch.fields ?? {}),
		...(patch.tableSummary !== undefined ? { tableSummary: patch.tableSummary } : {}),
		updatedBy: actor.actorUserId,
		updatedAt: now,
	}
	assertTableReferenceInBoard(candidate, isAssetInBoard)
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

function applySemanticAction(txn: { get(id: string): TLRecord | undefined; set(id: string, record: TLRecord): void }, entityCount: { current: number }, action: SemanticAction, actor: SemanticActor, now: number, isAssetInBoard?: (uploadId: string) => boolean): void {
	switch (action.tool) {
		case 'create_entity': applyCreateEntity(txn, entityCount, action, actor, now, isAssetInBoard); return
		case 'update_entity': applyUpdateEntity(txn, action.id, { title: action.title, status: action.status, shapeId: action.shapeId, fields: action.fields, tableSummary: action.tableSummary }, actor, now, isAssetInBoard); return
		case 'link_entities': applyLinkEntities(txn, action.id, action.relationType, action.targetId, actor, now); return
		case 'unlink_entities': applyUnlinkEntities(txn, action.id, action.relationType, action.targetId, actor, now); return
		case 'record_experiment_result':
			applyUpdateEntity(txn, action.id, { status: action.status, fields: { result: action.result } }, actor, now, isAssetInBoard)
			return
		case 'attach_evidence': {
			const evidence = findEntity(txn, action.evidenceId)
			if (evidence.entityType !== 'evidence') throw new CanvasApiError(`${action.evidenceId} is not an evidence entity`, 422)
			applyLinkEntities(txn, action.id, 'supported_by', action.evidenceId, actor, now)
			return
		}
		case 'update_status': applyUpdateEntity(txn, action.id, { status: action.status }, actor, now, isAssetInBoard); return
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

export interface ApplyOptions {
	/** Browser-reported sizes for text and notes, so layout actions place against the best geometry known. */
	measurements?: ReadonlyMap<string, Measurement>
}

/** What this module needs from the room transaction, so the layout handlers can be written without the library's generics. */
interface Txn {
	get(id: string): TLRecord | undefined
	set(id: string, record: TLRecord): void
	delete(id: string): void
	values(): Iterable<TLRecord>
}

interface LayoutRun {
	/** Shapes whose geometry changed in this request, so arrows connected to them are re-routed at the end. */
	affected: Set<string>
	/** Shapes a layout action named or moved, which the final verification checks. */
	touched: Set<string>
	results: LayoutActionResult[]
}

export interface LayoutActionResult {
	index: number
	tool: LayoutTool
	moved: Array<{ id: string; dx: number; dy: number }>
	/** For find_free_region only: the region found, which nothing was written to. */
	region?: { x: number; y: number; w: number; h: number; direction: 'below' | 'right'; travel: number }
	/** For find_free_region: placement relied on neighbours whose bounds are not exact. */
	unverifiedNeighbours?: Array<{ id: string; reason: string }>
	verification?: LayoutVerification
}

export function applyRoomActions<SessionMeta>(room: TLSocketRoom<TLRecord, SessionMeta>, raw: unknown, actor: SemanticActor, isAssetInBoard?: (uploadId: string) => boolean, options: ApplyOptions = {}) {
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
		const run: LayoutRun = { affected: new Set(), touched: new Set(), results: [] }
		for (const [position, action] of request.actions.entries()) {
			if (isSemanticAction(action)) { applySemanticAction(txn, entityCount, action, actor, now, isAssetInBoard); continue }
			if (isLayoutAction(action)) { applyLayoutAction(txn, page, action, position, current, run, options.measurements); continue }
			if (action.tool === 'create_shape' || action.tool === 'create_text' || action.tool === 'create_arrow' || action.tool === 'connect_shapes') {
				if (txn.get(action.id)) throw new CanvasApiError(`Object ID already exists: ${action.id}`, 409)
				topIndex = getIndexAbove(topIndex)
				// An arrow drawn between two shapes is aimed at their real bounds (estimated for text no browser has measured).
				const layout = action.tool === 'connect_shapes' ? layoutOf([...txn.values()], page.id, options.measurements) : null
				const created = newShape(action, page.id, topIndex, current, layout)
				schema.types.shape.validate(created)
				txn.set(created.id, created)
				current.set(created.id, created)
				if (action.tool === 'connect_shapes') {
					// A genuine tldraw binding per terminal, so the arrow follows its boxes when they move, in the browser too.
					for (const binding of arrowBindings(created, action.fromId, action.toId)) {
						if (txn.get(binding.id)) throw new CanvasApiError(`Object ID already exists: ${binding.id}`, 409)
						schema.types.binding.validate(binding)
						txn.set(binding.id, binding)
					}
				}
				continue
			}
			const existing = current.get(action.id)
			if (!existing) throw new CanvasApiError(`Unknown object on this page: ${action.id}`, 404)
			if (action.tool === 'delete_shape') {
				txn.delete(existing.id)
				current.delete(existing.id)
				// A binding that points at (or from) a deleted shape would dangle, so it goes with it.
				for (const record of [...txn.values()]) {
					const binding = record as unknown as { typeName?: string; id: string; fromId?: string; toId?: string }
					if (binding.typeName === 'binding' && (binding.fromId === existing.id || binding.toId === existing.id)) txn.delete(binding.id)
				}
				continue
			}
			let updated: TLShape
			if (action.tool === 'move_shape') { updated = { ...existing, x: action.x, y: action.y }; run.affected.add(existing.id) }
			else if (action.tool === 'update_text') {
				if (!['geo', 'text', 'note'].includes(existing.type)) throw new CanvasApiError(`Shape ${existing.id} does not support text`)
				updated = { ...existing, props: { ...existing.props, richText: toRichText(action.text) } } as TLShape
			} else {
				if (!['geo', 'frame'].includes(existing.type)) throw new CanvasApiError(`Shape ${existing.id} cannot be resized`)
				updated = { ...existing, props: { ...existing.props, w: action.width, h: action.height } } as TLShape
				run.affected.add(existing.id)
			}
			schema.types.shape.validate(updated, existing)
			txn.set(updated.id, updated)
			current.set(updated.id, updated)
		}
		return { pageId: page.id, applied: request.actions.length, ...finishRun(txn, page, run, options.measurements) }
	})
	return { ...result, clock: documentClock }
}

function newShape(action: CanvasAction, pageId: TLPage['id'], index: TLShape['index'], current: Map<string, TLShape>, layout: PageLayout | null): TLShape {
	let type: TLShape['type']
	let x: number
	let y: number
	let props: Record<string, unknown>
	if (action.tool === 'create_shape') {
		type = 'geo'; x = action.x; y = action.y
		props = { geo: action.type, w: action.width, h: action.height, color: 'black', labelColor: 'black', fill: 'none', dash: 'draw', size: 'm', font: 'draw', align: 'middle', verticalAlign: 'middle', richText: toRichText(action.text), url: '', growY: 0, scale: 1, flipX: false, flipY: false }
	} else if (action.tool === 'create_text') {
		type = 'text'; x = action.x; y = action.y
		// With a width the text wraps at it (deterministic); without one it is one unwrapped line per paragraph, which is how
		// tldraw sizes autoSize text and can be very wide.
		props = { color: 'black', size: 'm', font: 'draw', textAlign: 'start', w: action.width ?? 200, richText: toRichText(action.text), scale: 1, autoSize: action.width === undefined }
	} else {
		let endX: number, endY: number
		if (action.tool === 'connect_shapes') {
			const from = current.get(action.fromId); const to = current.get(action.toId)
			const fromLayout = layout?.byId.get(action.fromId); const toLayout = layout?.byId.get(action.toId)
			if (!from || !to || !fromLayout || !toLayout) throw new CanvasApiError('Connection references an unknown object on this page', 404)
			const centre = (rect: { x: number; y: number; w: number; h: number }) => ({ x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 })
			const start = edgePoint(fromLayout.bounds, centre(toLayout.bounds), isEllipseShape(from))
			const end = edgePoint(toLayout.bounds, centre(fromLayout.bounds), isEllipseShape(to))
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

function isEllipseShape(shape: TLShape): boolean {
	const geo = (shape.props as unknown as Record<string, unknown>).geo
	return geo === 'ellipse' || geo === 'oval'
}

function arrowBindings(arrow: TLShape, fromId: string, toId: string): TLBinding[] {
	const base = arrow.id.replace(/^shape:/, '')
	const bind = (terminal: 'start' | 'end', target: string) => ({
		id: `binding:${base}_${terminal}`, typeName: 'binding', type: 'arrow', fromId: arrow.id, toId: target,
		props: { terminal, normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false, snap: 'none' }, meta: {},
	}) as unknown as TLBinding
	return [bind('start', fromId), bind('end', toId)]
}

/* ------------------------------------------------------------------ layout actions -- */

function asShapes(txn: Txn): TLShape[] {
	return shapes([...txn.values()])
}

function applyLayoutAction(txn: Txn, page: TLPage, action: LayoutAction, position: number, current: Map<string, TLShape>, run: LayoutRun, measurements: ReadonlyMap<string, Measurement> | undefined) {
	const layout = layoutOf([...txn.values()], page.id, measurements)
	try {
		const gap = ('gap' in action && action.gap !== undefined ? action.gap : LAYOUT_GAP)
		let moves: Move[] = []
		let expectation: VerifyExpectation = { requestedGap: gap }
		let ids: string[] = []
		switch (action.tool) {
			case 'find_free_region': {
				const near = action.near ? layout.byId.get(action.near) : undefined
				if (action.near && !near) throw new LayoutError(`Unknown object on this page: ${action.near}`, 404)
				const direction = action.direction ?? 'any'
				const anchor = near ? (direction === 'right' ? { x: near.bounds.x + near.bounds.w + gap, y: near.bounds.y } : { x: near.bounds.x, y: near.bounds.y + near.bounds.h + gap }) : undefined
				const region = findFreeRegion(layout, { w: action.width, h: action.height }, { ...(anchor ? { anchor } : {}), direction, gap })
				const nearby = blockersFor(layout, []).filter((blocker) => rectsCloserThan({ x: region.x, y: region.y, w: region.w, h: region.h }, blocker.rect, gap * 2))
				const unverifiedNeighbours = nearby.map((blocker) => layout.byId.get(blocker.id) as ShapeLayout).filter((shape) => shape.verification === 'unverified')
					.map((shape) => ({ id: shape.id, reason: shape.labelMayOverflow ? 'label-may-overflow' : shape.measurementStale ? 'measurement-stale' : 'estimated' }))
				run.results.push({ index: position, tool: action.tool, moved: [], region: { x: round(region.x), y: round(region.y), w: region.w, h: region.h, direction: region.direction, travel: round(region.travel) }, unverifiedNeighbours })
				return
			}
			case 'place_below':
				ids = [action.id]; assertMovable(layout, ids, [action.targetId])
				moves = placeBelow(layout, { id: action.id, targetId: action.targetId, gap, ...(action.align ? { align: action.align } : {}) })
				expectation = { requestedGap: gap, pairs: [[action.id, action.targetId]] }
				break
			case 'place_right_of':
				ids = [action.id]; assertMovable(layout, ids, [action.targetId])
				moves = placeRightOf(layout, { id: action.id, targetId: action.targetId, gap, ...(action.align ? { align: action.align } : {}) })
				expectation = { requestedGap: gap, pairs: [[action.id, action.targetId]] }
				break
			case 'align':
				ids = unique(action.ids); assertMovable(layout, ids)
				moves = alignMoves(layout, ids, action.axis)
				expectation = { alignAxis: action.axis, alignIds: ids }
				break
			case 'distribute': {
				ids = unique(action.ids); assertMovable(layout, ids)
				moves = distributeMoves(layout, ids, action.direction, action.gap)
				expectation = { ...(action.gap === undefined ? {} : { requestedGap: action.gap }), pairs: moves.slice(1).map((m, i) => [moves[i].id, m.id] as [string, string]) }
				break
			}
			case 'row':
				ids = unique(action.ids); assertMovable(layout, ids)
				moves = rowMoves(layout, ids, { gap, ...(action.align ? { align: action.align } : {}), ...optional(action) })
				expectation = { requestedGap: gap, pairs: ids.slice(1).map((id, i) => [ids[i], id] as [string, string]), alignAxis: action.align === 'bottom' ? 'bottom' : action.align === 'center' ? 'center-y' : 'top', alignIds: ids }
				break
			case 'stack':
				ids = unique(action.ids); assertMovable(layout, ids)
				moves = stackMoves(layout, ids, { gap, ...(action.align ? { align: action.align } : {}), ...optional(action) })
				expectation = { requestedGap: gap, pairs: ids.slice(1).map((id, i) => [ids[i], id] as [string, string]), alignAxis: action.align === 'right' ? 'right' : action.align === 'center' ? 'center-x' : 'left', alignIds: ids }
				break
			case 'grid': {
				ids = unique(action.ids); assertMovable(layout, ids)
				const columnGap = action.columnGap ?? gap, rowGap = action.rowGap ?? gap
				moves = gridMoves(layout, ids, action.columns, { gap, columnGap, rowGap, ...optional(action) })
				const pairs: Array<[string, string]> = []
				ids.forEach((id, i) => { if ((i + 1) % action.columns !== 0 && ids[i + 1]) pairs.push([id, ids[i + 1]]); if (ids[i + action.columns]) pairs.push([id, ids[i + action.columns]]) })
				expectation = { requestedGap: Math.min(columnGap, rowGap), pairs }
				break
			}
		}
		const moved = applyMoves(txn, layout, moves, page, current, run)
		const after = layoutOf([...txn.values()], page.id, measurements)
		for (const id of ids) run.touched.add(id)
		run.results.push({ index: position, tool: action.tool, moved, verification: verifyLayout(after, ids, expectation) })
	} catch (error) {
		if (error instanceof LayoutError) throw new CanvasApiError(error.message, error.statusCode)
		throw error
	}
}

const round = (value: number) => Math.round(value * 100) / 100
const unique = <T,>(list: readonly T[]) => [...new Set(list)]
const optional = (action: { x?: number; y?: number; avoidCollisions?: boolean }) => ({ ...(action.x === undefined ? {} : { x: action.x }), ...(action.y === undefined ? {} : { y: action.y }), ...(action.avoidCollisions === undefined ? {} : { avoidCollisions: action.avoidCollisions }) })

/** Arrows are positioned by what they connect, locked shapes were deliberately pinned by a person, and a shape cannot move with its own container. */
function assertMovable(layout: PageLayout, ids: readonly string[], references: readonly string[] = []) {
	for (const id of [...ids, ...references]) if (!layout.byId.has(id)) throw new LayoutError(`Unknown object on this page: ${id}`, 404)
	const moving = new Set(ids)
	for (const id of ids) {
		const shape = layout.byId.get(id) as ShapeLayout
		if (shape.type === 'arrow') throw new LayoutError(`${id} is an arrow: arrows follow the shapes they connect, so move those instead`)
		if (shape.locked) throw new LayoutError(`${id} is locked`, 409)
		for (const ancestor of ancestorsOf(layout, id)) if (moving.has(ancestor)) throw new LayoutError(`${id} cannot be moved together with its container ${ancestor}`)
	}
}

function applyMoves(txn: Txn, layout: PageLayout, moves: readonly Move[], page: TLPage, current: Map<string, TLShape>, run: LayoutRun): Array<{ id: string; dx: number; dy: number }> {
	const moved: Array<{ id: string; dx: number; dy: number }> = []
	for (const move of moves) {
		if (Math.abs(move.dx) < 0.001 && Math.abs(move.dy) < 0.001) continue
		const record = txn.get(move.id) as TLShape | undefined
		if (!record || record.typeName !== 'shape') throw new LayoutError(`Unknown object on this page: ${move.id}`, 404)
		const updated = translateShape(record, move, layout)
		schema.types.shape.validate(updated, record)
		txn.set(updated.id, updated)
		if (updated.parentId === page.id) current.set(updated.id, updated)
		run.affected.add(updated.id)
		moved.push({ id: updated.id, dx: round(move.dx), dy: round(move.dy) })
	}
	return moved
}

/**
 * End of every request: re-route the arrows this API drew whose boxes moved or resized (their bound ends already follow in
 * the browser), and, when layout actions ran, verify the resulting board and the arrows attached to what moved.
 */
function finishRun(txn: Txn, page: TLPage, run: LayoutRun, measurements: ReadonlyMap<string, Measurement> | undefined): { layout?: Record<string, unknown> } {
	if (run.affected.size > 0) {
		const before = layoutOf([...txn.values()], page.id, measurements)
		const records = new Map(asShapes(txn).map((shape) => [shape.id, shape]))
		for (const arrow of rerouteManagedArrows(before, records, run.affected)) { schema.types.shape.validate(arrow, records.get(arrow.id)); txn.set(arrow.id, arrow) }
	}
	if (run.results.length === 0) return {}
	const touched = [...new Set([...run.touched, ...run.affected])]
	const final = layoutOf([...txn.values()], page.id, measurements)
	const arrows = final.shapes.filter((shape) => shape.arrow && (touched.some((id) => shape.arrow?.connection?.fromId === id || shape.arrow?.connection?.toId === id || shape.arrow?.startBoundTo === id || shape.arrow?.endBoundTo === id))).map((shape) => {
		const a = shape.arrow as NonNullable<ShapeLayout['arrow']>
		const from = a.startBoundTo ?? a.connection?.fromId, to = a.endBoundTo ?? a.connection?.toId
		const startGap = from && final.byId.get(from) ? distanceToRect(a.start, final.byId.get(from)!.bounds) : null
		const endGap = to && final.byId.get(to) ? distanceToRect(a.end, final.byId.get(to)!.bounds) : null
		return { id: shape.id, from: from ?? null, to: to ?? null, bound: Boolean(a.startBoundTo || a.endBoundTo), attached: (startGap === null || startGap <= ALIGNMENT_TOLERANCE) && (endGap === null || endGap <= ALIGNMENT_TOLERANCE), startGap: startGap === null ? null : round(startGap), endGap: endGap === null ? null : round(endGap) }
	})
	const verification = verifyLayout(final, touched.filter((id) => final.byId.get(id)?.type !== 'arrow'))
	const statuses = [...run.results.map((item) => item.verification?.status), verification.status]
	// A region found beside estimated neighbours is only as certain as those estimates.
	const reliesOnEstimates = run.results.some((item) => (item.unverifiedNeighbours?.length ?? 0) > 0)
	const status = statuses.includes('overlaps') ? 'overlaps' : statuses.includes('partially_unverified') || reliesOnEstimates || arrows.some((arrow) => !arrow.attached) ? 'partially_unverified' : 'verified'
	return { layout: { status, results: run.results, final: verification, arrows, gap: LAYOUT_GAP } }
}

function distanceToRect(point: { x: number; y: number }, rect: { x: number; y: number; w: number; h: number }): number {
	const dx = Math.max(rect.x - point.x, 0, point.x - (rect.x + rect.w)), dy = Math.max(rect.y - point.y, 0, point.y - (rect.y + rect.h))
	return Math.hypot(dx, dy)
}
