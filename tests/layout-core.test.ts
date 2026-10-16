/**
 * The pure layout core (shared/layout*.ts): page-space geometry, geometry authority, the text estimator, deterministic
 * placement, and post-write verification. No server, no tldraw runtime: this is the engine a future human "Tidy"
 * command would call too.
 */

import { describe, expect, it } from 'vitest'
import { ALIGNMENT_TOLERANCE, LAYOUT_GAP, estimateText, layoutFingerprint, richTextParagraphs, textFontPx } from '../shared/layout'
import { computeLayout, descendantsOf, edgePoint, overlapArea, type LayoutBindingRecord, type LayoutShapeRecord } from '../shared/layout-geometry'
import { LayoutError, alignMoves, distributeMoves, findFreeRegion, gapBetween, gridMoves, placeBelow, placeRightOf, rowMoves, slideClear, stackMoves, verifyLayout, type Move } from '../shared/layout-engine'

const PAGE = 'page:one'
let counter = 0
const rich = (...lines: string[]) => ({ type: 'doc', content: lines.map((text) => (text ? { type: 'paragraph', content: [{ type: 'text', text }] } : { type: 'paragraph' })) })

function box(id: string, x: number, y: number, w: number, h: number, extra: Partial<LayoutShapeRecord> & { label?: string; props?: Record<string, unknown> } = {}): LayoutShapeRecord {
	counter += 1
	const { label, props, ...rest } = extra
	return { id: `shape:${id}`, type: 'geo', x, y, rotation: 0, index: `a${String(counter).padStart(4, '0')}`, parentId: PAGE, props: { geo: 'rectangle', w, h, growY: 0, richText: rich(label ?? 'x'), size: 'm', font: 'draw', ...props }, ...rest }
}

function text(id: string, x: number, y: number, props: Record<string, unknown> = {}, extra: Partial<LayoutShapeRecord> = {}): LayoutShapeRecord {
	counter += 1
	return { id: `shape:${id}`, type: 'text', x, y, rotation: 0, index: `a${String(counter).padStart(4, '0')}`, parentId: PAGE, props: { richText: rich('hello'), size: 'm', font: 'draw', scale: 1, autoSize: true, w: 200, ...props }, ...extra }
}

function arrow(id: string, x: number, y: number, ex: number, ey: number, extra: Partial<LayoutShapeRecord> = {}): LayoutShapeRecord {
	counter += 1
	return { id: `shape:${id}`, type: 'arrow', x, y, rotation: 0, index: `a${String(counter).padStart(4, '0')}`, parentId: PAGE, props: { start: { x: 0, y: 0 }, end: { x: ex - x, y: ey - y }, bend: 0 }, ...extra }
}

const layoutOf = (shapes: LayoutShapeRecord[], bindings: LayoutBindingRecord[] = [], measurements?: Map<string, { id: string; w: number; h: number; fp: string }>) => computeLayout({ pageId: PAGE, shapes, bindings, measurements })
const sid = (name: string) => `shape:${name}`
const apply = (shapes: LayoutShapeRecord[], moves: Move[]) => shapes.map((shape) => { const m = moves.find((candidate) => candidate.id === shape.id); return m ? { ...shape, x: shape.x + m.dx, y: shape.y + m.dy } : shape })

