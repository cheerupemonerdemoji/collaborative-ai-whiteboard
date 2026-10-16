import {
	estimateLabelNeed,
	estimateText,
	richTextParagraphs,
	textFontPx,
	layoutFingerprint,
	type BoundsSource,
	type Measurement,
	type Point,
	type Rect,
	type Verification,
} from './layout'

/**
 * Turns tldraw records into page-space geometry, without tldraw's Editor (which needs a DOM) and without guessing
 * where it can be exact. Pure and dependency-free so the server, the tests and a future human "Tidy" command share it.
 *
 * What is exact: position (x, y, rotation and every parent transform) and the stored size of geo, frame, image,
 * video, bookmark, embed, draw and line shapes. What is not: the size of text and note labels, which tldraw measures
 * in the browser. Those use a reported `measured` size when its fingerprint still matches the content, and an
 * `estimated` (deliberately large, `unverified`) size otherwise.
 */

export interface LayoutShapeRecord {
	id: string
	type: string
	x: number
	y: number
	rotation: number
	index: string
	parentId: string
	props: Record<string, unknown>
	meta?: Record<string, unknown>
}

export interface LayoutBindingRecord {
	id: string
	type?: string
	fromId: string
	toId: string
	props: Record<string, unknown>
}

export interface ArrowLayout {
	start: Point
	end: Point
	/** Shape ids the terminals are bound to by tldraw bindings (they follow those shapes when moved). */
	startBoundTo?: string
	endBoundTo?: string
	/** The endpoints an API-created arrow was built between, from `meta.canvasApiConnection`. */
	connection?: { fromId: string; toId: string }
	/** Created by the Machine API, so the server may re-route it when its boxes move. */
	managed: boolean
}

export interface ShapeLayout {
	id: string
	type: string
	parentId: string
	/** The shape's fractional index among its siblings; `zIndex` is its resulting position in the page's paint order. */
	index: string
	zIndex: number
	/** Page-space rotation in radians. */
	rotation: number
	/** Page-space axis-aligned bounds. */
	bounds: Rect
	boundsSource: BoundsSource
	verification: Verification
	/** The shape's own unrotated size. */
	local: { w: number; h: number }
	locked: boolean
	/** A geo label probably needs more room than the box has (an estimate; tldraw grows the box in the browser). */
	labelMayOverflow?: boolean
	/** A measurement exists but the content changed since, so it was ignored. */
	measurementStale?: boolean
	unknownType?: boolean
	arrow?: ArrowLayout
}

export interface PageLayout {
	pageId: string
	/** Every shape under the page, in paint order (back to front). */
	shapes: ShapeLayout[]
	byId: Map<string, ShapeLayout>
	childrenOf: Map<string, string[]>
	/** Union of every non-arrow shape's bounds, or null for an empty page. */
	extent: Rect | null
}

export interface LayoutInput {
	pageId: string
	shapes: readonly LayoutShapeRecord[]
	bindings?: readonly LayoutBindingRecord[]
	measurements?: ReadonlyMap<string, Measurement>
}

/* -------------------------------------------------------------------------- rects -- */

export const rectRight = (rect: Rect) => rect.x + rect.w
export const rectBottom = (rect: Rect) => rect.y + rect.h

