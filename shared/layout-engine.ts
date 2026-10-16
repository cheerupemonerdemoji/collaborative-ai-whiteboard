import {
	ancestorsOf,
	descendantsOf,
	overlapArea,
	rectBottom,
	rectRight,
	rectUnion,
	rectsCloserThan,
	type PageLayout,
	type ShapeLayout,
} from './layout-geometry'
import { ALIGNMENT_TOLERANCE, LAYOUT_GAP, SPACING_TOLERANCE, type Rect } from './layout'

/**
 * Deterministic placement and verification over a `PageLayout`. Every function is pure: it returns what to move
 * (page-space deltas) or a report, and never touches a store. Callers apply the moves and recompute the layout, which is
 * how a layout action is verified against what was actually written, not against what was intended.
 */

/** A page-space translation of a shape (and so of its whole rotated box). */
export interface Move {
	id: string
	dx: number
	dy: number
}

export interface Blocker {
	id: string
	rect: Rect
}

/**
 * What a new or moved shape must avoid: every non-arrow, non-group shape except `exclude` (the moving shapes, their
 * descendants, and their ancestors, which legitimately contain them). Bound arrows are deliberately not blockers: they
 * follow their boxes and are checked separately.
 */
export function blockersFor(layout: PageLayout, moving: Iterable<string>): Blocker[] {
	const skip = new Set<string>()
	for (const id of moving) {
		skip.add(id)
		for (const inner of descendantsOf(layout, id)) skip.add(inner)
		for (const outer of ancestorsOf(layout, id)) skip.add(outer)
	}
	return layout.shapes.filter((shape) => shape.type !== 'arrow' && shape.type !== 'group' && !skip.has(shape.id)).map((shape) => ({ id: shape.id, rect: shape.bounds }))
}

/**
 * Starting at (x, y), moves a box of the given size forward along one axis until it is clear of every blocker by at
 * least `gap`. Always moves strictly forward past the blockers it hits, so it terminates, and the first free spot is the
 * nearest one in that direction.
 */
export function slideClear(blockers: readonly Blocker[], size: { w: number; h: number }, start: { x: number; y: number }, axis: 'x' | 'y', gap: number): { x: number; y: number; moved: boolean } {
	let x = start.x, y = start.y
	for (let iteration = 0; iteration < 500; iteration += 1) {
		const here = { x, y, w: size.w, h: size.h }
		const hits = blockers.filter((blocker) => rectsCloserThan(here, blocker.rect, gap))
		if (hits.length === 0) return { x, y, moved: x !== start.x || y !== start.y }
		if (axis === 'y') y = Math.max(...hits.map((hit) => rectBottom(hit.rect))) + gap
		else x = Math.max(...hits.map((hit) => rectRight(hit.rect))) + gap
	}
	return { x, y, moved: true }
}

export interface FreeRegion {
	x: number
	y: number
	w: number
	h: number
	/** How far it is from where it was first wanted. */
	travel: number
	direction: 'below' | 'right'
}

/**
 * The nearest clear region of the given size from `anchor`, searching below it, to its right, or the nearer of the two.
 * Without an anchor it is placed below everything on the page, which is clear by construction.
 */
export function findFreeRegion(layout: PageLayout, size: { w: number; h: number }, options: { anchor?: { x: number; y: number }; direction?: 'below' | 'right' | 'any'; gap?: number; moving?: Iterable<string> } = {}): FreeRegion {
	const gap = options.gap ?? LAYOUT_GAP
	const blockers = blockersFor(layout, options.moving ?? [])
	const extent = layout.extent
	const anchor = options.anchor ?? (extent ? { x: extent.x, y: rectBottom(extent) + gap } : { x: 0, y: 0 })
	const direction = options.direction ?? 'any'
	const below = slideClear(blockers, size, anchor, 'y', gap)
	const right = slideClear(blockers, size, anchor, 'x', gap)
	const belowTravel = Math.hypot(below.x - anchor.x, below.y - anchor.y)
	const rightTravel = Math.hypot(right.x - anchor.x, right.y - anchor.y)
	const useBelow = direction === 'below' || (direction === 'any' && belowTravel <= rightTravel)
	const chosen = useBelow ? below : right
	return { x: chosen.x, y: chosen.y, w: size.w, h: size.h, travel: useBelow ? belowTravel : rightTravel, direction: useBelow ? 'below' : 'right' }
}