describe('page-space geometry', () => {
	it('uses the stored size of a geo shape, including the height a browser grew it by', () => {
		const layout = layoutOf([box('a', 100, 50, 300, 120, { props: { growY: 30 } })])
		const a = layout.byId.get(sid('a'))!
		expect(a.bounds).toEqual({ x: 100, y: 50, w: 300, h: 150 })
		expect(a.boundsSource).toBe('declared')
		expect(a.verification).toBe('verified')
	})

	it('resolves a shape nested in a frame to page space', () => {
		const frame: LayoutShapeRecord = { id: sid('f'), type: 'frame', x: 100, y: 200, rotation: 0, index: 'a1', parentId: PAGE, props: { w: 500, h: 400 } }
		const child = box('child', 10, 20, 40, 30, { parentId: sid('f') })
		const layout = layoutOf([frame, child])
		expect(layout.byId.get(sid('child'))!.bounds).toEqual({ x: 110, y: 220, w: 40, h: 30 })
		expect(layout.byId.get(sid('child'))!.parentId).toBe(sid('f'))
		expect(descendantsOf(layout, sid('f'))).toEqual(new Set([sid('child')]))
	})

	it('applies a rotated parent: the child\'s page bounds are the box of the rotated rectangle', () => {
		const frame: LayoutShapeRecord = { id: sid('f'), type: 'frame', x: 100, y: 100, rotation: Math.PI / 2, index: 'a1', parentId: PAGE, props: { w: 500, h: 400 } }
		const child = box('child', 10, 0, 40, 20, { parentId: sid('f') })
		const b = layoutOf([frame, child]).byId.get(sid('child'))!
		expect(b.bounds.x).toBeCloseTo(80); expect(b.bounds.y).toBeCloseTo(110); expect(b.bounds.w).toBeCloseTo(20); expect(b.bounds.h).toBeCloseTo(40)
		expect(b.rotation).toBeCloseTo(Math.PI / 2)
	})

	it('boxes a rotated shape\'s four corners', () => {
		const b = layoutOf([box('r', 0, 0, 100, 50, { rotation: Math.PI / 2 })]).byId.get(sid('r'))!
		expect(b.bounds.x).toBeCloseTo(-50); expect(b.bounds.y).toBeCloseTo(0); expect(b.bounds.w).toBeCloseTo(50); expect(b.bounds.h).toBeCloseTo(100)
	})

	it('treats a group as the union of its children', () => {
		const group: LayoutShapeRecord = { id: sid('g'), type: 'group', x: 0, y: 0, rotation: 0, index: 'a1', parentId: PAGE, props: {} }
		const layout = layoutOf([group, box('a', 10, 10, 100, 50, { parentId: sid('g') }), box('b', 300, 200, 80, 40, { parentId: sid('g') })])
		expect(layout.byId.get(sid('g'))!.bounds).toEqual({ x: 10, y: 10, w: 370, h: 230 })
		expect(layout.extent).toEqual({ x: 10, y: 10, w: 370, h: 230 })
	})

	it('reports paint order from the fractional index, including nested shapes after their parent', () => {
		const back = box('back', 0, 0, 10, 10, { index: 'a1' }), front = box('front', 0, 0, 10, 10, { index: 'a3' })
		const frame: LayoutShapeRecord = { id: sid('f'), type: 'frame', x: 0, y: 0, rotation: 0, index: 'a2', parentId: PAGE, props: { w: 100, h: 100 } }
		const inner = box('inner', 5, 5, 10, 10, { parentId: sid('f'), index: 'a1' })
		expect(layoutOf([front, inner, frame, back]).shapes.map((shape) => shape.id)).toEqual([sid('back'), sid('f'), sid('inner'), sid('front')])
	})

	it('ignores shapes that are not reachable from the page', () => {
		const stray = box('stray', 0, 0, 10, 10, { parentId: 'page:other' })
		const orphan = box('orphan', 0, 0, 10, 10, { parentId: sid('missing') })
		expect(layoutOf([box('a', 0, 0, 10, 10), stray, orphan]).shapes.map((shape) => shape.id)).toEqual([sid('a')])
	})

	it('survives a corrupt parent loop', () => {
		const a = box('a', 0, 0, 10, 10, { parentId: sid('b') }), b = box('b', 0, 0, 10, 10, { parentId: sid('a') })
		expect(layoutOf([a, b, box('ok', 0, 0, 10, 10)]).shapes.map((shape) => shape.id)).toEqual([sid('ok')])
	})

	it('bounds draw and line shapes from their points, scaled', () => {
		const draw: LayoutShapeRecord = { id: sid('d'), type: 'draw', x: 50, y: 60, rotation: 0, index: 'a1', parentId: PAGE, props: { scale: 2, segments: [{ points: [{ x: 0, y: 0 }, { x: 10, y: 5 }] }, { points: [{ x: -5, y: 20 }] }] } }
		const line: LayoutShapeRecord = { id: sid('l'), type: 'line', x: 0, y: 0, rotation: 0, index: 'a2', parentId: PAGE, props: { scale: 1, points: { a: { x: 0, y: 0 }, b: { x: 100, y: 40 } } } }
		const layout = layoutOf([draw, line])
		expect(layout.byId.get(sid('d'))!.bounds).toEqual({ x: 40, y: 60, w: 30, h: 40 })
		expect(layout.byId.get(sid('l'))!.bounds).toEqual({ x: 0, y: 0, w: 100, h: 40 })
	})

	it('does not pretend to know a type it does not know', () => {
		const odd: LayoutShapeRecord = { id: sid('odd'), type: 'mystery', x: 5, y: 6, rotation: 0, index: 'a1', parentId: PAGE, props: {} }
		const s = layoutOf([odd]).byId.get(sid('odd'))!
		expect(s.unknownType).toBe(true)
		expect(s.verification).toBe('unverified')
		expect(s.boundsSource).toBe('estimated')
	})
})

