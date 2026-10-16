/**
 * `GET /api/rooms/:id/layout` and the browser measurement report, through the real application. Geometry itself is covered in
 * tests/layout-core.test.ts; this file is about what the API exposes, to whom, and what it will and will not trust.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getRoomHandle } from '../server/rooms'
import { createClient } from '../server/token-store.mjs'
import { layoutFingerprint } from '../shared/layout'
import { createAcceptanceFixture, type AcceptanceFixture } from './helpers/acceptance-fixture'

let f: AcceptanceFixture
let storeDirectory: string
let storeFile: string

const bearer = (token: string) => ({ authorization: `Bearer ${token}` })
const layoutUrl = (board = f.boardId, query = '') => `/api/rooms/${board}/layout${query}`
const actions = (board: string, list: unknown[]) => f.owner.post(`/api/rooms/${board}/actions`, { actions: list })
const sid = (name: string) => `shape:${name}`
const historyCount = () => (getRoomHandle(f.boardId).database.prepare('SELECT COUNT(*) AS n FROM history_events').get() as { n: number }).n

beforeEach(async () => {
	f = await createAcceptanceFixture()
	storeDirectory = mkdtempSync(join(tmpdir(), 'layout-api-store-'))
	storeFile = join(storeDirectory, 'api-tokens.json')
	process.env.CANVAS_API_TOKENS_FILE = storeFile
})

afterEach(async () => {
	await f.cleanup()
	rmSync(storeDirectory, { recursive: true, force: true })
})

async function seedBoard() {
	const response = await actions(f.boardId, [
		{ tool: 'create_shape', id: sid('a'), type: 'rectangle', text: 'Alpha', x: 100, y: 100, width: 300, height: 120 },
		{ tool: 'create_shape', id: sid('b'), type: 'ellipse', text: 'Beta', x: 600, y: 100, width: 200, height: 120 },
		{ tool: 'create_text', id: sid('note'), text: 'line one\nline two\nline three', x: 100, y: 400 },
		{ tool: 'connect_shapes', id: sid('link'), fromId: sid('a'), toId: sid('b') },
	])
	expect(response.statusCode, response.body).toBe(200)
}

/** Writes a frame with a child straight into the board's store: the API cannot create frames, but people can. */
function addFrameWithChild() {
	const { room } = getRoomHandle(f.boardId)
	room.storage.transaction((txn) => {
		const page = [...txn.values()].find((r) => (r as { typeName: string }).typeName === 'page') as { id: string }
		txn.set('shape:frame1', { id: 'shape:frame1', typeName: 'shape', type: 'frame', x: 1000, y: 1000, rotation: 0, index: 'a9', parentId: page.id, isLocked: false, opacity: 1, meta: {}, props: { w: 800, h: 600, name: 'F', color: 'black' } } as never)
		txn.set('shape:inner', { id: 'shape:inner', typeName: 'shape', type: 'geo', x: 50, y: 60, rotation: 0, index: 'a1', parentId: 'shape:frame1', isLocked: false, opacity: 1, meta: {}, props: { geo: 'rectangle', w: 120, h: 80, growY: 0, color: 'black', labelColor: 'black', fill: 'none', dash: 'draw', size: 'm', font: 'draw', align: 'middle', verticalAlign: 'middle', richText: { type: 'doc', content: [{ type: 'paragraph' }] }, url: '', scale: 1, flipX: false, flipY: false } } as never)
	})
}