function boundsOf(layout: PageLayout, id: string): ShapeLayout {
	const shape = layout.byId.get(id)
	if (!shape) throw new LayoutError(`Unknown object on this page: ${id}`, 404)
	return shape
}

export class LayoutError extends Error {
	constructor(message: string, readonly statusCode = 422) { super(message) }
}

function move(shape: ShapeLayout, x: number, y: number): Move {
	return { id: shape.id, dx: x - shape.bounds.x, dy: y - shape.bounds.y }
}

type Align3 = 'start' | 'center' | 'end'
const offset = (container: number, item: number, align: Align3) => (align === 'start' ? 0 : align === 'center' ? (container - item) / 2 : container - item)

/** Places `id` below `targetId`, aligned on the horizontal axis, sliding down past anything in the way. */
export function placeBelow(layout: PageLayout, input: { id: string; targetId: string; gap?: number; align?: Align3 }): Move[] {
	const gap = input.gap ?? LAYOUT_GAP
	const shape = boundsOf(layout, input.id), target = boundsOf(layout, input.targetId)
	if (shape.id === target.id) throw new LayoutError('A shape cannot be placed relative to itself')
	const wantedX = target.bounds.x + offset(target.bounds.w, shape.bounds.w, input.align ?? 'start')
	const cleared = slideClear(blockersFor(layout, [shape.id]), shape.bounds, { x: wantedX, y: rectBottom(target.bounds) + gap }, 'y', gap)
	return [move(shape, cleared.x, cleared.y)]
}

/** Places `id` to the right of `targetId`, aligned on the vertical axis, sliding right past anything in the way. */
export function placeRightOf(layout: PageLayout, input: { id: string; targetId: string; gap?: number; align?: Align3 }): Move[] {
	const gap = input.gap ?? LAYOUT_GAP
	const shape = boundsOf(layout, input.id), target = boundsOf(layout, input.targetId)
	if (shape.id === target.id) throw new LayoutError('A shape cannot be placed relative to itself')
	const wantedY = target.bounds.y + offset(target.bounds.h, shape.bounds.h, input.align ?? 'start')
	const cleared = slideClear(blockersFor(layout, [shape.id]), shape.bounds, { x: rectRight(target.bounds) + gap, y: wantedY }, 'x', gap)
	return [move(shape, cleared.x, cleared.y)]
}

export type AlignAxis = 'left' | 'center-x' | 'right' | 'top' | 'center-y' | 'bottom'

/** Aligns the shapes' edges or centres to the selection's, like tldraw's align. */
export function alignMoves(layout: PageLayout, ids: readonly string[], axis: AlignAxis): Move[] {
	const shapes = unique(ids).map((id) => boundsOf(layout, id))
	const selection = rectUnion(shapes.map((shape) => shape.bounds)) as Rect
	return shapes.map((shape) => {
		const b = shape.bounds
		switch (axis) {
			case 'left': return { id: shape.id, dx: selection.x - b.x, dy: 0 }
			case 'right': return { id: shape.id, dx: rectRight(selection) - rectRight(b), dy: 0 }
			case 'center-x': return { id: shape.id, dx: selection.x + selection.w / 2 - (b.x + b.w / 2), dy: 0 }
			case 'top': return { id: shape.id, dx: 0, dy: selection.y - b.y }
			case 'bottom': return { id: shape.id, dx: 0, dy: rectBottom(selection) - rectBottom(b) }
			default: return { id: shape.id, dx: 0, dy: selection.y + selection.h / 2 - (b.y + b.h / 2) }
		}
	})
}

/**
 * Spreads shapes along one axis. With `gap`, the first shape stays and every later one follows at exactly that gap; without
 * it the gaps are made equal between the two outermost shapes, like tldraw's distribute.
 */