describe('geometry authority: measured > declared > estimated', () => {
	it('estimates unmeasured text conservatively and marks it unverified', () => {
		const s = layoutOf([text('t', 0, 0, { richText: rich('one', 'two', 'three') })]).byId.get(sid('t'))!
		expect(s.boundsSource).toBe('estimated')
		expect(s.verification).toBe('unverified')
		expect(s.bounds.h).toBeGreaterThanOrEqual(3 * textFontPx('m') * 1.35 - 1) // at least three lines
	})

	it('never estimates text smaller than a real browser would size the human TODO block from the audited board', () => {
		// 57 paragraphs, longest 89 characters, width stored by the browser as 1144.97 (measured at the time)
		const lines = Array.from({ length: 57 }, (_, i) => (i === 3 ? 'x'.repeat(89) : `line ${i}`))
		const s = layoutOf([text('todo', 1278, 242, { richText: rich(...lines), w: 1144.97 })]).byId.get(sid('todo'))!
		expect(s.bounds.w).toBeGreaterThanOrEqual(1144.97)
		expect(s.bounds.h).toBeGreaterThanOrEqual(57 * 32.4 - 1)
		expect(s.verification).toBe('unverified')
	})

	it('uses a browser measurement while its fingerprint still matches, and says so', () => {
		const t = text('t', 10, 20)
		const measured = new Map([[t.id, { id: t.id, w: 321, h: 77, fp: layoutFingerprint(t) }]])
		const s = layoutOf([t], [], measured).byId.get(t.id)!
		expect(s.bounds).toEqual({ x: 10, y: 20, w: 321, h: 77 })
		expect(s.boundsSource).toBe('measured')
		expect(s.verification).toBe('verified')
	})

	it('keeps a measurement when the shape only moves, and drops it when the content changes', () => {
		const t = text('t', 0, 0)
		const measured = new Map([[t.id, { id: t.id, w: 300, h: 50, fp: layoutFingerprint(t) }]])
		expect(layoutOf([{ ...t, x: 999, y: 888 }], [], measured).byId.get(t.id)!.boundsSource).toBe('measured')
		const edited = { ...t, props: { ...t.props, richText: rich('something else entirely') } }
		const s = layoutOf([edited], [], measured).byId.get(t.id)!
		expect(s.boundsSource).toBe('estimated')
		expect(s.measurementStale).toBe(true)
		expect(s.verification).toBe('unverified')
	})

	it('gives a fixed-width text shape exactly that width, with an estimated height', () => {
		const s = layoutOf([text('t', 0, 0, { autoSize: false, w: 600, richText: rich('word '.repeat(200)) })]).byId.get(sid('t'))!
		expect(s.bounds.w).toBe(600)
		expect(s.bounds.h).toBeGreaterThan(32.4 * 3)
		expect(s.boundsSource).toBe('estimated')
	})

	it('flags a geo label that probably does not fit, but not a short one', () => {
		const roomy = layoutOf([box('a', 0, 0, 420, 190, { label: 'short label' })]).byId.get(sid('a'))!
		expect(roomy.labelMayOverflow).toBeUndefined()
		expect(roomy.verification).toBe('verified')
		const cramped = layoutOf([box('b', 0, 0, 200, 60, { label: 'a very long label '.repeat(15) })]).byId.get(sid('b'))!
		expect(cramped.labelMayOverflow).toBe(true)
		expect(cramped.verification).toBe('unverified')
	})

	it('treats notes as a fixed box plus the stored growth', () => {
		const note: LayoutShapeRecord = { id: sid('n'), type: 'note', x: 0, y: 0, rotation: 0, index: 'a1', parentId: PAGE, props: { growY: 40, scale: 2, richText: rich('hi'), size: 'm', font: 'draw' } }
		expect(layoutOf([note]).byId.get(sid('n'))!.bounds).toEqual({ x: 0, y: 0, w: 400, h: 480 })
	})

	it('the fingerprint ignores position and colour but not content or size', () => {
		const t = text('t', 0, 0)
		expect(layoutFingerprint({ ...t, props: { ...t.props, color: 'red' } })).toBe(layoutFingerprint(t))
		expect(layoutFingerprint({ ...t, props: { ...t.props, size: 'l' } })).not.toBe(layoutFingerprint(t))
		expect(layoutFingerprint({ ...t, props: { ...t.props, richText: rich('changed') } })).not.toBe(layoutFingerprint(t))
		expect(layoutFingerprint(t)).toMatch(/^[0-9a-f]{16}$/)
	})

	it('estimator and rich text helpers behave', () => {
		expect(richTextParagraphs(rich('a', '', 'c'))).toEqual(['a', '', 'c'])
		expect(richTextParagraphs(undefined)).toEqual([''])
		const e = estimateText(['x'.repeat(100)], { fontPx: 24, font: 'draw', fixedWidth: 200 })
		expect(e.lines).toBeGreaterThan(5)
		expect(estimateText(['x'.repeat(100)], { fontPx: 24, font: 'draw' }).lines).toBe(1)
	})
})