describe('GET /api/rooms/:id/layout', () => {
	it('returns page-space bounds with the authority of each, and no text or props', async () => {
		await seedBoard()
		const response = await f.owner.get(layoutUrl())
		expect(response.statusCode, response.body).toBe(200)
		const body = response.json()
		expect(body).toMatchObject({ roomId: f.boardId, gap: 64 })
		expect(body.pageId).toMatch(/^page:/)
		const byId = new Map<string, any>(body.shapes.map((shape: any) => [shape.id, shape]))
		expect(byId.get(sid('a'))).toMatchObject({ type: 'geo', bounds: { x: 100, y: 100, w: 300, h: 120 }, boundsSource: 'declared', verification: 'verified', rotation: 0, parentId: body.pageId })
		expect(byId.get(sid('note'))).toMatchObject({ type: 'text', boundsSource: 'estimated', verification: 'unverified' })
		expect(byId.get(sid('note')).bounds.h).toBeGreaterThanOrEqual(3 * 32.4 - 1)
		expect(JSON.stringify(body)).not.toMatch(/Alpha|line one|richText|props/)
		expect(body.counts).toMatchObject({ shapes: 4, declared: 3, estimated: 1, measured: 0, unverified: 1 })
		expect(body.bounds).toMatchObject({ x: 100, y: 100 })
		expect(typeof body.clock).toBe('number')
		expect(response.headers['cache-control']).toBe('no-store')
	})

	it('describes an API-drawn arrow by its endpoints and the boxes it connects', async () => {
		await seedBoard()
		const arrow = (await f.owner.get(layoutUrl())).json().shapes.find((shape: any) => shape.id === sid('link'))
		expect(arrow.arrow).toMatchObject({ managed: true, connection: { fromId: sid('a'), toId: sid('b') } })
		expect(arrow.arrow.start.x).toBeCloseTo(400)
		expect(arrow.arrow.end.x).toBeLessThan(620)
	})

	it('includes shapes nested in a frame, at page-space coordinates with their parent', async () => {
		await seedBoard()
		addFrameWithChild()
		const body = (await f.owner.get(layoutUrl())).json()
		const inner = body.shapes.find((shape: any) => shape.id === 'shape:inner')
		expect(inner).toMatchObject({ parentId: 'shape:frame1', bounds: { x: 1050, y: 1060, w: 120, h: 80 } })
		expect(body.shapes.find((shape: any) => shape.id === 'shape:frame1').bounds).toMatchObject({ x: 1000, y: 1000, w: 800, h: 600 })
		// paint order puts the child after its frame
		expect(inner.zIndex).toBeGreaterThan(body.shapes.find((shape: any) => shape.id === 'shape:frame1').zIndex)
		// whereas the older canvas read still hides it, which is exactly why this endpoint exists
		expect((await f.owner.get(`/api/rooms/${f.boardId}/canvas`)).json().objects.map((o: any) => o.id)).not.toContain('shape:inner')
	})

	it('narrows by ids and types, and refuses malformed filters', async () => {
		await seedBoard()
		const only = (await f.owner.get(layoutUrl(f.boardId, `?ids=${sid('a')},${sid('b')}`))).json()
		expect(only.shapes.map((shape: any) => shape.id).sort()).toEqual([sid('a'), sid('b')])
		const arrows = (await f.owner.get(layoutUrl(f.boardId, '?types=arrow'))).json()
		expect(arrows.shapes.map((shape: any) => shape.type)).toEqual(['arrow'])
		expect((await f.owner.get(layoutUrl(f.boardId, '?ids=not-a-shape-id'))).statusCode).toBe(400)
		expect((await f.owner.get(layoutUrl(f.boardId, '?types=Bad%20Type'))).statusCode).toBe(400)
		expect((await f.owner.get(layoutUrl(f.boardId, '?pageId=page:nope'))).statusCode).toBe(404)
	})

	it('answers an empty board with a null extent', async () => {
		const body = (await f.owner.get(layoutUrl())).json()
		expect(body.shapes).toEqual([])
		expect(body.bounds).toBeNull()
	})
})