export function distributeMoves(layout: PageLayout, ids: readonly string[], direction: 'horizontal' | 'vertical', gap?: number): Move[] {
	const horizontal = direction === 'horizontal'
	const shapes = unique(ids).map((id) => boundsOf(layout, id)).sort((a, b) => (horizontal ? a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y : a.bounds.y - b.bounds.y || a.bounds.x - b.bounds.x) || (a.id < b.id ? -1 : 1))
	const size = (shape: ShapeLayout) => (horizontal ? shape.bounds.w : shape.bounds.h)
	const first = shapes[0], last = shapes[shapes.length - 1]
	const start = horizontal ? first.bounds.x : first.bounds.y
	const even = gap ?? ((horizontal ? rectRight(last.bounds) : rectBottom(last.bounds)) - start - shapes.reduce((total, shape) => total + size(shape), 0)) / (shapes.length - 1)
	let cursor = start
	return shapes.map((shape) => {
		const delta = cursor - (horizontal ? shape.bounds.x : shape.bounds.y)
		cursor += size(shape) + even
		return horizontal ? { id: shape.id, dx: delta, dy: 0 } : { id: shape.id, dx: 0, dy: delta }
	})
}

interface BlockOptions { gap?: number; x?: number; y?: number; avoidCollisions?: boolean }

/** After arranging a block, slides the WHOLE block down past anything it would land on, so its internal spacing is kept. */
function clearBlock(layout: PageLayout, moves: Move[], options: BlockOptions, gap: number): Move[] {
	if (options.avoidCollisions === false) return moves
	const rects = moves.map((m) => { const b = boundsOf(layout, m.id).bounds; return { x: b.x + m.dx, y: b.y + m.dy, w: b.w, h: b.h } })
	const block = rectUnion(rects) as Rect
	const cleared = slideClear(blockersFor(layout, moves.map((m) => m.id)), block, { x: block.x, y: block.y }, 'y', gap)
	const dx = cleared.x - block.x, dy = cleared.y - block.y
	return dx || dy ? moves.map((m) => ({ ...m, dx: m.dx + dx, dy: m.dy + dy })) : moves
}

function origin(layout: PageLayout, ids: readonly string[], options: BlockOptions) {
	const union = rectUnion(ids.map((id) => boundsOf(layout, id).bounds)) as Rect
	return { x: options.x ?? union.x, y: options.y ?? union.y }
}

/** A horizontal row in the given order, top/centre/bottom aligned, at a uniform gap. */
export function rowMoves(layout: PageLayout, ids: readonly string[], options: BlockOptions & { align?: 'top' | 'center' | 'bottom' } = {}): Move[] {
	const gap = options.gap ?? LAYOUT_GAP
	const shapes = unique(ids).map((id) => boundsOf(layout, id))
	const start = origin(layout, ids, options)
	const rowHeight = Math.max(...shapes.map((shape) => shape.bounds.h))
	const align: Align3 = options.align === 'bottom' ? 'end' : options.align === 'center' ? 'center' : 'start'
	let cursor = start.x
	const moves = shapes.map((shape) => {
		const result = move(shape, cursor, start.y + offset(rowHeight, shape.bounds.h, align))
		cursor += shape.bounds.w + gap
		return result
	})
	return clearBlock(layout, moves, options, gap)
}

/** A vertical stack in the given order, left/centre/right aligned, at a uniform gap. */
export function stackMoves(layout: PageLayout, ids: readonly string[], options: BlockOptions & { align?: 'left' | 'center' | 'right' } = {}): Move[] {
	const gap = options.gap ?? LAYOUT_GAP
	const shapes = unique(ids).map((id) => boundsOf(layout, id))
	const start = origin(layout, ids, options)
	const stackWidth = Math.max(...shapes.map((shape) => shape.bounds.w))
	const align: Align3 = options.align === 'right' ? 'end' : options.align === 'center' ? 'center' : 'start'
	let cursor = start.y
	const moves = shapes.map((shape) => {
		const result = move(shape, start.x + offset(stackWidth, shape.bounds.w, align), cursor)
		cursor += shape.bounds.h + gap
		return result
	})
	return clearBlock(layout, moves, options, gap)
}