describe('arrows', () => {
	const a = box('a', 0, 0, 100, 100), b = box('b', 400, 0, 100, 100)
	it('reports the endpoints of a free arrow and its API connection', () => {
		const arr = arrow('arr', 100, 50, 400, 50, { meta: { canvasApiConnection: { fromId: sid('a'), toId: sid('b') } } })
		const s = layoutOf([a, b, arr]).byId.get(sid('arr'))!
		expect(s.arrow).toMatchObject({ start: { x: 100, y: 50 }, end: { x: 400, y: 50 }, managed: true, connection: { fromId: sid('a'), toId: sid('b') } })
		expect(s.arrow!.startBoundTo).toBeUndefined()
	})

	it('reports bound terminals at the bound shapes\' edges, which follow when those shapes move', () => {
		const arr = arrow('arr', 0, 0, 10, 10)
		const bindings: LayoutBindingRecord[] = [
			{ id: 'binding:s', type: 'arrow', fromId: sid('arr'), toId: sid('a'), props: { terminal: 'start', normalizedAnchor: { x: 0.5, y: 0.5 }, isPrecise: false } },
			{ id: 'binding:e', type: 'arrow', fromId: sid('arr'), toId: sid('b'), props: { terminal: 'end', normalizedAnchor: { x: 0.5, y: 0.5 }, isPrecise: false } },
		]
		const s = layoutOf([a, b, arr], bindings).byId.get(sid('arr'))!
		expect(s.arrow).toMatchObject({ startBoundTo: sid('a'), endBoundTo: sid('b') })
		expect(s.arrow!.start.x).toBeCloseTo(100); expect(s.arrow!.end.x).toBeCloseTo(400)
		const moved = layoutOf([a, { ...b, y: 300 }, arr], bindings).byId.get(sid('arr'))!
		expect(moved.arrow!.end.y).toBeGreaterThan(s.arrow!.end.y) // the terminal followed the moved box
	})

	it('edgePoint leaves a rectangle toward the target and an ellipse along its curve', () => {
		expect(edgePoint({ x: 0, y: 0, w: 100, h: 100 }, { x: 500, y: 50 })).toEqual({ x: 100, y: 50 })
		const e = edgePoint({ x: 0, y: 0, w: 100, h: 100 }, { x: 500, y: 50 }, true)
		expect(e.x).toBeCloseTo(100); expect(e.y).toBeCloseTo(50)
	})
})

describe('free space and placement', () => {
	it('slides a box clear of what it lands on, by at least the gap', () => {
		const blockers = [{ id: 'x', rect: { x: 0, y: 0, w: 100, h: 100 } }]
		expect(slideClear(blockers, { w: 50, h: 50 }, { x: 10, y: 10 }, 'y', 64)).toEqual({ x: 10, y: 164, moved: true })
		expect(slideClear(blockers, { w: 50, h: 50 }, { x: 10, y: 400 }, 'y', 64).moved).toBe(false)
	})

	it('does not move for an unrelated distant shape', () => {
		const layout = layoutOf([box('far', 5000, 5000, 100, 100), box('a', 0, 0, 100, 100), box('mover', 500, 500, 100, 100)])
		const moves = placeBelow(layout, { id: sid('mover'), targetId: sid('a') })
		expect(moves[0]).toEqual({ id: sid('mover'), dx: -500, dy: 100 + LAYOUT_GAP - 500 })
	})

	it('places below the target at the shared gap, aligned to its left edge by default and to its centre on request', () => {
		const layout = layoutOf([box('a', 100, 100, 300, 100), box('b', 0, 1000, 100, 50)])
		const start = apply(layout.shapes.map((s) => ({ id: s.id, type: 'geo', x: s.bounds.x, y: s.bounds.y, rotation: 0, index: s.index, parentId: PAGE, props: { w: s.bounds.w, h: s.bounds.h, growY: 0, richText: rich('x') } })), placeBelow(layout, { id: sid('b'), targetId: sid('a') }))
		expect(layoutOf(start).byId.get(sid('b'))!.bounds).toMatchObject({ x: 100, y: 100 + 100 + LAYOUT_GAP })
		const centred = placeBelow(layout, { id: sid('b'), targetId: sid('a'), align: 'center' })[0]
		expect(centred.dx + 0).toBe(100 + (300 - 100) / 2)
	})

	it('slides further down when something already sits below the target (the audited "TODO under the diagram" case)', () => {
		const layout = layoutOf([box('arch', 0, 0, 2000, 200), box('notes', 0, 264, 2000, 600), box('todo', 0, 5000, 400, 300)])
		const [m] = placeBelow(layout, { id: sid('todo'), targetId: sid('arch') })
		expect(m.dy + 5000).toBe(864 + LAYOUT_GAP) // below the notes block, not on top of it
	})

	it('places to the right of a target, skipping what is in the way', () => {
		const layout = layoutOf([box('a', 0, 0, 100, 100), box('wall', 164, -50, 100, 300), box('mover', 900, 900, 80, 80)])
		const [m] = placeRightOf(layout, { id: sid('mover'), targetId: sid('a') })
		expect(m.dx + 900).toBe(264 + LAYOUT_GAP)
		expect(m.dy + 900).toBe(0)
	})

	it('refuses to place a shape relative to itself and names an unknown id', () => {
		const layout = layoutOf([box('a', 0, 0, 10, 10)])
		expect(() => placeBelow(layout, { id: sid('a'), targetId: sid('a') })).toThrow(LayoutError)
		expect(() => placeBelow(layout, { id: sid('a'), targetId: sid('nope') })).toThrow(/Unknown object/)
	})

	it('finds free space below everything when nothing is asked, and nearest to an anchor otherwise', () => {
		const layout = layoutOf([box('a', 0, 0, 1000, 500)])
		const r = findFreeRegion(layout, { w: 200, h: 100 })
		expect(r).toMatchObject({ x: 0, y: 500 + LAYOUT_GAP, direction: 'below' })
		const near = findFreeRegion(layout, { w: 200, h: 100 }, { anchor: { x: 900, y: 100 }, direction: 'right' })
		expect(near.x).toBe(1000 + LAYOUT_GAP)
		expect(findFreeRegion(layout, { w: 10, h: 10 }, { anchor: { x: 2000, y: 2000 } }).travel).toBe(0)
	})
})

