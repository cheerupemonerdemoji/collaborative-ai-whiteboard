/**
 * Layout actions on `POST /api/rooms/:id/actions`, through the real application: what they move, what they write
 * (genuine arrow bindings), who may call them, and how honestly they report the result. The pure geometry is covered in
 * tests/layout-core.test.ts; this file is about the write path.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getRoomHandle } from '../server/rooms'
import { createClient } from '../server/token-store.mjs'
import { layoutFingerprint, LAYOUT_GAP } from '../shared/layout'
import { createAcceptanceFixture, type AcceptanceFixture } from './helpers/acceptance-fixture'

let f: AcceptanceFixture
let storeDirectory: string
let storeFile: string

const bearer = (token: string) => ({ authorization: `Bearer ${token}` })
const sid = (name: string) => `shape:${name}`
const act = (list: unknown[], who: { post: AcceptanceFixture['owner']['post'] } = f.owner) => who.post(`/api/rooms/${f.boardId}/actions`, { actions: list })
const rect = (name: string, x: number, y: number, w = 200, h = 100, text = name) => ({ tool: 'create_shape', id: sid(name), type: 'rectangle', text, x, y, width: w, height: h })

type AnyRecord = { id: string; typeName: string; type?: string; x?: number; y?: number; fromId?: string; toId?: string; props?: Record<string, any>; meta?: Record<string, any> }
const records = () => getRoomHandle(f.boardId).room.getCurrentSnapshot().documents.map((d) => d.state) as AnyRecord[]
const record = (id: string) => records().find((r) => r.id === id) as AnyRecord
const bindings = () => records().filter((r) => r.typeName === 'binding')
const historyCount = () => (getRoomHandle(f.boardId).database.prepare('SELECT COUNT(*) AS n FROM history_events').get() as { n: number }).n
async function layout(query = '') {
	const response = await f.owner.get(`/api/rooms/${f.boardId}/layout${query}`)
	expect(response.statusCode, response.body).toBe(200)
	const body = response.json()
	return { ...body, byId: new Map<string, any>(body.shapes.map((s: any) => [s.id, s])) }
}
const bottom = (b: { y: number; h: number }) => b.y + b.h
const right = (b: { x: number; w: number }) => b.x + b.w
const intersects = (a: any, b: any) => a.x < right(b) && b.x < right(a) && a.y < bottom(b) && b.y < bottom(a)

beforeEach(async () => {
	f = await createAcceptanceFixture()
	storeDirectory = mkdtempSync(join(tmpdir(), 'layout-actions-store-'))
	storeFile = join(storeDirectory, 'api-tokens.json')
	process.env.CANVAS_API_TOKENS_FILE = storeFile
})

afterEach(async () => {
	await f.cleanup()
	rmSync(storeDirectory, { recursive: true, force: true })
})

describe('connect_shapes writes genuine tldraw bindings', () => {
	it('creates a start and an end binding on the arrow, aimed at the real edges, and keeps the legacy marker', async () => {
		const response = await act([rect('a', 100, 100), rect('b', 500, 100), { tool: 'connect_shapes', id: sid('link'), fromId: sid('a'), toId: sid('b') }])
		expect(response.statusCode, response.body).toBe(200)
		const found = bindings()
		expect(found).toHaveLength(2)
		const byTerminal = new Map(found.map((b) => [b.props?.terminal, b]))
		expect(byTerminal.get('start')).toMatchObject({ type: 'arrow', fromId: sid('link'), toId: sid('a'), props: { normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false } })
		expect(byTerminal.get('end')).toMatchObject({ type: 'arrow', fromId: sid('link'), toId: sid('b') })
		const arrow = record(sid('link'))
		expect(arrow.meta?.canvasApiConnection).toEqual({ fromId: sid('a'), toId: sid('b') })
		// the older canvas read still reports the same endpoints
		const object = (await f.owner.get(`/api/rooms/${f.boardId}/canvas`)).json().objects.find((o: any) => o.id === sid('link'))
		expect(object).toMatchObject({ startX: 300, endX: 500, fromId: sid('a'), toId: sid('b') })
	})

	it('aims at estimated text bounds rather than a fixed 200 x 0 box', async () => {
		await act([{ tool: 'create_text', id: sid('t'), text: 'one\ntwo\nthree\nfour', x: 0, y: 0 }, rect('r', 0, 600), { tool: 'connect_shapes', id: sid('link'), fromId: sid('t'), toId: sid('r') }])
		const entry = (await layout()).byId.get(sid('t'))
		const arrow = (await layout()).byId.get(sid('link'))
		expect(arrow.arrow.start.y).toBeCloseTo(bottom(entry.bounds), 0)
	})

	it('removes the bindings together with the arrow or with either shape', async () => {
		await act([rect('a', 0, 0), rect('b', 400, 0), rect('c', 800, 0), { tool: 'connect_shapes', id: sid('ab'), fromId: sid('a'), toId: sid('b') }, { tool: 'connect_shapes', id: sid('bc'), fromId: sid('b'), toId: sid('c') }])
		expect(bindings()).toHaveLength(4)
		await act([{ tool: 'delete_shape', id: sid('ab') }])
		expect(bindings().map((b) => b.fromId)).toEqual([sid('bc'), sid('bc')])
		await act([{ tool: 'delete_shape', id: sid('c') }])
		expect(bindings().filter((b) => b.toId === sid('c'))).toEqual([])
		expect(bindings().filter((b) => b.fromId === sid('ab'))).toEqual([])
	})

	it('refuses to reuse a binding id and an unknown endpoint', async () => {
		await act([rect('a', 0, 0), rect('b', 400, 0)])
		expect((await act([{ tool: 'connect_shapes', id: sid('x'), fromId: sid('a'), toId: sid('nope') }])).statusCode).toBe(404)
		expect(bindings()).toHaveLength(0)
	})
})

describe('create_text with a fixed width', () => {
	it('wraps at the width deterministically: fixed-width, not auto-sized', async () => {
		await act([{ tool: 'create_text', id: sid('t'), text: 'a long line of words that should wrap inside the fixed width of this block', x: 0, y: 0, width: 300 }])
		expect(record(sid('t')).props).toMatchObject({ autoSize: false, w: 300 })
		const entry = (await layout()).byId.get(sid('t'))
		expect(entry.bounds.w).toBe(300)
		expect(entry.bounds.h).toBeGreaterThan(40)
		expect(entry).toMatchObject({ boundsSource: 'estimated', verification: 'unverified' })
	})

	it('without a width the text stays auto-sized, as before', async () => {
		await act([{ tool: 'create_text', id: sid('t'), text: 'plain', x: 0, y: 0 }])
		expect(record(sid('t')).props).toMatchObject({ autoSize: true })
		expect((await act([{ tool: 'create_text', id: sid('u'), text: 'x', x: 0, y: 0, width: 5 }])).statusCode).toBe(422)
	})
})

describe('placement actions', () => {
	it('place_below puts a shape under its target at the shared default gap and verifies the result', async () => {
		await act([rect('a', 100, 100, 300, 120), rect('b', 900, 900, 200, 100)])
		const response = await act([{ tool: 'place_below', id: sid('b'), targetId: sid('a') }])
		expect(response.statusCode, response.body).toBe(200)
		const { layout: result } = response.json()
		expect(result.gap).toBe(LAYOUT_GAP)
		expect(result.status).toBe('verified')
		expect(result.results[0]).toMatchObject({ tool: 'place_below', moved: [{ id: sid('b') }] })
		expect(result.results[0].verification.items.find((i: any) => i.id === sid('b'))).toMatchObject({ bounds: { x: 100, y: 284, w: 200, h: 100 }, boundsSource: 'declared', verification: 'verified' })
		expect(result.results[0].verification.spacing).toMatchObject({ requested: 64, ok: true })
		expect((await layout()).byId.get(sid('b')).bounds).toMatchObject({ x: 100, y: 284 })
	})

	it('place_right_of slides past an obstacle instead of landing on it', async () => {
		await act([rect('a', 0, 0), rect('b', 900, 900), rect('blocker', 264, 0, 100, 100)])
		const response = await act([{ tool: 'place_right_of', id: sid('b'), targetId: sid('a') }])
		expect(response.statusCode).toBe(200)
		const moved = (await layout()).byId.get(sid('b')).bounds
		expect(moved.x).toBeGreaterThanOrEqual(364 + 64)
		expect(response.json().layout.final.overlaps).toEqual([])
	})

	it('find_free_region is read-only: it moves nothing, writes no history, and says what it relied on', async () => {
		await act([rect('a', 0, 0, 400, 300), { tool: 'create_text', id: sid('t'), text: 'estimated\ntext', x: 0, y: 380 }])
		const before = records()
		const events = historyCount()
		const response = await act([{ tool: 'find_free_region', width: 500, height: 200, near: sid('a'), direction: 'below' }])
		expect(response.statusCode, response.body).toBe(200)
		const result = response.json().layout.results[0]
		expect(result).toMatchObject({ tool: 'find_free_region', moved: [], region: { w: 500, h: 200, direction: 'below' } })
		const text = (await layout()).byId.get(sid('t')).bounds
		expect(result.region.y).toBeGreaterThanOrEqual(bottom(text) + 64)
		expect(result.unverifiedNeighbours.map((n: any) => n.id)).toContain(sid('t'))
		expect(response.json().layout.status).toBe('partially_unverified')
		expect(records()).toEqual(before)
		// a pure read of geometry: not a canvas mutation, so no history event is recorded for it
		expect(historyCount()).toBe(events)
	})

	it('reports the overall result as partially unverified when estimated text is involved, never "verified"', async () => {
		await act([rect('a', 0, 0), { tool: 'create_text', id: sid('t'), text: 'a few\nlines\nof text', x: 800, y: 800 }])
		const response = await act([{ tool: 'place_below', id: sid('t'), targetId: sid('a') }])
		const result = response.json().layout
		expect(result.status).toBe('partially_unverified')
		expect(result.results[0].verification.unverified).toEqual([{ id: sid('t'), reason: 'estimated' }])
		expect(result.final.overlaps).toEqual([])
	})
})

describe('arrangement actions', () => {
	const grid3 = [rect('a', 0, 0, 100, 80), rect('b', 700, 400, 220, 140), rect('c', 20, 900, 160, 80), rect('d', 400, 50, 100, 100)]

	it('row lines shapes up at a uniform gap with a shared top, in the order given', async () => {
		await act(grid3)
		const response = await act([{ tool: 'row', ids: [sid('c'), sid('a'), sid('d')], align: 'top', x: 1000, y: 2000 }])
		expect(response.statusCode, response.body).toBe(200)
		const { byId } = await layout()
		const [c, a, d] = [sid('c'), sid('a'), sid('d')].map((id) => byId.get(id).bounds)
		expect([c.y, a.y, d.y]).toEqual([2000, 2000, 2000])
		expect(a.x - right(c)).toBe(64)
		expect(d.x - right(a)).toBe(64)
		const verification = response.json().layout.results[0].verification
		expect(verification).toMatchObject({ status: 'verified', spacing: { ok: true }, alignment: { axis: 'top', ok: true } })
	})

	it('stack, align and distribute report the alignment deviation they leave', async () => {
		await act(grid3)
		const stack = (await act([{ tool: 'stack', ids: [sid('a'), sid('b'), sid('c')], align: 'center', gap: 32, x: 0, y: 3000 }])).json().layout.results[0].verification
		expect(stack.alignment).toMatchObject({ axis: 'center-x', ok: true })
		expect(stack.spacing.requested).toBe(32)
		const align = (await act([{ tool: 'align', ids: [sid('a'), sid('d')], axis: 'left' }])).json().layout.results[0].verification
		expect(align.alignment).toMatchObject({ axis: 'left', maxDeviation: 0, ok: true })
		const dist = await act([{ tool: 'distribute', ids: [sid('a'), sid('b'), sid('c')], direction: 'horizontal', gap: 100 }])
		expect(dist.statusCode, dist.body).toBe(200)
	})

	it('grid arranges row-major into the requested columns without any cell overlapping', async () => {
		await act(grid3)
		const response = await act([{ tool: 'grid', ids: [sid('a'), sid('b'), sid('c'), sid('d')], columns: 2, x: 0, y: 5000 }])
		expect(response.statusCode, response.body).toBe(200)
		const { byId } = await layout()
		const b = [sid('a'), sid('b'), sid('c'), sid('d')].map((id) => byId.get(id).bounds)
		expect(b[0].y).toBe(b[1].y)
		expect(b[2].y).toBe(b[3].y)
		expect(b[0].x).toBe(b[2].x)
		for (let i = 0; i < 4; i += 1) for (let j = i + 1; j < 4; j += 1) expect(intersects(b[i], b[j])).toBe(false)
		expect(response.json().layout.status).toBe('verified')
	})

	it('a layout block slides clear of existing content rather than landing on it', async () => {
		await act([...grid3, rect('wall', 0, 5000, 3000, 400)])
		await act([{ tool: 'row', ids: [sid('a'), sid('d')], x: 0, y: 5000 }])
		expect(bottom((await layout()).byId.get(sid('wall')).bounds)).toBeLessThanOrEqual((await layout()).byId.get(sid('a')).bounds.y - 64 + 0.01)
	})

	it('reports an overlap honestly when collisions are not avoided', async () => {
		await act([rect('a', 0, 0), rect('b', 600, 0), rect('wall', 0, 0, 2000, 400)])
		const response = await act([{ tool: 'row', ids: [sid('a'), sid('b')], x: 0, y: 0, avoidCollisions: false }])
		expect(response.json().layout.status).toBe('overlaps')
		expect(response.json().layout.results[0].verification.overlaps.length).toBeGreaterThan(0)
	})
})

describe('what layout actions refuse', () => {
	it('refuses unknown ids, arrows, locked shapes and a container moved with its own child', async () => {
		await act([rect('a', 0, 0), rect('b', 500, 0), { tool: 'connect_shapes', id: sid('link'), fromId: sid('a'), toId: sid('b') }])
		expect((await act([{ tool: 'place_below', id: sid('ghost'), targetId: sid('a') }])).statusCode).toBe(404)
		expect((await act([{ tool: 'align', ids: [sid('link'), sid('a')], axis: 'left' }])).statusCode).toBe(422)
		const { room } = getRoomHandle(f.boardId)
		room.storage.transaction((txn) => { txn.set(sid('a'), { ...record(sid('a')), isLocked: true } as never) })
		const locked = await act([{ tool: 'place_below', id: sid('a'), targetId: sid('b') }])
		expect(locked.statusCode).toBe(409)
		expect(record(sid('a')).x).toBe(0)
	})

	it('a failed layout action leaves the whole request unapplied', async () => {
		await act([rect('a', 0, 0), rect('b', 500, 0)])
		const events = historyCount()
		const response = await act([{ tool: 'place_below', id: sid('b'), targetId: sid('a') }, { tool: 'place_below', id: sid('ghost'), targetId: sid('a') }])
		expect(response.statusCode).toBe(404)
		expect(record(sid('b'))).toMatchObject({ x: 500, y: 0 })
		expect(historyCount()).toBe(events)
	})

	it('moves a nested shape by its page-space delta and refuses a container together with its child', async () => {
		await act([rect('a', 0, 0)])
		const { room } = getRoomHandle(f.boardId)
		room.storage.transaction((txn) => {
			const page = [...txn.values()].find((r) => (r as { typeName: string }).typeName === 'page') as { id: string }
			txn.set('shape:frame1', { id: 'shape:frame1', typeName: 'shape', type: 'frame', x: 1000, y: 1000, rotation: 0, index: 'a9', parentId: page.id, isLocked: false, opacity: 1, meta: {}, props: { w: 800, h: 600, name: 'F', color: 'black' } } as never)
			txn.set('shape:inner', { id: 'shape:inner', typeName: 'shape', type: 'geo', x: 50, y: 60, rotation: 0, index: 'a1', parentId: 'shape:frame1', isLocked: false, opacity: 1, meta: {}, props: { geo: 'rectangle', w: 120, h: 80, growY: 0, color: 'black', labelColor: 'black', fill: 'none', dash: 'draw', size: 'm', font: 'draw', align: 'middle', verticalAlign: 'middle', richText: { type: 'doc', content: [{ type: 'paragraph' }] }, url: '', scale: 1, flipX: false, flipY: false } } as never)
		})
		expect((await act([{ tool: 'align', ids: ['shape:frame1', 'shape:inner'], axis: 'left' }])).statusCode).toBe(422)
		const response = await act([{ tool: 'place_below', id: 'shape:inner', targetId: sid('a') }])
		expect(response.statusCode, response.body).toBe(200)
		expect((await layout()).byId.get('shape:inner').bounds).toMatchObject({ x: 0, y: 164, w: 120, h: 80 })
		expect(record('shape:inner')).toMatchObject({ x: -1000, y: 164 - 1000 })
	})
})

describe('arrows follow their boxes', () => {
	it('re-routes API-drawn arrows when a layout action moves a box, and the bindings are untouched', async () => {
		await act([rect('a', 0, 0), rect('b', 500, 0), { tool: 'connect_shapes', id: sid('link'), fromId: sid('a'), toId: sid('b') }])
		const bindingsBefore = JSON.stringify(bindings())
		const response = await act([{ tool: 'place_below', id: sid('b'), targetId: sid('a'), align: 'start' }])
		expect(response.statusCode, response.body).toBe(200)
		const arrow = (await layout()).byId.get(sid('link'))
		const a = (await layout()).byId.get(sid('a')).bounds, b = (await layout()).byId.get(sid('b')).bounds
		// from a's bottom edge to b's top edge, vertically
		expect(arrow.arrow.start.y).toBeCloseTo(bottom(a), 0)
		expect(arrow.arrow.end.y).toBeCloseTo(b.y, 0)
		expect(JSON.stringify(bindings())).toBe(bindingsBefore)
		expect(response.json().layout.arrows).toEqual([expect.objectContaining({ id: sid('link'), bound: true, attached: true })])
	})

	it('re-routes a legacy static arrow (no bindings) when move_shape or resize_shape changes its box', async () => {
		await act([rect('a', 0, 0), rect('b', 500, 0)])
		const { room } = getRoomHandle(f.boardId)
		room.storage.transaction((txn) => {
			const page = [...txn.values()].find((r) => (r as { typeName: string }).typeName === 'page') as { id: string }
			txn.set(sid('old'), { id: sid('old'), typeName: 'shape', type: 'arrow', x: 200, y: 50, rotation: 0, index: 'a8', parentId: page.id, isLocked: false, opacity: 1, meta: { canvasApiConnection: { fromId: sid('a'), toId: sid('b') } }, props: { kind: 'arc', color: 'black', labelColor: 'black', fill: 'none', dash: 'draw', size: 'm', arrowheadStart: 'none', arrowheadEnd: 'arrow', font: 'draw', start: { x: 0, y: 0 }, end: { x: 300, y: 0 }, bend: 0, richText: { type: 'doc', content: [{ type: 'paragraph' }] }, labelPosition: 0.5, scale: 1, elbowMidPoint: 0.5 } } as never)
		})
		expect(bindings()).toHaveLength(0)
		await act([{ tool: 'move_shape', id: sid('b'), x: 500, y: 600 }])
		const arrow = (await layout()).byId.get(sid('old')).arrow
		expect(arrow.end.y).toBeCloseTo(600, 0)
		await act([{ tool: 'resize_shape', id: sid('a'), width: 400, height: 100 }])
		expect((await layout()).byId.get(sid('old')).arrow.start.x).toBeGreaterThan(200)
	})

	it('leaves a person\'s bound arrow and its bindings exactly as they were when its boxes are moved', async () => {
		await act([rect('a', 0, 0), rect('b', 500, 0)])
		const { room } = getRoomHandle(f.boardId)
		room.storage.transaction((txn) => {
			const page = [...txn.values()].find((r) => (r as { typeName: string }).typeName === 'page') as { id: string }
			txn.set('shape:human', { id: 'shape:human', typeName: 'shape', type: 'arrow', x: 100, y: 50, rotation: 0, index: 'a8', parentId: page.id, isLocked: false, opacity: 1, meta: {}, props: { kind: 'arc', color: 'black', labelColor: 'black', fill: 'none', dash: 'draw', size: 'm', arrowheadStart: 'none', arrowheadEnd: 'arrow', font: 'draw', start: { x: 0, y: 0 }, end: { x: 400, y: 0 }, bend: 0, richText: { type: 'doc', content: [{ type: 'paragraph' }] }, labelPosition: 0.5, scale: 1, elbowMidPoint: 0.5 } } as never)
			for (const [terminal, to] of [['start', sid('a')], ['end', sid('b')]] as const) txn.set(`binding:human_${terminal}`, { id: `binding:human_${terminal}`, typeName: 'binding', type: 'arrow', fromId: 'shape:human', toId: to, props: { terminal, normalizedAnchor: { x: 0.3, y: 0.7 }, isExact: false, isPrecise: true, snap: 'none' }, meta: {} } as never)
		})
		const arrowBefore = JSON.stringify(record('shape:human')), bindingsBefore = JSON.stringify(bindings())
		await act([{ tool: 'place_below', id: sid('b'), targetId: sid('a') }])
		expect(JSON.stringify(record('shape:human'))).toBe(arrowBefore)
		expect(JSON.stringify(bindings())).toBe(bindingsBefore)
	})

	it('does not treat a bound arrow as a rectangular blocker: placement may pass through a connector', async () => {
		await act([rect('a', 0, 0), rect('b', 800, 0), rect('c', 0, 900), { tool: 'connect_shapes', id: sid('link'), fromId: sid('a'), toId: sid('b') }])
		await act([{ tool: 'place_right_of', id: sid('c'), targetId: sid('a'), gap: 100 }])
		// a's right edge is 200; the connector runs across y=50 there, and c (height 100) lands exactly across it
		expect((await layout()).byId.get(sid('c')).bounds).toMatchObject({ x: 300, y: 0 })
	})
})

describe('who may lay a board out', () => {
	it('a read token can read the layout but cannot act; a write token can; another board and the human host policy hold', async () => {
		await act([rect('a', 0, 0), rect('b', 500, 500)])
		const reader = await createClient({ file: storeFile, name: 'la-reader', rooms: [f.boardId], access: 'read' })
		const writer = await createClient({ file: storeFile, name: 'la-writer', rooms: [f.boardId], access: 'full' })
		const other = await createClient({ file: storeFile, name: 'la-other', rooms: ['some-other-board'], access: 'full' })
		const body = { actions: [{ tool: 'place_below', id: sid('b'), targetId: sid('a') }] }
		const post = (token: string) => f.app.inject({ method: 'POST', url: `/api/rooms/${f.boardId}/actions`, headers: bearer(token), payload: body })
		expect((await f.app.inject({ method: 'GET', url: `/api/rooms/${f.boardId}/layout`, headers: bearer(reader.token) })).statusCode).toBe(200)
		expect([401, 403]).toContain((await post(reader.token)).statusCode)
		expect(record(sid('b'))).toMatchObject({ x: 500, y: 500 })
		expect([401, 403]).toContain((await post(other.token)).statusCode)
		expect(record(sid('b'))).toMatchObject({ x: 500, y: 500 })
		const ok = await post(writer.token)
		expect(ok.statusCode, ok.body).toBe(200)
		expect(record(sid('b'))).toMatchObject({ x: 0, y: 164 })
		// the token's actions are attributed to the agent in history, like any other machine write
		const source = getRoomHandle(f.boardId).database.prepare('SELECT source AS s FROM history_events ORDER BY id DESC LIMIT 1').get() as { s: string }
		expect(source.s).toBe('ai')
	})

	it('human roles: viewers and non-members cannot move anything; an editor can', async () => {
		await act([rect('a', 0, 0), rect('b', 500, 500)])
		const move = { tool: 'place_below', id: sid('b'), targetId: sid('a') }
		expect((await act([move], f.viewer)).statusCode).toBe(403)
		expect((await act([move], f.nonmember)).statusCode).toBe(404)
		expect((await act([move], f.anonymous)).statusCode).toBe(401)
		expect(record(sid('b'))).toMatchObject({ x: 500, y: 500 })
		expect((await act([move], f.editor)).statusCode).toBe(200)
	})
})

describe('the audited board, rebuilt', () => {
	const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']
	const TODO = ['TODO', ...Array.from({ length: 28 }, (_, i) => `${i + 1}. a fairly long engineering follow-up item that needs a real line of its own`)].join('\n')

	/** A person's browser can create text of any length; the API caps one text at 500 characters. */
	function addHumanText(id: string, text: string, x: number, y: number) {
		const paragraphs = text.split('\n').map((line) => ({ type: 'paragraph', content: [{ type: 'text', text: line }] }))
		getRoomHandle(f.boardId).room.storage.transaction((txn) => {
			const page = [...txn.values()].find((r) => (r as { typeName: string }).typeName === 'page') as { id: string }
			txn.set(id, { id, typeName: 'shape', type: 'text', x, y, rotation: 0, index: 'a7', parentId: page.id, isLocked: false, opacity: 1, meta: {}, props: { color: 'black', size: 'm', font: 'draw', textAlign: 'start', w: 200, richText: { type: 'doc', content: paragraphs }, scale: 1, autoSize: true } } as never)
		})
	}

	async function build() {
		const boxes = names.map((n, i) => rect(n, (i % 3) * 330 + (i % 2) * 17, Math.floor(i / 3) * 90 + (i % 4) * 9, 150 + (i % 3) * 40, 70 + (i % 2) * 30, `Box ${n}`))
		// 11 connectors: a chain through all nine plus three cross-links
		const pairs = [...names.slice(0, -1).map((n, i) => [n, names[i + 1]]), ['a', 'e'], ['c', 'g'], ['b', 'h']]
		const arrows = pairs.map(([from, to], i) => ({ tool: 'connect_shapes', id: sid(`arrow${i}`), fromId: sid(from), toId: sid(to) }))
		const first = await act(boxes)
		expect(first.statusCode, first.body).toBe(200)
		// the large text goes in exactly where it collides: over the middle of the architecture
		addHumanText(sid('todo'), TODO, 100, 100)
		expect((await act(arrows.slice(0, 11))).statusCode).toBe(200)
	}

	it('reproduces the overlap, then a layout pass fixes it and reports honestly what it could not measure', async () => {
		await build()
		const before = await layout()
		const architecture = names.map((n) => before.byId.get(sid(n)).bounds)
		expect(intersects(before.byId.get(sid('todo')).bounds, architecture[4])).toBe(true)
		expect(before.shapes.filter((s: any) => s.type === 'arrow')).toHaveLength(11)

		// tidy: 3 x 3 grid of the boxes, then the text under the whole architecture region
		const tidy = await act([
			{ tool: 'grid', ids: names.map((n) => sid(n)), columns: 3, x: 0, y: 0, columnGap: 96, rowGap: 96 },
			{ tool: 'place_below', id: sid('todo'), targetId: sid('g'), gap: 96 },
		])
		expect(tidy.statusCode, tidy.body).toBe(200)
		const out = tidy.json().layout
		const after = await layout()
		const boxesAfter = names.map((n) => after.byId.get(sid(n)).bounds)

		// rows are aligned and spacing is uniform
		for (const row of [0, 1, 2]) {
			const ys = boxesAfter.slice(row * 3, row * 3 + 3).map((b) => b.y)
			expect(new Set(ys).size).toBe(1)
		}
		for (const row of [0, 1, 2]) for (const col of [0, 1]) expect(boxesAfter[row * 3 + col + 1].x - right(boxesAfter[row * 3 + col])).toBe(96)
		// the text sits below and outside the architecture region
		const todo = after.byId.get(sid('todo')).bounds
		const region = boxesAfter.reduce((u, b) => ({ x: Math.min(u.x, b.x), y: Math.min(u.y, b.y), w: 0, h: 0, r: Math.max(u.r, right(b)), b: Math.max(u.b, bottom(b)) }), { x: Infinity, y: Infinity, w: 0, h: 0, r: -Infinity, b: -Infinity })
		expect(todo.y).toBeGreaterThanOrEqual(region.b + 96 - 0.01)
		expect(intersects(todo, { x: region.x, y: region.y, w: region.r - region.x, h: region.b - region.y })).toBe(false)
		// no unexpected intersections between any two non-arrow shapes
		const solid = after.shapes.filter((s: any) => s.type !== 'arrow')
		for (let i = 0; i < solid.length; i += 1) for (let j = i + 1; j < solid.length; j += 1) expect(intersects(solid[i].bounds, solid[j].bounds), `${solid[i].id} / ${solid[j].id}`).toBe(false)
		// every connector is attached to the (moved) boxes: genuine bindings, endpoints on the edges
		expect(bindings()).toHaveLength(22)
		expect(out.arrows).toHaveLength(11)
		expect(out.arrows.every((arrow: any) => arrow.attached && arrow.bound)).toBe(true)
		// the text is an estimate and is reported as such: partially unverified, not a clean bill of health
		expect(after.byId.get(sid('todo'))).toMatchObject({ boundsSource: 'estimated', verification: 'unverified' })
		expect(boxesAfter.length).toBe(9)
		expect(out.status).toBe('partially_unverified')
		expect(out.results[1].verification.unverified).toEqual([{ id: sid('todo'), reason: 'estimated' }])
	})

	it('a browser measurement upgrades the text to measured without silently moving anything', async () => {
		await build()
		await act([{ tool: 'place_below', id: sid('todo'), targetId: sid('g'), gap: 96 }])
		const before = JSON.stringify(records().filter((r) => r.typeName === 'shape'))
		const shape = record(sid('todo')) as { id: string; type: string; props: Record<string, unknown> }
		const report = await f.editor.post(`/api/boards/${f.boardId}/layout-measurements`, { measurements: [{ id: shape.id, w: 880, h: 1300, fp: layoutFingerprint(shape) }] })
		expect(report.json()).toEqual({ accepted: 1, stale: 0, ignored: 0 })
		const entry = (await layout()).byId.get(sid('todo'))
		expect(entry).toMatchObject({ boundsSource: 'measured', verification: 'verified', bounds: { w: 880, h: 1300 } })
		expect(JSON.stringify(records().filter((r) => r.typeName === 'shape'))).toBe(before)
		// asking for the same placement again now verifies against the measured size
		const again = await act([{ tool: 'place_below', id: sid('todo'), targetId: sid('g'), gap: 96 }])
		expect(again.json().layout.results[0].verification.unverified).toEqual([])
		expect(again.json().layout.final.unverified).toEqual([])
	})
})