/** Row-major grid whose columns are as wide, and rows as tall, as their largest member, so cells never overlap. */
export function gridMoves(layout: PageLayout, ids: readonly string[], columns: number, options: BlockOptions & { columnGap?: number; rowGap?: number } = {}): Move[] {
	const shapes = unique(ids).map((id) => boundsOf(layout, id))
	const gap = options.gap ?? LAYOUT_GAP
	const columnGap = options.columnGap ?? gap, rowGap = options.rowGap ?? gap
	const start = origin(layout, ids, options)
	const rows = Math.ceil(shapes.length / columns)
	const widths = Array.from({ length: columns }, () => 0)
	const heights = Array.from({ length: rows }, () => 0)
	shapes.forEach((shape, index) => {
		widths[index % columns] = Math.max(widths[index % columns], shape.bounds.w)
		heights[Math.floor(index / columns)] = Math.max(heights[Math.floor(index / columns)], shape.bounds.h)
	})
	const columnX = widths.map((_, column) => start.x + widths.slice(0, column).reduce((total, width) => total + width + columnGap, 0))
	const rowY = heights.map((_, row) => start.y + heights.slice(0, row).reduce((total, height) => total + height + rowGap, 0))
	const moves = shapes.map((shape, index) => move(shape, columnX[index % columns], rowY[Math.floor(index / columns)]))
	return clearBlock(layout, moves, options, Math.max(columnGap, rowGap))
}

function unique(ids: readonly string[]): string[] {
	return [...new Set(ids)]
}

/* ----------------------------------------------------------------------- verification -- */

export type VerificationStatus = 'verified' | 'partially_unverified' | 'overlaps'

export interface VerifiedItem {
	id: string
	type: string
	bounds: Rect
	boundsSource: ShapeLayout['boundsSource']
	verification: ShapeLayout['verification']
}

export interface LayoutVerification {
	status: VerificationStatus
	items: VerifiedItem[]
	/** Touched shapes that intersect something they should not (bound arrows and containers excepted). */
	overlaps: Array<{ a: string; b: string; area: number }>
	/** Shapes that do not intersect but are closer than the requested spacing. */
	tooClose: Array<{ a: string; b: string; gap: number }>
	spacing: { requested: number | null; minimum: number | null; ok: boolean }
	alignment: { axis: string | null; maxDeviation: number | null; ok: boolean }
	/** Items whose bounds rest on an estimate or a stale/possibly-overflowing size, so "no overlap" cannot be certain. */
	unverified: Array<{ id: string; reason: 'estimated' | 'label-may-overflow' | 'measurement-stale' }>
}

export interface VerifyExpectation {
	/** Pairs expected to sit `requested` apart (consecutive row members, a placed shape and its target, ...). */
	pairs?: Array<[string, string]>
	requestedGap?: number
	alignAxis?: AlignAxis | 'top' | 'center-y' | 'bottom' | 'left' | 'center-x' | 'right'
	alignIds?: readonly string[]
}

/** The empty space between two rectangles along the axis they are separated on (0 when they overlap). */
export function gapBetween(a: Rect, b: Rect): number {
	const dx = Math.max(a.x - rectRight(b), b.x - rectRight(a), 0)
	const dy = Math.max(a.y - rectBottom(b), b.y - rectBottom(a), 0)
	return Math.max(dx, dy)
}

function reasonFor(shape: ShapeLayout): 'estimated' | 'label-may-overflow' | 'measurement-stale' | null {
	if (shape.labelMayOverflow) return 'label-may-overflow'
	if (shape.measurementStale) return 'measurement-stale'
	if (shape.boundsSource === 'estimated' || shape.verification === 'unverified') return 'estimated'
	return null
}

/**
 * Checks what was ACTUALLY written (the layout recomputed after the moves): does anything touched intersect something it
 * should not, is it as far apart as asked, is it as aligned as asked. If any touched item (or a neighbour the placement
 * relied on) has estimated bounds, the status is `partially_unverified` rather than a false "no overlaps".
 */