describe('alignment and distribution', () => {
	const shapes = [box('a', 100, 50, 100, 80), box('b', 300, 70, 150, 40), box('c', 520, 20, 60, 120)]
	const layout = layoutOf(shapes)
	const after = (moves: Move[]) => layoutOf(apply(shapes, moves))

	it('aligns edges and centres to the selection', () => {
		const top = after(alignMoves(layout, shapes.map((s) => s.id), 'top'))
		expect(new Set(shapes.map((s) => top.byId.get(s.id)!.bounds.y))).toEqual(new Set([20]))
		const mid = after(alignMoves(layout, shapes.map((s) => s.id), 'center-y'))
		const centres = shapes.map((s) => { const b = mid.byId.get(s.id)!.bounds; return b.y + b.h / 2 })
		expect(Math.max(...centres) - Math.min(...centres)).toBeLessThanOrEqual(ALIGNMENT_TOLERANCE)
		const left = after(alignMoves(layout, shapes.map((s) => s.id), 'left'))
		expect(new Set(shapes.map((s) => left.byId.get(s.id)!.bounds.x))).toEqual(new Set([100]))
	})

	it('distributes with equal gaps between the outermost shapes, and with a fixed gap', () => {
		const even = after(distributeMoves(layout, shapes.map((s) => s.id), 'horizontal'))
		const [a, b, c] = shapes.map((s) => even.byId.get(s.id)!.bounds)
		expect(a.x).toBe(100)
		expect(c.x + c.w).toBe(580)
		expect(gapBetween(a, b)).toBeCloseTo(gapBetween(b, c))
		const fixed = after(distributeMoves(layout, shapes.map((s) => s.id), 'horizontal', 40))
		const [fa, fb, fc] = shapes.map((s) => fixed.byId.get(s.id)!.bounds)
		expect(gapBetween(fa, fb)).toBe(40); expect(gapBetween(fb, fc)).toBe(40)
		const vertical = after(distributeMoves(layout, shapes.map((s) => s.id), 'vertical', 10))
		const ordered = shapes.map((s) => vertical.byId.get(s.id)!.bounds).sort((p, q) => p.y - q.y)
		expect(ordered[1].y - (ordered[0].y + ordered[0].h)).toBe(10)
		expect(ordered[2].y - (ordered[1].y + ordered[1].h)).toBe(10)
	})
})

describe('rows, stacks and grids', () => {
	const boxes = ['a', 'b', 'c', 'd', 'e'].map((name, i) => box(name, 900 - i * 50, 400 + i * 30, 300, 100 + (i % 2) * 60))
	const ids = boxes.map((b) => b.id)

	it('lays out a top-aligned row at a uniform gap, in the order given', () => {
		const layout = layoutOf(boxes)
		const next = layoutOf(apply(boxes, rowMoves(layout, ids)))
		const bounds = ids.map((id) => next.byId.get(id)!.bounds)
		expect(new Set(bounds.map((b) => b.y)).size).toBe(1)
		for (let i = 1; i < bounds.length; i += 1) expect(gapBetween(bounds[i - 1], bounds[i])).toBeCloseTo(LAYOUT_GAP)
		expect(bounds.map((b) => b.x)).toEqual([...bounds.map((b) => b.x)].sort((p, q) => p - q))
		const v = verifyLayout(next, ids, { requestedGap: LAYOUT_GAP, pairs: ids.slice(1).map((id, i) => [ids[i], id] as [string, string]), alignAxis: 'top', alignIds: ids })
		expect(v.status).toBe('verified')
		expect(v.alignment).toMatchObject({ ok: true, maxDeviation: 0 })
		expect(v.spacing.ok).toBe(true)
	})

	it('centres and bottom-aligns a row', () => {
		const layout = layoutOf(boxes)
		for (const [align, axis] of [['center', 'center-y'], ['bottom', 'bottom']] as const) {
			const next = layoutOf(apply(boxes, rowMoves(layout, ids, { align })))
			expect(verifyLayout(next, ids, { alignAxis: axis, alignIds: ids }).alignment.ok).toBe(true)
		}
	})

	it('moves a whole row clear of existing content without breaking its spacing', () => {
		const wall = box('wall', 0, 0, 5000, 600)
		const layout = layoutOf([wall, ...boxes.map((b) => ({ ...b, y: 100 }))])
		const moved = layoutOf(apply([wall, ...boxes.map((b) => ({ ...b, y: 100 }))], rowMoves(layout, ids, { y: 100 })))
		const v = verifyLayout(moved, ids, { requestedGap: LAYOUT_GAP, pairs: ids.slice(1).map((id, i) => [ids[i], id] as [string, string]) })
		expect(v.overlaps).toEqual([])
		expect(moved.byId.get(ids[0])!.bounds.y).toBeGreaterThanOrEqual(600 + LAYOUT_GAP)
		expect(v.spacing.ok).toBe(true)
	})

	it('stacks vertically with left, centre and right alignment', () => {
		const layout = layoutOf(boxes.map((b, i) => ({ ...b, props: { ...b.props, w: 100 + i * 50 } })))
		const shapes = boxes.map((b, i) => ({ ...b, props: { ...b.props, w: 100 + i * 50 } }))
		for (const [align, axis] of [['left', 'left'], ['center', 'center-x'], ['right', 'right']] as const) {
			const next = layoutOf(apply(shapes, stackMoves(layout, ids, { align })))
			expect(verifyLayout(next, ids, { alignAxis: axis, alignIds: ids }).alignment.ok).toBe(true)
			const bounds = ids.map((id) => next.byId.get(id)!.bounds)
			for (let i = 1; i < bounds.length; i += 1) expect(gapBetween(bounds[i - 1], bounds[i])).toBeCloseTo(LAYOUT_GAP)
		}
	})

	it('arranges a deterministic grid whose cells never overlap', () => {
		const layout = layoutOf(boxes)
		const once = gridMoves(layout, ids, 2)
		expect(gridMoves(layout, ids, 2)).toEqual(once)
		const next = layoutOf(apply(boxes, once))
		const v = verifyLayout(next, ids, { requestedGap: LAYOUT_GAP })
		expect(v.overlaps).toEqual([])
		const xs = ids.map((id) => next.byId.get(id)!.bounds.x)
		expect(xs[0]).toBe(xs[2]); expect(xs[2]).toBe(xs[4]); expect(xs[1]).toBe(xs[3]); expect(xs[1]).toBeGreaterThan(xs[0])
	})
})