export function rectUnion(rects: readonly Rect[]): Rect | null {
	if (rects.length === 0) return null
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
	for (const rect of rects) {
		minX = Math.min(minX, rect.x)
		minY = Math.min(minY, rect.y)
		maxX = Math.max(maxX, rectRight(rect))
		maxY = Math.max(maxY, rectBottom(rect))
	}
	return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

/** Whether the rectangles overlap or come closer than `gap` apart (touching edges count as closer than any gap > 0). */
export function rectsCloserThan(a: Rect, b: Rect, gap: number): boolean {
	return a.x < rectRight(b) + gap && b.x < rectRight(a) + gap && a.y < rectBottom(b) + gap && b.y < rectBottom(a) + gap
}

/** The area two rectangles share (0 when they only touch or are apart). */
export function overlapArea(a: Rect, b: Rect): number {
	const w = Math.min(rectRight(a), rectRight(b)) - Math.max(a.x, b.x)
	const h = Math.min(rectBottom(a), rectBottom(b)) - Math.max(a.y, b.y)
	return w > 0 && h > 0 ? w * h : 0
}

/* ------------------------------------------------------------------- transforms -- */

type Matrix = readonly [number, number, number, number, number, number]
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

function local(shape: { x: number; y: number; rotation: number }): Matrix {
	const cos = Math.cos(shape.rotation), sin = Math.sin(shape.rotation)
	return [cos, sin, -sin, cos, shape.x, shape.y]
}

function compose(parent: Matrix, child: Matrix): Matrix {
	const [a1, b1, c1, d1, e1, f1] = parent
	const [a2, b2, c2, d2, e2, f2] = child
	return [a1 * a2 + c1 * b2, b1 * a2 + d1 * b2, a1 * c2 + c1 * d2, b1 * c2 + d1 * d2, a1 * e2 + c1 * f2 + e1, b1 * e2 + d1 * f2 + f1]
}

function apply(matrix: Matrix, point: Point): Point {
	return { x: matrix[0] * point.x + matrix[2] * point.y + matrix[4], y: matrix[1] * point.x + matrix[3] * point.y + matrix[5] }
}

function aabb(matrix: Matrix, rect: Rect): Rect {
	const corners = [
		apply(matrix, { x: rect.x, y: rect.y }), apply(matrix, { x: rect.x + rect.w, y: rect.y }),
		apply(matrix, { x: rect.x, y: rect.y + rect.h }), apply(matrix, { x: rect.x + rect.w, y: rect.y + rect.h }),
	]
	const xs = corners.map((corner) => corner.x), ys = corners.map((corner) => corner.y)
	return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
}

const num = (value: unknown, fallback = 0): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)

/* -------------------------------------------------------------------- arrow math -- */

/** Where a line from a rectangle's centre toward `toward` leaves the rectangle (or an inscribed ellipse). */
export function edgePoint(bounds: Rect, toward: Point, ellipse = false): Point {
	const center = { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 }
	const dx = toward.x - center.x, dy = toward.y - center.y
	if (!dx && !dy) return center
	const rx = Math.max(bounds.w / 2, 1), ry = Math.max(bounds.h / 2, 1)
	const scale = ellipse ? 1 / Math.sqrt((dx / rx) ** 2 + (dy / ry) ** 2) : 1 / Math.max(Math.abs(dx) / rx, Math.abs(dy) / ry)
	return { x: center.x + dx * scale, y: center.y + dy * scale }
}

/* ---------------------------------------------------------------------- the core -- */

interface Sized {
	rect: Rect
	source: BoundsSource
	verification: Verification
	labelMayOverflow?: boolean
	measurementStale?: boolean
	unknownType?: boolean
}

const STORED_SIZE_TYPES = new Set(['frame', 'image', 'video', 'bookmark', 'embed'])

function declared(rect: Rect, extra: Partial<Sized> = {}): Sized {
	return { rect, source: 'declared', verification: 'verified', ...extra }
}