export function verifyLayout(layout: PageLayout, touched: readonly string[], expectation: VerifyExpectation = {}): LayoutVerification {
	const ids = unique(touched).filter((id) => layout.byId.has(id))
	const touchedSet = new Set(ids)
	const items = ids.map((id) => layout.byId.get(id) as ShapeLayout)
	const overlaps: LayoutVerification['overlaps'] = []
	const tooClose: LayoutVerification['tooClose'] = []
	const requested = expectation.requestedGap ?? null
	const unverified: LayoutVerification['unverified'] = []
	const relevant = new Set<string>()
	const reported = new Set<string>()
	for (const item of items) {
		if (item.type === 'arrow' || item.type === 'group') continue
		const skip = new Set<string>([item.id, ...descendantsOf(layout, item.id), ...ancestorsOf(layout, item.id)])
		for (const other of layout.shapes) {
			if (other.type === 'arrow' || other.type === 'group' || skip.has(other.id)) continue
			const key = item.id < other.id ? `${item.id}|${other.id}` : `${other.id}|${item.id}`
			if (reported.has(key)) continue
			const area = overlapArea(item.bounds, other.bounds)
			if (area > 1) { reported.add(key); overlaps.push({ a: item.id, b: other.id, area: Math.round(area) }); relevant.add(other.id); continue }
			const gap = gapBetween(item.bounds, other.bounds)
			if (gap < LAYOUT_GAP * 2) relevant.add(other.id)
			if (requested !== null && gap < requested - SPACING_TOLERANCE && touchedSet.has(other.id)) { reported.add(key); tooClose.push({ a: item.id, b: other.id, gap: Math.round(gap * 10) / 10 }) }
		}
	}
	for (const id of [...ids, ...relevant]) {
		const shape = layout.byId.get(id)
		const reason = shape ? reasonFor(shape) : null
		if (shape && reason && shape.type !== 'arrow' && !unverified.some((entry) => entry.id === id)) unverified.push({ id, reason })
	}
	let minimum: number | null = null
	for (const [a, b] of expectation.pairs ?? []) {
		const ra = layout.byId.get(a), rb = layout.byId.get(b)
		if (ra && rb) minimum = Math.min(minimum ?? Infinity, gapBetween(ra.bounds, rb.bounds))
	}
	const spacingOk = requested === null || minimum === null || minimum >= requested - SPACING_TOLERANCE
	let deviation: number | null = null
	if (expectation.alignAxis && expectation.alignIds && expectation.alignIds.length > 1) {
		const values = expectation.alignIds.map((id) => layout.byId.get(id)).filter((shape): shape is ShapeLayout => Boolean(shape)).map((shape) => {
			const b = shape.bounds
			switch (expectation.alignAxis) {
				case 'left': return b.x
				case 'right': return rectRight(b)
				case 'center-x': return b.x + b.w / 2
				case 'top': return b.y
				case 'bottom': return rectBottom(b)
				default: return b.y + b.h / 2
			}
		})
		deviation = Math.round((Math.max(...values) - Math.min(...values)) * 100) / 100
	}
	const alignmentOk = deviation === null || deviation <= ALIGNMENT_TOLERANCE
	const status: VerificationStatus = overlaps.length > 0 ? 'overlaps' : unverified.length > 0 ? 'partially_unverified' : 'verified'
	return {
		status,
		items: items.map((item) => ({ id: item.id, type: item.type, bounds: roundRect(item.bounds), boundsSource: item.boundsSource, verification: item.verification })),
		overlaps, tooClose,
		spacing: { requested, minimum: minimum === null ? null : Math.round(minimum * 10) / 10, ok: spacingOk && tooClose.length === 0 },
		alignment: { axis: expectation.alignAxis ?? null, maxDeviation: deviation, ok: alignmentOk },
		unverified,
	}
}

export function roundRect(rect: Rect): Rect {
	const r = (value: number) => Math.round(value * 100) / 100
	return { x: r(rect.x), y: r(rect.y), w: r(rect.w), h: r(rect.h) }
}