describe('post-write verification', () => {
	it('finds a real overlap and names both shapes', () => {
		const layout = layoutOf([box('a', 0, 0, 100, 100), box('b', 50, 50, 100, 100)])
		const v = verifyLayout(layout, [sid('b')])
		expect(v.status).toBe('overlaps')
		expect(v.overlaps).toEqual([{ a: sid('b'), b: sid('a'), area: 2500 }])
	})

	it('does not count containment, arrows, or distant shapes as overlaps', () => {
		const frame: LayoutShapeRecord = { id: sid('f'), type: 'frame', x: 0, y: 0, rotation: 0, index: 'a1', parentId: PAGE, props: { w: 500, h: 500 } }
		const layout = layoutOf([frame, box('in', 10, 10, 50, 50, { parentId: sid('f'), label: '' }), box('far', 9000, 9000, 50, 50, { label: '' }), arrow('arr', 0, 0, 800, 800)])
		expect(verifyLayout(layout, [sid('in'), sid('f')]).overlaps).toEqual([])
		expect(verifyLayout(layout, [sid('in')]).status).toBe('verified')
	})

	it('says "partially unverified", never "verified", when placement rested on an estimated text size', () => {
		const layout = layoutOf([box('a', 0, 0, 100, 100), text('t', 0, 164, {})])
		const v = verifyLayout(layout, [sid('a')])
		expect(v.overlaps).toEqual([])
		expect(v.status).toBe('partially_unverified')
		expect(v.unverified).toEqual([{ id: sid('t'), reason: 'estimated' }])
		const measured = layoutOf([box('a', 0, 0, 100, 100), text('t', 0, 164)], [], new Map([[sid('t'), { id: sid('t'), w: 120, h: 40, fp: layoutFingerprint(text('t', 0, 164)) }]]))
		expect(verifyLayout(measured, [sid('a')]).status).toBe('verified')
	})

	it('reports shapes that are clear but closer than the requested spacing', () => {
		const layout = layoutOf([box('a', 0, 0, 100, 100), box('b', 120, 0, 100, 100)])
		const v = verifyLayout(layout, [sid('a'), sid('b')], { requestedGap: LAYOUT_GAP, pairs: [[sid('a'), sid('b')]] })
		expect(v.overlaps).toEqual([])
		expect(v.tooClose).toEqual([{ a: sid('a'), b: sid('b'), gap: 20 }])
		expect(v.spacing).toMatchObject({ requested: LAYOUT_GAP, minimum: 20, ok: false })
	})

	it('overlapArea and gapBetween are exact', () => {
		expect(overlapArea({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 })).toBe(25)
		expect(overlapArea({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 })).toBe(0)
		expect(gapBetween({ x: 0, y: 0, w: 10, h: 10 }, { x: 30, y: 5, w: 10, h: 10 })).toBe(20)
	})
})