describe('arrows follow their boxes: stored records, not just the layout read', () => {
	const endpoints = (id: string) => {
		const arrow = record(id)
		const props = arrow.props as { start: { x: number; y: number }; end: { x: number; y: number } }
		return { sx: arrow.x! + props.start.x, sy: arrow.y! + props.start.y, ex: arrow.x! + props.end.x, ey: arrow.y! + props.end.y }
	}

	it('a layout move rewrites the stored endpoints of the arrow the API drew, bound or legacy', async () => {
		await act([rect('a', 0, 0, 200, 100), rect('b', 500, 0, 200, 100), { tool: 'connect_shapes', id: sid('link'), fromId: sid('a'), toId: sid('b') }])
		expect(endpoints(sid('link'))).toMatchObject({ sx: 200, ex: 500 })
		await act([{ tool: 'place_below', id: sid('b'), targetId: sid('a'), align: 'start' }])
		// b now sits directly beneath a: the stored arrow runs from a's bottom edge to b's top edge
		const after = endpoints(sid('link'))
		expect(after.sx).toBeCloseTo(100); expect(after.sy).toBeCloseTo(100); expect(after.ex).toBeCloseTo(100); expect(after.ey).toBeCloseTo(164)
		// the canvas read, which has no binding awareness, agrees
		const object = (await f.owner.get('/api/rooms/' + f.boardId + '/canvas')).json().objects.find((o: any) => o.id === sid('link'))
		expect(object).toMatchObject({ startY: 100, endY: 164 })
	})

	it('arrows that do not touch a moved shape are not rewritten', async () => {
		await act([rect('a', 0, 0), rect('b', 500, 0), rect('c', 0, 600), rect('d', 500, 600), { tool: 'connect_shapes', id: sid('ab'), fromId: sid('a'), toId: sid('b') }, { tool: 'connect_shapes', id: sid('cd'), fromId: sid('c'), toId: sid('d') }])
		// make the unrelated arrow visibly different from what a re-route would write
		getRoomHandle(f.boardId).room.storage.transaction((txn) => {
			const cd = record(sid('cd')) as any
			txn.set(sid('cd'), { ...cd, props: { ...cd.props, end: { x: cd.props.end.x + 77, y: cd.props.end.y } } } as never)
		})
		const untouched = JSON.stringify(record(sid('cd')))
		await act([{ tool: 'place_below', id: sid('b'), targetId: sid('a') }])
		expect(JSON.stringify(record(sid('cd')))).toBe(untouched)
		expect(endpoints(sid('ab')).ey).toBeCloseTo(164 + 0, 0)
	})
})