function sizeOf(shape: LayoutShapeRecord, measurements: ReadonlyMap<string, Measurement> | undefined): Sized | null {
	const p = shape.props
	if (shape.type === 'geo') {
		const w = Math.max(1, num(p.w)), h = Math.max(1, num(p.h) + num(p.growY))
		const needed = estimateLabelNeed(richTextParagraphs(p.richText), w, { size: p.size, font: p.font })
		const overflow = needed > h + 1
		return declared({ x: 0, y: 0, w, h }, overflow ? { labelMayOverflow: true, verification: 'unverified' } : {})
	}
	if (STORED_SIZE_TYPES.has(shape.type)) return declared({ x: 0, y: 0, w: Math.max(1, num(p.w, 1)), h: Math.max(1, num(p.h, 1)) })
	if (shape.type === 'text' || shape.type === 'note') {
		const measured = measurements?.get(shape.id)
		let stale = false
		if (measured) {
			if (measured.fp === layoutFingerprint(shape)) return { rect: { x: 0, y: 0, w: measured.w, h: measured.h }, source: 'measured', verification: 'verified' }
			stale = true
		}
		const scale = Math.max(0.01, num(p.scale, 1))
		if (shape.type === 'note') {
			// Notes are a fixed 200 box plus whatever `growY` a browser last stored; the label may need more.
			const w = 200 * scale, h = (200 + num(p.growY)) * scale
			return { rect: { x: 0, y: 0, w, h }, source: 'declared', verification: 'verified', ...(stale ? { measurementStale: true } : {}) }
		}
		const paragraphs = richTextParagraphs(p.richText)
		const fontPx = textFontPx(p.size)
		const fixed = p.autoSize === false ? Math.max(16, Math.floor(num(p.w, 200))) : undefined
		const estimate = estimateText(paragraphs, { fontPx, font: p.font, ...(fixed === undefined ? {} : { fixedWidth: fixed }) })
		// For autoSize text the stored `w` is whatever a browser last wrote (or the API's placeholder 200), so it can only
		// raise the estimate, never lower it.
		const w = (fixed ?? Math.max(estimate.w, num(p.w))) * scale
		return { rect: { x: 0, y: 0, w, h: estimate.h * scale }, source: 'estimated', verification: 'unverified', ...(stale ? { measurementStale: true } : {}) }
	}
	if (shape.type === 'draw' || shape.type === 'highlight') {
		const scale = num(p.scale, 1)
		const points: Point[] = []
		for (const segment of Array.isArray(p.segments) ? p.segments : []) for (const point of Array.isArray((segment as { points?: unknown }).points) ? (segment as { points: Point[] }).points : []) points.push({ x: num(point.x), y: num(point.y) })
		return boxOfPoints(points, scale)
	}
	if (shape.type === 'line') {
		const scale = num(p.scale, 1)
		const raw = p.points && typeof p.points === 'object' ? Object.values(p.points as Record<string, { x?: number; y?: number }>) : []
		return boxOfPoints(raw.map((point) => ({ x: num(point.x), y: num(point.y) })), scale)
	}
	return null
}

function boxOfPoints(points: Point[], scale: number): Sized {
	if (points.length === 0) return declared({ x: 0, y: 0, w: 1, h: 1 })
	const xs = points.map((point) => point.x * scale), ys = points.map((point) => point.y * scale)
	return declared({ x: Math.min(...xs), y: Math.min(...ys), w: Math.max(1, Math.max(...xs) - Math.min(...xs)), h: Math.max(1, Math.max(...ys) - Math.min(...ys)) })
}