describe('negative and asymmetric cases the verifier and the engine must get right', () => {
	const plain = (id: string, x: number, y: number, w = 100, h = 50) => box(id, x, y, w, h, { label: '' })

	it('spacing is not ok when requested shapes overlap, even though no "too close" pair is listed for them', () => {
		const v = verifyLayout(layoutOf([plain('a', 0, 0, 100, 100), plain('b', 50, 0, 100, 100)]), [sid('a'), sid('b')], { requestedGap: LAYOUT_GAP, pairs: [[sid('a'), sid('b')]] })
		expect(v.overlaps).toHaveLength(1)
		expect(v.tooClose).toEqual([])
		expect(v.spacing).toEqual({ requested: LAYOUT_GAP, minimum: 0, ok: false })
	})

	it('spacing is not ok when a requested pair is too close but only one member was touched', () => {
		const v = verifyLayout(layoutOf([plain('a', 0, 0), plain('b', 120, 0)]), [sid('a')], { requestedGap: LAYOUT_GAP, pairs: [[sid('a'), sid('b')]] })
		expect(v.tooClose).toEqual([])
		expect(v.spacing).toEqual({ requested: LAYOUT_GAP, minimum: 20, ok: false })
	})

	it('alignment is reported as not ok, with the deviation, when shapes are not aligned; two pixels is the tolerance', () => {
		const ids = [sid('a'), sid('b'), sid('c')]
		const bad = verifyLayout(layoutOf([plain('a', 0, 0), plain('b', 200, 10), plain('c', 400, 3)]), ids, { alignAxis: 'top', alignIds: ids })
		expect(bad.alignment).toEqual({ axis: 'top', maxDeviation: 10, ok: false })
		const within = verifyLayout(layoutOf([plain('a', 0, 0), plain('b', 200, 2)]), ids.slice(0, 2), { alignAxis: 'top', alignIds: ids.slice(0, 2) })
		expect(within.alignment).toEqual({ axis: 'top', maxDeviation: 2, ok: true })
		const beyond = verifyLayout(layoutOf([plain('a', 0, 0), plain('b', 200, 2.5)]), ids.slice(0, 2), { alignAxis: 'top', alignIds: ids.slice(0, 2) })
		expect(beyond.alignment.ok).toBe(false)
	})

	it('aligns right edges, horizontal centres and bottom edges exactly', () => {
		const shapes = [box('a', 100, 50, 100, 80), box('b', 300, 70, 150, 40), box('c', 520, 20, 60, 120)]
		const ids = shapes.map((s) => s.id)
		const layout = layoutOf(shapes)
		const next = (axis: Parameters<typeof alignMoves>[2]) => layoutOf(apply(shapes, alignMoves(layout, ids, axis)))
		expect(ids.map((id) => { const b = next('right').byId.get(id)!.bounds; return b.x + b.w })).toEqual([580, 580, 580])
		expect(ids.map((id) => { const b = next('center-x').byId.get(id)!.bounds; return b.x + b.w / 2 })).toEqual([340, 340, 340])
		expect(ids.map((id) => { const b = next('bottom').byId.get(id)!.bounds; return b.y + b.h })).toEqual([140, 140, 140])
	})

	it('a grid uses the shared default gap between columns and rows, and honours separate column and row gaps', () => {
		const shapes = [plain('a', 0, 0), plain('b', 500, 300), plain('c', 1000, 600), plain('d', 1500, 900)]
		const ids = shapes.map((s) => s.id)
		const layout = layoutOf(shapes)
		const at = (moves: Move[]) => { const next = layoutOf(apply(shapes, moves)); return ids.map((id) => { const b = next.byId.get(id)!.bounds; return [b.x, b.y] }) }
		expect(at(gridMoves(layout, ids, 2))).toEqual([[0, 0], [100 + LAYOUT_GAP, 0], [0, 50 + LAYOUT_GAP], [100 + LAYOUT_GAP, 50 + LAYOUT_GAP]])
		expect(at(gridMoves(layout, ids, 2, { columnGap: 10, rowGap: 20 }))).toEqual([[0, 0], [110, 0], [0, 70], [110, 70]])
	})

	it('placing relative to an arrow, or beneath one\'s own container, keeps the gap: neither is a blocker to slide past', () => {
		const target = arrow('arr', 0, 0, 300, 100)
		const moving = plain('b', 900, 900)
		const layout = layoutOf([target, moving])
		const below = layoutOf(apply([target, moving], placeBelow(layout, { id: sid('b'), targetId: sid('arr') }))).byId.get(sid('b'))!.bounds
		expect(below).toMatchObject({ x: 0, y: 100 + LAYOUT_GAP })
		const beside = layoutOf(apply([target, moving], placeRightOf(layout, { id: sid('b'), targetId: sid('arr') }))).byId.get(sid('b'))!.bounds
		expect(beside).toMatchObject({ x: 300 + LAYOUT_GAP, y: 0 })

		const frame: LayoutShapeRecord = { id: sid('f'), type: 'frame', x: 0, y: 0, rotation: 0, index: 'a1', parentId: PAGE, props: { w: 500, h: 400 } }
		const inner = box('c', 10, 10, 50, 50, { parentId: sid('f'), label: '' })
		const nested = layoutOf([frame, inner])
		const out = layoutOf(apply([frame, inner], placeBelow(nested, { id: sid('c'), targetId: sid('f') }))).byId.get(sid('c'))!.bounds
		expect(out.y).toBe(400 + LAYOUT_GAP)
	})

	it('auto-sized text is never smaller than the width a browser last stored for it, and scale applies to it', () => {
		expect(layoutOf([text('wide', 0, 0, { w: 600 })]).byId.get(sid('wide'))!.bounds.w).toBe(600)
		const narrow = layoutOf([text('narrow', 0, 0, { w: 10 })]).byId.get(sid('narrow'))!.bounds.w
		expect(narrow).toBeGreaterThan(10)
		expect(layoutOf([text('scaled', 0, 0, { w: 300, scale: 2 })]).byId.get(sid('scaled'))!.bounds.w).toBe(600)
	})
})

