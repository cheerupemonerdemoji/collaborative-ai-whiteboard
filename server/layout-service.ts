import type { TLBinding, TLRecord, TLShape } from '@tldraw/tlschema'
import { LAYOUT_GAP, MAX_LAYOUT_SHAPES, type Measurement } from '../shared/layout'
import { computeLayout, edgePoint, type LayoutBindingRecord, type LayoutShapeRecord, type PageLayout, type ShapeLayout } from '../shared/layout-geometry'
import { roundRect } from '../shared/layout-engine'

/**
 * The server's seam to the pure layout core: tldraw records in, a compact machine-readable layout out, and the two
 * write-side helpers the layout actions need (translate a shape by a page-space delta, re-route the arrows this API drew).
 * No store access happens here; callers pass records and apply the results inside their own transaction.
 */

export function toLayoutInput(items: readonly TLRecord[], pageId: string, measurements?: ReadonlyMap<string, Measurement>) {
	const shapes = items.filter((item): item is TLShape => item.typeName === 'shape') as unknown as LayoutShapeRecord[]
	const bindings = items.filter((item): item is TLBinding => item.typeName === 'binding') as unknown as LayoutBindingRecord[]
	return { pageId, shapes, bindings, ...(measurements ? { measurements } : {}) }
}

export function layoutOf(items: readonly TLRecord[], pageId: string, measurements?: ReadonlyMap<string, Measurement>): PageLayout {
	return computeLayout(toLayoutInput(items, pageId, measurements))
}

export interface LayoutQuery {
	ids?: string[]
	types?: string[]
}

export class LayoutQueryError extends Error {
	constructor(message: string, readonly statusCode = 422) { super(message) }
}

export function parseLayoutQuery(raw: Record<string, string | undefined>): LayoutQuery {
	const list = (value: string | undefined, pattern: RegExp, label: string) => {
		if (!value) return undefined
		const parts = value.split(',').map((part) => part.trim()).filter(Boolean)
		if (parts.length > 500) throw new LayoutQueryError(`Too many ${label}`, 400)
		for (const part of parts) if (!pattern.test(part)) throw new LayoutQueryError(`Invalid ${label}`, 400)
		return parts
	}
	return { ids: list(raw.ids, /^shape:[A-Za-z0-9_-]{1,80}$/, 'ids'), types: list(raw.types, /^[a-z][a-z0-9_-]{0,39}$/, 'types') }
}

export interface LayoutEntry {
	id: string
	type: string
	bounds: { x: number; y: number; w: number; h: number }
	boundsSource: ShapeLayout['boundsSource']
	verification: ShapeLayout['verification']
	rotation: number
	parentId: string
	/** The shape's fractional index among its siblings. */
	index: string
	/** Position in the page's paint order, back to front. */
	zIndex: number
	locked?: true
	labelMayOverflow?: true
	measurementStale?: true
	unknownType?: true
	arrow?: ShapeLayout['arrow']
}

function entryOf(shape: ShapeLayout): LayoutEntry {
	const round = (value: number) => Math.round(value * 1000) / 1000
	return {
		id: shape.id, type: shape.type, bounds: roundRect(shape.bounds), boundsSource: shape.boundsSource, verification: shape.verification,
		rotation: round(shape.rotation), parentId: shape.parentId, index: shape.index, zIndex: shape.zIndex,
		...(shape.locked ? { locked: true as const } : {}),
		...(shape.labelMayOverflow ? { labelMayOverflow: true as const } : {}),
		...(shape.measurementStale ? { measurementStale: true as const } : {}),
		...(shape.unknownType ? { unknownType: true as const } : {}),
		...(shape.arrow ? { arrow: { ...shape.arrow, start: { x: round(shape.arrow.start.x), y: round(shape.arrow.start.y) }, end: { x: round(shape.arrow.end.x), y: round(shape.arrow.end.y) } } } : {}),
	}
}

/** The compact layout response: bounds and authority only, never text, props or shape payloads. */
export function describeLayout(layout: PageLayout, query: LayoutQuery = {}) {
	const ids = query.ids ? new Set(query.ids) : null
	const types = query.types ? new Set(query.types) : null
	const selected = layout.shapes.filter((shape) => (!ids || ids.has(shape.id)) && (!types || types.has(shape.type)))
	if (selected.length > MAX_LAYOUT_SHAPES) throw new LayoutQueryError(`This page has ${selected.length} matching shapes, more than the ${MAX_LAYOUT_SHAPES} one layout read returns; narrow it with ids or types`)
	const counts = { shapes: selected.length, measured: 0, declared: 0, estimated: 0, unverified: 0 }
	for (const shape of selected) {
		counts[shape.boundsSource] += 1
		if (shape.verification === 'unverified') counts.unverified += 1
	}
	return {
		pageId: layout.pageId,
		gap: LAYOUT_GAP,
		bounds: layout.extent ? roundRect(layout.extent) : null,
		counts,
		shapes: selected.map(entryOf),
	}
}

/**
 * Moves a shape record by a page-space delta. A shape nested in a rotated container has its `x`/`y` in the container's
 * frame, so the delta is rotated back into it; for a shape on the page the delta applies directly.
 */
export function translateShape(shape: TLShape, delta: { dx: number; dy: number }, layout: PageLayout): TLShape {
	const parent = layout.byId.get(shape.parentId)
	const rotation = parent ? parent.rotation : 0
	const cos = Math.cos(-rotation), sin = Math.sin(-rotation)
	const dx = delta.dx * cos - delta.dy * sin
	const dy = delta.dx * sin + delta.dy * cos
	return { ...shape, x: shape.x + dx, y: shape.y + dy } as TLShape
}

/**
 * Recomputes the endpoints of arrows THIS API drew (those carrying `meta.canvasApiConnection`) whose boxes are among
 * `affected`, from the boxes' current bounds, so they keep pointing at what they connect. Arrows a person drew, and any
 * tldraw bindings, are never touched: a bound arrow follows its shapes by itself in the browser.
 */
export function rerouteManagedArrows(layout: PageLayout, records: ReadonlyMap<string, TLShape>, affected: ReadonlySet<string>): TLShape[] {
	const updated: TLShape[] = []
	for (const shape of layout.shapes) {
		if (shape.type !== 'arrow' || !shape.arrow?.connection) continue
		const { fromId, toId } = shape.arrow.connection
		if (!affected.has(fromId) && !affected.has(toId)) continue
		const record = records.get(shape.id)
		const from = layout.byId.get(fromId), to = layout.byId.get(toId)
		if (!record || !from || !to || record.parentId !== layout.pageId) continue
		const fromEllipse = isEllipse(records.get(fromId)), toEllipse = isEllipse(records.get(toId))
		const centre = (rect: { x: number; y: number; w: number; h: number }) => ({ x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 })
		const start = edgePoint(from.bounds, centre(to.bounds), fromEllipse)
		const end = edgePoint(to.bounds, centre(from.bounds), toEllipse)
		const props = record.props as unknown as Record<string, unknown>
		updated.push({ ...record, x: start.x, y: start.y, props: { ...props, start: { x: 0, y: 0 }, end: { x: end.x - start.x, y: end.y - start.y } } } as unknown as TLShape)
	}
	return updated
}

function isEllipse(record: TLShape | undefined): boolean {
	const geo = (record?.props as unknown as Record<string, unknown> | undefined)?.geo
	return geo === 'ellipse' || geo === 'oval'
}