export function computeLayout(input: LayoutInput): PageLayout {
	const { pageId } = input
	const byRecord = new Map(input.shapes.map((shape) => [shape.id, shape]))
	const children = new Map<string, LayoutShapeRecord[]>()
	for (const shape of input.shapes) {
		const list = children.get(shape.parentId) ?? []
		list.push(shape)
		children.set(shape.parentId, list)
	}
	for (const list of children.values()) list.sort((a, b) => (a.index < b.index ? -1 : a.index > b.index ? 1 : 0))

	// Reachable from the page only, in paint order, with a depth guard against corrupt parent loops.
	const ordered: LayoutShapeRecord[] = []
	const parentMatrix = new Map<string, Matrix>([[pageId, IDENTITY]])
	const pageRotation = new Map<string, number>([[pageId, 0]])
	const walk = (parentId: string, depth: number) => {
		if (depth > 30) return
		for (const shape of children.get(parentId) ?? []) {
			if (parentMatrix.has(shape.id)) continue
			const matrix = compose(parentMatrix.get(parentId) ?? IDENTITY, local(shape))
			parentMatrix.set(shape.id, matrix)
			pageRotation.set(shape.id, (pageRotation.get(parentId) ?? 0) + shape.rotation)
			ordered.push(shape)
			walk(shape.id, depth + 1)
		}
	}
	walk(pageId, 0)

	const layouts = new Map<string, ShapeLayout>()
	const childIds = new Map<string, string[]>()
	const zOf = new Map(ordered.map((shape, position) => [shape.id, position]))
	const make = (shape: LayoutShapeRecord, sized: Sized, matrix: Matrix): ShapeLayout => ({
		id: shape.id, type: shape.type, parentId: shape.parentId, index: shape.index, zIndex: zOf.get(shape.id) ?? 0,
		rotation: pageRotation.get(shape.id) ?? 0,
		bounds: aabb(matrix, sized.rect), boundsSource: sized.source, verification: sized.verification,
		local: { w: sized.rect.w, h: sized.rect.h }, locked: Boolean((shape as { isLocked?: boolean }).isLocked),
		...(sized.labelMayOverflow ? { labelMayOverflow: true } : {}),
		...(sized.measurementStale ? { measurementStale: true } : {}),
		...(sized.unknownType ? { unknownType: true } : {}),
	})

	// Pass 1: everything that is neither an arrow nor a group.
	for (const shape of ordered) {
		if (shape.type === 'arrow' || shape.type === 'group') continue
		const matrix = parentMatrix.get(shape.id) as Matrix
		const sized = sizeOf(shape, input.measurements) ?? { rect: { x: 0, y: 0, w: 0, h: 0 }, source: 'estimated' as const, verification: 'unverified' as const, unknownType: true }
		layouts.set(shape.id, make(shape, sized, matrix))
	}

	// Pass 2: arrows, now that the shapes they bind to have bounds.
	const boundBy = new Map<string, LayoutBindingRecord[]>()
	for (const binding of input.bindings ?? []) {
		if (binding.type !== undefined && binding.type !== 'arrow') continue
		const list = boundBy.get(binding.fromId) ?? []
		list.push(binding)
		boundBy.set(binding.fromId, list)
	}
	for (const shape of ordered) {
		if (shape.type !== 'arrow') continue
		const matrix = parentMatrix.get(shape.id) as Matrix
		const p = shape.props
		const start = apply(matrix, { x: num((p.start as Point | undefined)?.x), y: num((p.start as Point | undefined)?.y) })
		const end = apply(matrix, { x: num((p.end as Point | undefined)?.x), y: num((p.end as Point | undefined)?.y) })
		let s = start, e = end
		let startBoundTo: string | undefined, endBoundTo: string | undefined
		const terminals = new Map<'start' | 'end', { binding: LayoutBindingRecord; target: ShapeLayout }>()
		for (const binding of boundBy.get(shape.id) ?? []) {
			const target = layouts.get(binding.toId)
			const terminal = binding.props.terminal
			if (target && (terminal === 'start' || terminal === 'end')) terminals.set(terminal, { binding, target })
		}
		const centre = (rect: Rect): Point => ({ x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 })
		for (const [terminal, { binding, target }] of terminals) {
			const anchor = binding.props.normalizedAnchor as Point | undefined
			const precise = binding.props.isPrecise === true && anchor
			// An unbound terminal aims at the stored point; a bound one aims at the centre of what it is bound to.
			const opposite = terminal === 'start' ? 'end' : 'start'
			const toward = terminals.get(opposite) ? centre(terminals.get(opposite)!.target.bounds) : terminal === 'start' ? end : start
			const point = precise
				? { x: target.bounds.x + num(anchor.x, 0.5) * target.bounds.w, y: target.bounds.y + num(anchor.y, 0.5) * target.bounds.h }
				: edgePoint(target.bounds, toward, target.type === 'geo' && (byRecord.get(target.id)?.props.geo === 'ellipse' || byRecord.get(target.id)?.props.geo === 'oval'))
			if (terminal === 'start') { s = point; startBoundTo = binding.toId } else { e = point; endBoundTo = binding.toId }
		}
		const bend = Math.abs(num(p.bend))
		const x = Math.min(s.x, e.x) - bend, y = Math.min(s.y, e.y) - bend
		const connection = shape.meta?.canvasApiConnection as { fromId?: unknown; toId?: unknown } | undefined
		layouts.set(shape.id, {
			id: shape.id, type: 'arrow', parentId: shape.parentId, index: shape.index, zIndex: zOf.get(shape.id) ?? 0, rotation: 0,
			bounds: { x, y, w: Math.abs(e.x - s.x) + bend * 2, h: Math.abs(e.y - s.y) + bend * 2 },
			boundsSource: 'declared', verification: 'verified', local: { w: Math.abs(e.x - s.x), h: Math.abs(e.y - s.y) }, locked: Boolean((shape as { isLocked?: boolean }).isLocked),
			arrow: {
				start: s, end: e, managed: Boolean(connection),
				...(startBoundTo ? { startBoundTo } : {}), ...(endBoundTo ? { endBoundTo } : {}),
				...(typeof connection?.fromId === 'string' && typeof connection?.toId === 'string' ? { connection: { fromId: connection.fromId, toId: connection.toId } } : {}),
			},
		})
	}

	// Pass 3: groups are the union of what they contain, innermost first.
	const groups = ordered.filter((shape) => shape.type === 'group').reverse()
	for (const group of groups) {
		const members = (children.get(group.id) ?? []).map((child) => layouts.get(child.id)).filter((item): item is ShapeLayout => Boolean(item))
		const union = rectUnion(members.map((member) => member.bounds)) ?? { x: parentMatrix.get(group.id)![4], y: parentMatrix.get(group.id)![5], w: 0, h: 0 }
		const weakest: BoundsSource = members.some((member) => member.boundsSource === 'estimated') ? 'estimated' : members.some((member) => member.boundsSource === 'declared') ? 'declared' : 'measured'
		layouts.set(group.id, {
			id: group.id, type: 'group', parentId: group.parentId, index: group.index, zIndex: zOf.get(group.id) ?? 0, rotation: pageRotation.get(group.id) ?? 0,
			bounds: union, boundsSource: members.length === 0 ? 'estimated' : weakest, verification: members.every((member) => member.verification === 'verified') && members.length > 0 ? 'verified' : 'unverified',
			local: { w: union.w, h: union.h }, locked: Boolean((group as { isLocked?: boolean }).isLocked),
		})
	}

	for (const shape of ordered) {
		const list = childIds.get(shape.parentId) ?? []
		list.push(shape.id)
		childIds.set(shape.parentId, list)
	}
	const shapes = ordered.map((shape) => layouts.get(shape.id)).filter((item): item is ShapeLayout => Boolean(item))
	return {
		pageId, shapes, byId: new Map(shapes.map((shape) => [shape.id, shape])), childrenOf: childIds,
		extent: rectUnion(shapes.filter((shape) => shape.type !== 'arrow' && shape.parentId === pageId).map((shape) => shape.bounds)),
	}
}

/** Every shape under `id`, however deeply nested (not including `id`). */
export function descendantsOf(layout: PageLayout, id: string): Set<string> {
	const out = new Set<string>()
	const visit = (parent: string, depth: number) => {
		if (depth > 30) return
		for (const child of layout.childrenOf.get(parent) ?? []) { out.add(child); visit(child, depth + 1) }
	}
	visit(id, 0)
	return out
}

/** The shape and every ancestor id up to (not including) the page, for "is this inside that" checks. */
export function ancestorsOf(layout: PageLayout, id: string): Set<string> {
	const out = new Set<string>()
	let current = layout.byId.get(id)
	for (let depth = 0; current && depth < 30; depth += 1) {
		if (current.parentId === layout.pageId) break
		out.add(current.parentId)
		current = layout.byId.get(current.parentId)
	}
	return out
}