describe('who may read the layout', () => {
	it('a read-scope machine token can; a write-only token and an unrelated board cannot; nor can anonymous callers', async () => {
		await seedBoard()
		const reader = await createClient({ file: storeFile, name: 'layout-reader', rooms: [f.boardId], access: 'read' })
		const writer = await createClient({ file: storeFile, name: 'layout-writer', rooms: [f.boardId], access: 'write' })
		const other = await createClient({ file: storeFile, name: 'layout-other', rooms: ['some-other-board'], access: 'read' })
		expect((await f.app.inject({ method: 'GET', url: layoutUrl(), headers: bearer(reader.token) })).statusCode).toBe(200)
		expect([401, 403]).toContain((await f.app.inject({ method: 'GET', url: layoutUrl(), headers: bearer(writer.token) })).statusCode)
		expect((await f.app.inject({ method: 'GET', url: layoutUrl(), headers: bearer(other.token) })).statusCode).toBe(401)
		expect((await f.anonymous.get(layoutUrl())).statusCode).toBe(401)
		expect((await f.nonmember.get(layoutUrl())).statusCode).toBe(404)
	})

	it('every human role that can open the board can read it, and a machine token cannot reach another board\'s layout', async () => {
		await seedBoard()
		for (const identity of [f.owner, f.editor, f.viewer]) expect((await identity.get(layoutUrl())).statusCode, identity.role).toBe(200)
		const reader = await createClient({ file: storeFile, name: 'layout-reader-2', rooms: [f.boardId], access: 'read' })
		const created = await f.owner.post('/api/boards', { name: 'Another' })
		const otherBoard = created.json().board.id as string
		expect((await f.app.inject({ method: 'GET', url: layoutUrl(otherBoard), headers: bearer(reader.token) })).statusCode).toBe(401)
	})
})