describe('the audited board pattern (9 rectangles, 11 arrows, a large text block)', () => {
	// The structural pattern found on the real board: a flowchart of 420-wide boxes in columns 520 apart, joined by static
	// arrows, and a large multi-line text block that a person dropped on top of it.
	const rects = [
		['goal', 0, 0, 150], ['le', 0, 230, 190], ['so', 520, -50, 180], ['re', 520, 210, 210], ['ar', 1040, -50, 180],
		['we', 1040, 210, 210], ['mv', 1560, -50, 180], ['fi', 1560, 210, 210], ['ne', 2080, 80, 220],
	] as const
	const flow = rects.map(([name, x, y, h]) => box(name, x, y, 420, h, { label: 'x'.repeat(40) }))
	const links = [['goal', 'so'], ['goal', 're'], ['le', 're'], ['le', 'so'], ['so', 'ar'], ['re', 'we'], ['ar', 'we'], ['we', 'fi'], ['ar', 'mv'], ['mv', 'ne'], ['fi', 'ne']]
	const arrows = links.map(([from, to], i) => {
		const a = flow.find((s) => s.id === sid(from))!, b = flow.find((s) => s.id === sid(to))!
		return arrow(`link${i}`, a.x + 420, a.y + 90, b.x, b.y + 90, { meta: { canvasApiConnection: { fromId: a.id, toId: b.id } } })
	})
	const todo = text('todo', 1278, 242, { richText: rich(...Array.from({ length: 57 }, (_, i) => (i % 9 === 0 ? 'A heading line for a section of the plan' : 'y'.repeat(60)))), w: 1144.97 })
	const board = [...flow, ...arrows, todo]

	it('reproduces the overlap the audit found: the dropped text covers three boxes', () => {
		const layout = layoutOf(board)
		const v = verifyLayout(layout, [todo.id])
		expect(v.status).toBe('overlaps')
		expect(v.overlaps.map((o) => o.b).sort()).toEqual([sid('fi'), sid('ne'), sid('we')])
	})

	it('placing the text below the architecture region clears it, keeps spacing, and is honest that the text is estimated', () => {
		const layout = layoutOf(board)
		const [m] = placeBelow(layout, { id: todo.id, targetId: sid('le') })
		const placed = layoutOf(apply(board, [m]))
		const t = placed.byId.get(todo.id)!.bounds
		const lowest = Math.max(...flow.map((f) => (f.props.h as number) + f.y))
		expect(t.y).toBeGreaterThanOrEqual(lowest + LAYOUT_GAP - 1)
		const v = verifyLayout(placed, [todo.id], { requestedGap: LAYOUT_GAP, pairs: [[todo.id, sid('le')]] })
		expect(v.overlaps).toEqual([])
		expect(v.spacing.ok).toBe(true)
		expect(v.status).toBe('partially_unverified')
		expect(v.items[0].boundsSource).toBe('estimated')
	})

	it('is verified outright once a browser has measured the text', () => {
		const layout = layoutOf(board, [], new Map([[todo.id, { id: todo.id, w: 1145, h: 1500, fp: layoutFingerprint(todo) }]]))
		const [m] = placeBelow(layout, { id: todo.id, targetId: sid('le') })
		const placed = layoutOf(apply(board, [m]), [], new Map([[todo.id, { id: todo.id, w: 1145, h: 1500, fp: layoutFingerprint(todo) }]]))
		expect(verifyLayout(placed, [todo.id], { requestedGap: LAYOUT_GAP, pairs: [[todo.id, sid('le')]] }).status).toBe('verified')
	})

	it('a row of the architecture boxes aligns them and the arrows (endpoints) can be recomputed from the same geometry', () => {
		const layout = layoutOf(flow)
		const ids = flow.map((f) => f.id)
		const next = layoutOf(apply(flow, rowMoves(layout, ids, { gap: 100 })))
		const v = verifyLayout(next, ids, { requestedGap: 100, pairs: ids.slice(1).map((id, i) => [ids[i], id] as [string, string]), alignAxis: 'top', alignIds: ids })
		expect(v.status).toBe('verified')
		expect(v.alignment.maxDeviation).toBe(0)
	})
})