describe('layout actions on awkward geometry and on nothing at all', () => {
	it('moves a shape nested in a rotated container by its page-space delta', async () => {
		await act([rect('a', 0, 0, 200, 100)])
		getRoomHandle(f.boardId).room.storage.transaction((txn) => {
			const page = [...txn.values()].find((r) => (r as { typeName: string }).typeName === 'page') as { id: string }
			txn.set('shape:turned', { id: 'shape:turned', typeName: 'shape', type: 'frame', x: 1000, y: 1000, rotation: Math.PI / 2, index: 'a9', parentId: page.id, isLocked: false, opacity: 1, meta: {}, props: { w: 800, h: 600, name: 'F', color: 'black' } } as never)
			txn.set('shape:kid', { id: 'shape:kid', typeName: 'shape', type: 'geo', x: 50, y: 60, rotation: 0, index: 'a1', parentId: 'shape:turned', isLocked: false, opacity: 1, meta: {}, props: { geo: 'rectangle', w: 120, h: 80, growY: 0, color: 'black', labelColor: 'black', fill: 'none', dash: 'draw', size: 'm', font: 'draw', align: 'middle', verticalAlign: 'middle', richText: { type: 'doc', content: [{ type: 'paragraph' }] }, url: '', scale: 1, flipX: false, flipY: false } } as never)
		})
		const before = (await layout()).byId.get('shape:kid').bounds
		const response = await act([{ tool: 'place_below', id: 'shape:kid', targetId: sid('a') }])
		expect(response.statusCode, response.body).toBe(200)
		const after = (await layout()).byId.get('shape:kid').bounds
		// a quarter turn swaps width and height in page space, and the shape lands where it was asked to, not where an unrotated delta would put it
		expect(after.w).toBeCloseTo(before.w); expect(after.h).toBeCloseTo(before.h)
		expect(after.x).toBeCloseTo(0); expect(after.y).toBeCloseTo(100 + 64)
	})

	it('a layout action that moves nothing still verifies the shapes it named, in the request-level result too', async () => {
		await act([rect('a', 0, 0), rect('b', 400, 0), { tool: 'create_text', id: sid('t'), text: 'estimated\ntext', x: 0, y: 150 }])
		const response = await act([{ tool: 'align', ids: [sid('a'), sid('b')], axis: 'top' }])
		expect(response.statusCode, response.body).toBe(200)
		const result = response.json().layout
		expect(result.results[0].moved).toEqual([])
		expect(result.final.items.map((item: any) => item.id).sort()).toEqual([sid('a'), sid('b')])
	})
})

describe('compatibility', () => {
	it('requests without layout actions get the same response shape as before', async () => {
		const response = await act([rect('a', 0, 0)])
		expect(Object.keys(response.json()).sort()).toEqual(['applied', 'clock', 'pageId', 'roomId'])
	})

	it('an unknown layout option is rejected (strict schemas)', async () => {
		await act([rect('a', 0, 0), rect('b', 400, 0)])
		expect((await act([{ tool: 'place_below', id: sid('b'), targetId: sid('a'), sneaky: true }])).statusCode).toBe(422)
	})
})