describe('POST /api/boards/:id/layout-measurements', () => {
	async function textShape() {
		await actions(f.boardId, [{ tool: 'create_text', id: sid('t'), text: 'measure me', x: 0, y: 0 }])
		const snapshot = getRoomHandle(f.boardId).room.getCurrentSnapshot().documents.map((d) => d.state) as Array<{ id: string; type?: string; props?: Record<string, unknown> }>
		return snapshot.find((record) => record.id === sid('t')) as { id: string; type: string; props: Record<string, unknown> }
	}
	const report = (shape: { id: string; type: string; props: Record<string, unknown> }, w = 321, h = 77, fp = layoutFingerprint(shape)) => ({ measurements: [{ id: shape.id, w, h, fp }] })

	it('lets an editor report a size, which upgrades the shape to measured and verified', async () => {
		const shape = await textShape()
		const before = (await f.owner.get(layoutUrl())).json().shapes.find((s: any) => s.id === sid('t'))
		expect(before.boundsSource).toBe('estimated')
		const response = await f.editor.post(`/api/boards/${f.boardId}/layout-measurements`, report(shape))
		expect(response.statusCode, response.body).toBe(200)
		expect(response.json()).toEqual({ accepted: 1, stale: 0, ignored: 0 })
		const after = (await f.owner.get(layoutUrl())).json().shapes.find((s: any) => s.id === sid('t'))
		expect(after).toMatchObject({ boundsSource: 'measured', verification: 'verified', bounds: { w: 321, h: 77 } })
	})

	it('is not a board change: no history event, no document clock movement', async () => {
		const shape = await textShape()
		const clock = (await f.owner.get(layoutUrl())).json().clock
		const events = historyCount()
		await f.owner.post(`/api/boards/${f.boardId}/layout-measurements`, report(shape))
		expect(historyCount()).toBe(events)
		expect((await f.owner.get(layoutUrl())).json().clock).toBe(clock)
	})

	it('refuses a measurement of content that has since changed, and does not trust it afterwards', async () => {
		const shape = await textShape()
		const stale = report(shape, 999, 999, '0000000000000000')
		const response = await f.owner.post(`/api/boards/${f.boardId}/layout-measurements`, stale)
		expect(response.json()).toEqual({ accepted: 0, stale: 1, ignored: 0 })
		expect((await f.owner.get(layoutUrl())).json().shapes.find((s: any) => s.id === sid('t')).boundsSource).toBe('estimated')
		// accept once, then edit the text: the measurement stops applying
		await f.owner.post(`/api/boards/${f.boardId}/layout-measurements`, report(shape))
		await actions(f.boardId, [{ tool: 'update_text', id: sid('t'), text: 'a completely different, longer text' }])
		const entry = (await f.owner.get(layoutUrl())).json().shapes.find((s: any) => s.id === sid('t'))
		expect(entry).toMatchObject({ boundsSource: 'estimated', measurementStale: true, verification: 'unverified' })
	})

	it('ignores shapes that do not exist or whose size is not measured, and bad values are rejected', async () => {
		await seedBoard()
		const fake = { id: sid('ghost'), w: 10, h: 10, fp: '0123456789abcdef' }
		const geo = { id: sid('a'), w: 10, h: 10, fp: '0123456789abcdef' }
		expect((await f.owner.post(`/api/boards/${f.boardId}/layout-measurements`, { measurements: [fake, geo] })).json()).toEqual({ accepted: 0, stale: 0, ignored: 2 })
		for (const bad of [{ measurements: [] }, { measurements: [{ id: 'nope', w: 1, h: 1, fp: '0123456789abcdef' }] }, { measurements: [{ id: sid('a'), w: -5, h: 1, fp: '0123456789abcdef' }] }, { measurements: [{ id: sid('a'), w: 1, h: 1, fp: 'short' }] }, { measurements: [{ id: sid('a'), w: 1, h: 1, fp: '0123456789abcdef', extra: 1 }] }, { other: 1 }]) {
			expect([400, 422]).toContain((await f.owner.post(`/api/boards/${f.boardId}/layout-measurements`, bad)).statusCode)
		}
	})

	it('is for people who can edit: viewers, non-members, anonymous callers and machine tokens are all refused', async () => {
		const shape = await textShape()
		const writer = await createClient({ file: storeFile, name: 'layout-writer-2', rooms: [f.boardId], access: 'full' })
		expect((await f.viewer.post(`/api/boards/${f.boardId}/layout-measurements`, report(shape))).statusCode).toBe(403)
		expect((await f.nonmember.post(`/api/boards/${f.boardId}/layout-measurements`, report(shape))).statusCode).toBe(404)
		expect((await f.anonymous.post(`/api/boards/${f.boardId}/layout-measurements`, report(shape))).statusCode).toBe(401)
		const viaToken = await f.app.inject({ method: 'POST', url: `/api/boards/${f.boardId}/layout-measurements`, headers: bearer(writer.token), payload: report(shape) })
		expect([401, 403]).toContain(viaToken.statusCode)
		expect((await f.owner.get(layoutUrl())).json().shapes.find((s: any) => s.id === sid('t')).boundsSource).toBe('estimated')
	})

	it('is rate limited per user and board', async () => {
		await f.cleanup()
		f = await createAcceptanceFixture({ rateLimits: { layoutReport: { limit: 2, windowMs: 60_000 } } })
		process.env.CANVAS_API_TOKENS_FILE = storeFile
		const shape = await textShape()
		const statuses: number[] = []
		for (let i = 0; i < 3; i += 1) statuses.push((await f.owner.post(`/api/boards/${f.boardId}/layout-measurements`, report(shape))).statusCode)
		expect(statuses).toEqual([200, 200, 429])
		expect((await f.editor.post(`/api/boards/${f.boardId}/layout-measurements`, report(shape))).statusCode).toBe(200)
	})

	it('drops measurements of shapes that no longer exist', async () => {
		const shape = await textShape()
		await f.owner.post(`/api/boards/${f.boardId}/layout-measurements`, report(shape))
		const db = getRoomHandle(f.boardId).database
		expect((db.prepare('SELECT COUNT(*) AS n FROM layout_measurements').get() as { n: number }).n).toBe(1)
		await actions(f.boardId, [{ tool: 'delete_shape', id: sid('t') }])
		await actions(f.boardId, [{ tool: 'create_text', id: sid('t2'), text: 'other', x: 0, y: 500 }])
		const other = getRoomHandle(f.boardId).room.getCurrentSnapshot().documents.map((d) => d.state).find((r) => (r as { id: string }).id === sid('t2')) as { id: string; type: string; props: Record<string, unknown> }
		await f.owner.post(`/api/boards/${f.boardId}/layout-measurements`, report(other))
		expect((db.prepare('SELECT shape_id AS id FROM layout_measurements').all() as Array<{ id: string }>).map((row) => row.id)).toEqual([sid('t2')])
	})
})
