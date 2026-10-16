/**
 * What the layout feature does to a board's durable state: the room-database migration, history, reload and restore.
 * (Geometry is in layout-core, the API in layout-api and layout-actions.)
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeAllRooms, getRoomHandle, restoreRoomVersion } from '../server/rooms'
import { migrateHistoryDatabase } from '../server/history'
import { createClient } from '../server/token-store.mjs'
import { createAcceptanceFixture, type AcceptanceFixture } from './helpers/acceptance-fixture'

let f: AcceptanceFixture
let storeDirectory: string
let storeFile: string

const sid = (name: string) => `shape:${name}`
const act = (list: unknown[]) => f.owner.post(`/api/rooms/${f.boardId}/actions`, { actions: list })
const rect = (name: string, x: number, y: number) => ({ tool: 'create_shape', id: sid(name), type: 'rectangle', text: name, x, y, width: 200, height: 100 })
const db = () => getRoomHandle(f.boardId).database
const events = () => (db().prepare('SELECT COUNT(*) AS n FROM history_events').get() as { n: number }).n
const clock = async () => (await f.owner.get(`/api/rooms/${f.boardId}/layout`)).json().clock as number
const ledger = () => (db().prepare('SELECT migration_id AS id FROM app_schema_migrations ORDER BY rowid').all() as Array<{ id: string }>).map((row) => row.id)
const records = () => getRoomHandle(f.boardId).room.getCurrentSnapshot().documents.map((d) => d.state) as Array<{ id: string; typeName: string; fromId?: string; toId?: string }>
const bindings = () => records().filter((r) => r.typeName === 'binding')

beforeEach(async () => {
	f = await createAcceptanceFixture()
	storeDirectory = mkdtempSync(join(tmpdir(), 'layout-lifecycle-store-'))
	storeFile = join(storeDirectory, 'api-tokens.json')
	process.env.CANVAS_API_TOKENS_FILE = storeFile
})

afterEach(async () => {
	await f.cleanup()
	rmSync(storeDirectory, { recursive: true, force: true })
})

describe('the measurements table migration', () => {
	it('is ledgered, deterministic across boards, and idempotent across reopen and re-running', async () => {
		const first = ledger()
		expect(first).toContain('layout:0001-measurements')
		expect(first.at(-1)).toBe('layout:0001-measurements')
		expect(new Set(first).size).toBe(first.length)
		const other = (await f.owner.post('/api/boards', { name: 'Second board' })).json().board.id as string
		const second = (getRoomHandle(other).database.prepare('SELECT migration_id AS id FROM app_schema_migrations ORDER BY rowid').all() as Array<{ id: string }>).map((row) => row.id)
		expect(second).toEqual(first)

		migrateHistoryDatabase(db())
		migrateHistoryDatabase(db())
		expect(ledger()).toEqual(first)
		closeAllRooms()
		expect(ledger()).toEqual(first)
		const columns = (db().prepare("SELECT name FROM pragma_table_info('layout_measurements') ORDER BY cid").all() as Array<{ name: string }>).map((row) => row.name)
		expect(columns).toEqual(['shape_id', 'w', 'h', 'fp', 'reported_at', 'reported_by'])
	})

	it('adds a table and nothing else: no existing table gains or loses a column', () => {
		const tables = (db().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name)
		expect(tables).toContain('layout_measurements')
		const history = (db().prepare("SELECT name FROM pragma_table_info('history_events') ORDER BY cid").all() as Array<{ name: string }>).map((row) => row.name)
		expect(history).toEqual(['id', 'board_id', 'actor_user_id', 'session_id', 'event_type', 'entity_type', 'entity_id', 'source', 'created_at', 'metadata_json', 'changes_json', 'document_clock'])
	})
})

describe('reads and reports are not board changes; layout actions are', () => {
	it('reading the layout, however often, writes no history and does not move the document clock', async () => {
		await act([rect('a', 0, 0), rect('b', 500, 0)])
		const before = { events: events(), clock: await clock() }
		for (let i = 0; i < 3; i += 1) {
			expect((await f.owner.get(`/api/rooms/${f.boardId}/layout`)).statusCode).toBe(200)
			expect((await f.owner.get(`/api/rooms/${f.boardId}/layout?types=geo`)).statusCode).toBe(200)
		}
		expect({ events: events(), clock: await clock() }).toEqual(before)
	})

	it('a layout action by an agent is recorded as an AI change attributed to that agent, with the moved shape in it', async () => {
		await act([rect('a', 0, 0), rect('b', 900, 900)])
		const agent = await createClient({ file: storeFile, name: 'lifecycle-agent', rooms: [f.boardId], access: 'full' })
		const before = events()
		const response = await f.app.inject({ method: 'POST', url: `/api/rooms/${f.boardId}/actions`, headers: { authorization: `Bearer ${agent.token}` }, payload: { actions: [{ tool: 'place_below', id: sid('b'), targetId: sid('a') }] } })
		expect(response.statusCode, response.body).toBe(200)
		expect(events()).toBeGreaterThan(before)
		const row = db().prepare('SELECT source, actor_user_id AS actor, changes_json AS changes FROM history_events ORDER BY id DESC LIMIT 1').get() as { source: string; actor: string | null; changes: string }
		expect(row.source).toBe('ai')
		expect(row.actor).toContain('lifecycle-agent')
		expect(row.changes).toContain(sid('b'))
		// and the same fact through the history API a person would open
		const listed = (await f.owner.get(`/api/boards/${f.boardId}/history`)).json()
		expect(JSON.stringify(listed)).toContain('"ai"')
	})
})

describe('genuine arrow bindings are ordinary durable records', () => {
	it('survive closing and reopening the room, and the arrow is still reported as bound', async () => {
		await act([rect('a', 0, 0), rect('b', 500, 0), { tool: 'connect_shapes', id: sid('link'), fromId: sid('a'), toId: sid('b') }])
		const before = bindings().map((b) => JSON.stringify(b)).sort()
		expect(before).toHaveLength(2)
		closeAllRooms()
		expect(bindings().map((b) => JSON.stringify(b)).sort()).toEqual(before)
		const arrow = (await f.owner.get(`/api/rooms/${f.boardId}/layout?types=arrow`)).json().shapes[0]
		expect(arrow.arrow).toMatchObject({ startBoundTo: sid('a'), endBoundTo: sid('b'), connection: { fromId: sid('a'), toId: sid('b') } })
	})

	it('are brought back by a restore to a moment before their shape was deleted, and removed again by deleting it', async () => {
		await act([rect('a', 0, 0), rect('b', 500, 0), { tool: 'connect_shapes', id: sid('link'), fromId: sid('a'), toId: sid('b') }])
		const handle = getRoomHandle(f.boardId)
		handle.recorder.flush()
		const target = (handle.database.prepare('SELECT MAX(id) AS id FROM history_events').get() as { id: number }).id
		expect(await act([{ tool: 'delete_shape', id: sid('b') }])).toMatchObject({ statusCode: 200 })
		expect(bindings().every((b) => b.toId !== sid('b'))).toBe(true)
		expect(bindings()).toHaveLength(1)
		handle.recorder.flush()
		const restored = restoreRoomVersion(handle, { eventId: target, expectedClock: handle.storage.getClock(), userId: 'owner', displayName: 'Owner' })
		expect(restored.clock).toBeGreaterThan(0)
		expect(bindings()).toHaveLength(2)
		expect(records().map((r) => r.id)).toContain(sid('b'))
		// restoring made a new head, so deleting again cleans up exactly as before
		await act([{ tool: 'delete_shape', id: sid('a') }])
		expect(bindings().every((b) => b.toId !== sid('a') && b.fromId !== sid('a'))).toBe(true)
	})
})
