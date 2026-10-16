/**
 * Machine board creation: `POST /api/agent-boards` (server/agent-boards.ts), the board-creating credential that
 * authorises it (token store `accountClients`), and the owner-only management of those credentials.
 *
 * These run the real application (buildApp) against a disposable data directory and token store, and check what a
 * machine can then do with the same reader (authorizeApiToken) and the same board routes the production API uses.
 */

import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { z } from 'zod'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccessVerifier } from '../server/access-jwt'
import { buildApp } from '../server/app'
import { createAccountClient, createClient } from '../server/token-store.mjs'
import { authenticateBoardCreator, authorizeApiToken } from '../server/tokens'
import { createAcceptanceFixture, type AcceptanceFixture } from './helpers/acceptance-fixture'

let f: AcceptanceFixture
let storeDirectory: string
let storeFile: string

const BOARDS = '/api/agent-boards'
const ACCESS = '/api/agent-access'
const bearer = (token: string) => `Bearer ${token}`
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
const storeBytes = () => readFileSync(storeFile, 'utf8')
const store = () => JSON.parse(storeBytes()) as { clients: Array<Record<string, unknown>>; accountClients?: Array<Record<string, any>>; [key: string]: unknown }
const backupCount = () => readdirSync(storeDirectory).filter((name) => name.endsWith('.bak')).length
const FAILPOINT = 'CANVAS_API_TOKENS_TEST_FAILPOINT'
const createTask = (id: string) => ({ actions: [{ tool: 'create_entity', id: `engineering_entity:${id}`, entityType: 'task', title: `Task ${id}` }] })

function seed(contents: unknown): void {
	writeFileSync(storeFile, `${JSON.stringify(contents, null, 2)}\n`, { mode: 0o600 })
}

function database(readonly = true) {
	return new Database(join(f.directory, 'auth.sqlite'), { readonly })
}

function rows<T = Record<string, any>>(sql: string, ...params: unknown[]): T[] {
	const db = database()
	try {
		return db.prepare(sql).all(...params) as T[]
	} finally {
		db.close()
	}
}

const boardCount = () => (rows<{ n: number }>('SELECT COUNT(*) AS n FROM boards')[0]).n
const eventsOf = (...types: string[]) =>
	rows<{ type: string; actor_user_id: string | null; subject_user_id: string | null; board_id: string | null; metadata_json: string }>(
		`SELECT type, actor_user_id, subject_user_id, board_id, metadata_json FROM account_events WHERE type IN (${types.map(() => '?').join(',')}) ORDER BY id`,
		...types,
	)

/** Registers a board-creating credential through the owner-only route, exactly as the Agents page does. */
async function makeCreator(identity = f.owner, extra: Record<string, unknown> = {}) {
	const response = await identity.post(ACCESS, { kind: 'board-creator', displayName: 'Planner', access: 'read-write-history', ...extra })
	expect(response.statusCode, response.body).toBe(201)
	return response.json() as { agent: { ref: string; name: string; [key: string]: unknown }; token: string }
}

const createBoard = (token: string, name = 'Project one', headers: Record<string, string> = {}, payload: unknown = { name }) =>
	f.app.inject({ method: 'POST', url: BOARDS, headers: { authorization: bearer(token), ...headers }, payload: payload as never })

async function freshFixture(rateLimits?: Parameters<typeof createAcceptanceFixture>[0] extends infer O ? (O extends { rateLimits?: infer R } ? R : never) : never) {
	await f.cleanup()
	f = await createAcceptanceFixture({ rateLimits })
	process.env.CANVAS_API_TOKENS_FILE = storeFile
}

beforeEach(async () => {
	f = await createAcceptanceFixture()
	storeDirectory = mkdtempSync(join(tmpdir(), 'agent-boards-store-'))
	storeFile = join(storeDirectory, 'api-tokens.json')
	process.env.CANVAS_API_TOKENS_FILE = storeFile
})

afterEach(async () => {
	delete process.env[FAILPOINT]
	await f.cleanup()
	rmSync(storeDirectory, { recursive: true, force: true })
})

describe('who may create a board', () => {
	it('refuses a request with no bearer, a made-up bearer or a malformed one: 401, and creates nothing', async () => {
		await makeCreator()
		const before = boardCount()
		expect((await f.app.inject({ method: 'POST', url: BOARDS, payload: { name: 'x' } })).statusCode).toBe(401)
		expect((await createBoard('z'.repeat(43))).statusCode).toBe(401)
		expect((await f.app.inject({ method: 'POST', url: BOARDS, headers: { authorization: 'Bearer short' }, payload: { name: 'x' } })).statusCode).toBe(401)
		expect(boardCount()).toBe(before)
	})

	it('refuses an ordinary board-scoped token with 403, however many permissions it holds', async () => {
		const plain = await createClient({ file: storeFile, name: 'plain-full', rooms: [f.boardId], access: 'full' })
		const before = boardCount()
		const bytes = storeBytes()
		const response = await createBoard(plain.token)
		expect(response.statusCode).toBe(403)
		expect(boardCount()).toBe(before)
		expect(storeBytes()).toBe(bytes)
	})

	it('creates a board for a board-creating credential', async () => {
		const { token } = await makeCreator()
		const response = await createBoard(token, 'Project one')
		expect(response.statusCode, response.body).toBe(201)
		const body = response.json() as Record<string, unknown>
		expect(Object.keys(body).sort()).toEqual(['boardId', 'name', 'url'])
		expect(body.name).toBe('Project one')
		expect(body.url).toBe(`/room/${body.boardId}`)
		expect(response.headers['cache-control']).toBe('no-store')
		// No new secret: nothing in the response is a token.
		expect(response.body).not.toMatch(/[A-Za-z0-9_-]{43}/)
	})

	it('refuses an expired credential like an unknown one, and refuses nothing about whether it ever existed', async () => {
		const owner = f.owner.userId!
		const expired = await createAccountClient({
			file: storeFile, name: 'expired-creator', ownerUserId: owner, access: 'read',
			now: new Date(Date.now() - 7_200_000), expiresAt: new Date(Date.now() - 3_600_000),
		})
		const before = boardCount()
		const response = await createBoard(expired.token)
		expect(response.statusCode).toBe(401)
		expect(response.body).toBe((await createBoard('q'.repeat(43))).body)
		expect(boardCount()).toBe(before)
		expect(authenticateBoardCreator(bearer(expired.token))).toEqual({ kind: 'unauthenticated' })
	})

	it('stops honouring a credential the moment it expires, including for the boards it already made', async () => {
		const { token } = await makeCreator()
		const board = (await createBoard(token)).json().boardId as string
		expect((await f.app.inject({ method: 'GET', url: `/api/rooms/${board}/canvas`, headers: { authorization: bearer(token) } })).statusCode).toBe(200)
		const data = store()
		data.accountClients![0].expiresAt = new Date(Date.now() - 1_000).toISOString()
		seed(data)
		expect((await f.app.inject({ method: 'GET', url: `/api/rooms/${board}/canvas`, headers: { authorization: bearer(token) } })).statusCode).toBe(401)
		expect((await createBoard(token)).statusCode).toBe(401)
	})

	it('does not accept a human session in place of the machine credential', async () => {
		await makeCreator()
		const before = boardCount()
		expect((await f.owner.post(BOARDS, { name: 'by cookie' })).statusCode).toBe(401)
		expect((await f.owner.request('GET', BOARDS)).statusCode).toBe(404)
		expect(boardCount()).toBe(before)
	})

	it('ignores a session cookie sent next to a valid bearer: the board belongs to the credential\'s owner, not the cookie\'s user', async () => {
		const { token } = await makeCreator(f.owner)
		const response = await f.nonmember.request('POST', BOARDS, { name: 'cookie must not matter' }, { authorization: bearer(token) })
		expect(response.statusCode, response.body).toBe(201)
		const boardId = response.json().boardId as string
		expect((await f.owner.get(`/api/boards/${boardId}`)).json().board.role).toBe('owner')
		expect((await f.nonmember.get(`/api/boards/${boardId}`)).statusCode).toBe(404)
	})

	it('keeps the human /api/boards route cookie-only: a creator\'s bearer buys nothing there', async () => {
		const { token } = await makeCreator()
		const before = boardCount()
		const response = await f.app.inject({ method: 'POST', url: '/api/boards', headers: { authorization: bearer(token) }, payload: { name: 'sneaky' } })
		expect([401, 403]).toContain(response.statusCode)
		expect(boardCount()).toBe(before)
	})
})

describe('what a created board gives the agent, and what it does not', () => {
	it('makes the board belong to the configured human owner and records exactly that board on the credential', async () => {
		const { token, agent } = await makeCreator()
		const boardId = (await createBoard(token, 'Mine')).json().boardId as string
		const [board] = rows<{ owner_user_id: string; name: string; deleted_at: string | null }>('SELECT owner_user_id, name, deleted_at FROM boards WHERE id = ?', boardId)
		expect(board).toMatchObject({ owner_user_id: f.owner.userId, name: 'Mine', deleted_at: null })
		expect(rows<{ role: string }>('SELECT role FROM board_members WHERE board_id = ? AND user_id = ?', boardId, f.owner.userId)[0].role).toBe('owner')
		expect(rows('SELECT 1 FROM board_members WHERE board_id = ?', boardId)).toHaveLength(1) // the agent is never a member
		const record = store().accountClients!.find((client) => client.name === agent.name)!
		expect(record.rooms).toEqual([boardId])
	})

	it('lets the same bearer use the new board straight away, with the configured permissions and no others', async () => {
		const { token } = await makeCreator(f.owner, { access: 'read-write-history' })
		const boardId = (await createBoard(token)).json().boardId as string
		const headers = { authorization: bearer(token) }
		expect(authorizeApiToken(bearer(token), boardId, 'read')).not.toBeNull()
		expect((await f.app.inject({ method: 'GET', url: `/api/rooms/${boardId}/canvas`, headers })).statusCode).toBe(200)
		expect((await f.app.inject({ method: 'POST', url: `/api/rooms/${boardId}/actions`, headers, payload: createTask('one') })).statusCode).toBe(200)
		expect((await f.app.inject({ method: 'GET', url: `/api/boards/${boardId}/history`, headers })).statusCode).toBe(200)
		// read, write and history: but never restore. (A bearer without the scope is answered as unauthenticated.)
		expect(authorizeApiToken(bearer(token), boardId, 'restore')).toBeNull()
		expect([401, 403]).toContain((await f.app.inject({ method: 'POST', url: `/api/boards/${boardId}/restore`, headers, payload: {} })).statusCode)
	})

	it('a read-only creator can read what it made but not change it', async () => {
		const { token } = await makeCreator(f.owner, { access: 'read' })
		const boardId = (await createBoard(token)).json().boardId as string
		const headers = { authorization: bearer(token) }
		expect((await f.app.inject({ method: 'GET', url: `/api/rooms/${boardId}/canvas`, headers })).statusCode).toBe(200)
		expect((await f.app.inject({ method: 'POST', url: `/api/rooms/${boardId}/actions`, headers, payload: createTask('two') })).statusCode).toBe(403)
	})

	it('gives no access to any board that existed before, including the owner\'s own', async () => {
		const { token } = await makeCreator()
		await createBoard(token)
		const headers = { authorization: bearer(token) }
		for (const url of [`/api/rooms/${f.boardId}/canvas`, `/api/boards/${f.boardId}/history`, `/api/rooms/${f.boardId}/semantic-context`]) {
			expect((await f.app.inject({ method: 'GET', url, headers })).statusCode, url).toBe(401)
		}
		expect((await f.app.inject({ method: 'POST', url: `/api/rooms/${f.boardId}/actions`, headers, payload: createTask('no') })).statusCode).toBe(401)
		expect(authorizeApiToken(bearer(token), f.boardId, 'read')).toBeNull()
	})

	it('has no access at all before the first board exists', async () => {
		const { token } = await makeCreator()
		expect(store().accountClients![0].rooms).toEqual([])
		expect((await f.app.inject({ method: 'GET', url: `/api/rooms/${f.boardId}/canvas`, headers: { authorization: bearer(token) } })).statusCode).toBe(401)
	})

	it('treats a board the owner has since deleted as dead to the agent', async () => {
		const { token } = await makeCreator()
		const boardId = (await createBoard(token)).json().boardId as string
		expect((await f.owner.delete(`/api/boards/${boardId}`)).statusCode).toBe(200)
		expect((await f.app.inject({ method: 'GET', url: `/api/rooms/${boardId}/canvas`, headers: { authorization: bearer(token) } })).statusCode).toBe(404)
	})

	it('keeps credentials apart: one creator\'s boards are invisible to another', async () => {
		const first = await makeCreator()
		const second = await makeCreator(f.owner, { displayName: 'Second' })
		const board = (await createBoard(first.token)).json().boardId as string
		expect((await f.app.inject({ method: 'GET', url: `/api/rooms/${board}/canvas`, headers: { authorization: bearer(second.token) } })).statusCode).toBe(401)
	})
})

describe('the request body', () => {
	it('is strict: a name and nothing else, and never a client-chosen board id', async () => {
		const { token } = await makeCreator()
		const before = boardCount()
		for (const payload of [{ name: 'x', id: 'chosen-id' }, { name: 'x', extra: true }, {}, { name: '' }, { name: 'a'.repeat(121) }, { name: 5 }, []]) {
			const response = await createBoard(token, 'x', {}, payload)
			expect([400, 422], JSON.stringify(payload)).toContain(response.statusCode)
		}
		expect(boardCount()).toBe(before)
		expect(store().accountClients![0].rooms).toEqual([])
	})

	it('applies the human route\'s name rules: a name that is only whitespace is refused, with nothing created or granted', async () => {
		const { token } = await makeCreator()
		const before = boardCount()
		const bytes = storeBytes()
		const response = await createBoard(token, '   ')
		expect(response.statusCode).toBe(400)
		expect(boardCount()).toBe(before)
		expect(storeBytes()).toBe(bytes)
	})
})

describe('limits', () => {
	it('allows 10 creations per credential per window by default, then 429', async () => {
		const { token } = await makeCreator()
		const statuses: number[] = []
		for (let index = 0; index < 11; index += 1) statuses.push((await createBoard(token, `Board ${index}`)).statusCode)
		expect(statuses.slice(0, 10)).toEqual(Array(10).fill(201))
		expect(statuses[10]).toBe(429)
		expect(store().accountClients![0].rooms).toHaveLength(10)
	})

	it('counts per credential: a second credential of the same owner is not held back by the first', async () => {
		await freshFixture({ agentBoardCredential: { limit: 2, windowMs: 60_000 } })
		const one = await makeCreator()
		const two = await makeCreator(f.owner, { displayName: 'Two' })
		expect((await createBoard(one.token)).statusCode).toBe(201)
		expect((await createBoard(one.token)).statusCode).toBe(201)
		expect((await createBoard(one.token)).statusCode).toBe(429)
		expect((await createBoard(two.token)).statusCode).toBe(201)
	})

	it('also counts per owner across credentials, and a refusal there does not spend the credential\'s own budget', async () => {
		await freshFixture({ agentBoardCredential: { limit: 3, windowMs: 60_000 }, agentBoardOwner: { limit: 3, windowMs: 60_000 } })
		const one = await makeCreator()
		const two = await makeCreator(f.owner, { displayName: 'Two' })
		expect((await createBoard(one.token)).statusCode).toBe(201)
		expect((await createBoard(two.token)).statusCode).toBe(201)
		expect((await createBoard(two.token)).statusCode).toBe(201)
		const refused = await createBoard(one.token)
		expect(refused.statusCode).toBe(429)
		expect(refused.headers['retry-after']).toBeDefined()
		// Another owner is untouched by this owner's budget.
		const other = await makeCreator(f.nonmember, { displayName: 'Other owner' })
		expect((await createBoard(other.token)).statusCode).toBe(201)
	})

	it('a refusal by the owner\'s budget does not spend the credential\'s own budget', async () => {
		await freshFixture({ agentBoardCredential: { limit: 2, windowMs: 60_000 }, agentBoardOwner: { limit: 2, windowMs: 60_000 } })
		const a = await makeCreator(f.owner, { displayName: 'A' })
		const b = await makeCreator(f.owner, { displayName: 'B' })
		vi.useFakeTimers({ toFake: ['Date'] })
		try {
			const start = Date.now()
			expect((await createBoard(a.token)).statusCode).toBe(201) // credential A: 1 of 2, owner: 1 of 2
			expect((await createBoard(b.token)).statusCode).toBe(201) // owner: 2 of 2
			vi.setSystemTime(start + 30_000)
			expect((await createBoard(a.token)).statusCode).toBe(429) // refused by the OWNER budget
			vi.setSystemTime(start + 61_000) // the first two creations have left the window
			// A was refused above, so it has spent nothing since: both of its creations in this window succeed.
			expect((await createBoard(a.token)).statusCode).toBe(201)
			expect((await createBoard(a.token)).statusCode).toBe(201)
		} finally {
			vi.useRealTimers()
		}
	})

	it('refuses a credential that already holds 50 boards BEFORE creating anything or spending budget', async () => {
		await freshFixture({ agentBoardCredential: { limit: 1, windowMs: 60_000 } })
		const { token, agent } = await makeCreator()
		const data = store()
		data.accountClients!.find((client) => client.name === agent.name)!.rooms = Array.from({ length: 50 }, (_, index) => `existing-${index}`)
		seed(data)
		const before = boardCount()
		const bytes = storeBytes()
		const refused = await createBoard(token)
		expect(refused.statusCode).toBe(409)
		expect(boardCount()).toBe(before)
		expect(storeBytes()).toBe(bytes)
		// The refusal spent nothing: with room made, the single permitted creation still works.
		data.accountClients!.find((client) => client.name === agent.name)!.rooms = []
		seed(data)
		expect((await createBoard(token)).statusCode).toBe(201)
	})

	it('allows the 50th board and refuses the 51st, creating exactly one board for the last allowed request', async () => {
		const { token, agent } = await makeCreator()
		const data = store()
		data.accountClients!.find((client) => client.name === agent.name)!.rooms = Array.from({ length: 49 }, (_, index) => `existing-${index}`)
		seed(data)
		const before = boardCount()
		expect((await createBoard(token)).statusCode).toBe(201)
		expect((await createBoard(token)).statusCode).toBe(409)
		expect(boardCount()).toBe(before + 1)
		expect(store().accountClients!.find((client) => client.name === agent.name)!.rooms).toHaveLength(50)
	})

	it('rechecks the cap under the lock: two simultaneous requests at 49 boards create exactly one', async () => {
		const { token, agent } = await makeCreator()
		const data = store()
		data.accountClients!.find((client) => client.name === agent.name)!.rooms = Array.from({ length: 49 }, (_, index) => `existing-${index}`)
		seed(data)
		const before = boardCount()
		const [a, b] = await Promise.all([createBoard(token, 'A'), createBoard(token, 'B')])
		expect([a.statusCode, b.statusCode].sort()).toEqual([201, [409, 503].includes(b.statusCode) ? b.statusCode : a.statusCode].sort())
		expect(boardCount()).toBe(before + 1)
		expect(store().accountClients!.find((client) => client.name === agent.name)!.rooms).toHaveLength(50)
	})
})

describe('failure injection around the database / token-store boundary', () => {
	it('board creation fails: nothing is granted and the token store is not touched, not even a backup', async () => {
		const { token, agent } = await makeCreator()
		const bytes = storeBytes()
		const backupsBefore = backupCount()
		const boardsBefore = boardCount()
		// The owning account is disabled between the credential being issued and the request.
		const db = database(false)
		db.prepare('UPDATE users SET disabled_at = ? WHERE id = ?').run(new Date().toISOString(), f.owner.userId)
		db.close()

		const response = await createBoard(token)
		expect(response.statusCode).toBe(403)
		expect(boardCount()).toBe(boardsBefore)
		expect(storeBytes()).toBe(bytes)
		expect(backupCount()).toBe(backupsBefore)
		expect(store().accountClients!.find((client) => client.name === agent.name)!.rooms).toEqual([])
	})

	it('the grant cannot be persisted: the new board is soft-deleted, the store is byte-identical and the caller gets a failure', async () => {
		const { token } = await makeCreator()
		const bytes = storeBytes()
		const boardsBefore = boardCount()
		process.env[FAILPOINT] = 'before-rename'
		const response = await createBoard(token, 'Doomed')
		delete process.env[FAILPOINT]

		expect(response.statusCode).toBe(500)
		expect(response.body).not.toContain('boardId')
		expect(storeBytes()).toBe(bytes)
		const created = rows<{ id: string; deleted_at: string | null }>("SELECT id, deleted_at FROM boards WHERE name = 'Doomed'")
		expect(created).toHaveLength(1)
		expect(created[0].deleted_at).not.toBeNull()
		expect(boardCount()).toBe(boardsBefore + 1) // the row remains: there is no hard delete
		// The owner does not see it in their list; the agent cannot reach it.
		const listed = (await f.owner.get('/api/boards')).json().boards as Array<{ id: string }>
		expect(listed.map((board) => board.id)).not.toContain(created[0].id)
		expect(authorizeApiToken(bearer(token), created[0].id, 'read')).toBeNull()

		// The audit trail tells the story with the machine client as actor and no success row.
		const trail = eventsOf('board.created', 'board.deleted', 'agent.board_created', 'agent.board_creation_rolled_back').filter((event) => event.board_id === created[0].id)
		expect(trail.map((event) => event.type)).toEqual(['board.created', 'board.deleted', 'agent.board_creation_rolled_back'])
		expect(trail.every((event) => event.actor_user_id === null)).toBe(true)
		expect(JSON.parse(trail[1].metadata_json)).toMatchObject({ actorKind: 'agent', reason: 'grant-not-persisted' })

		// The failure is transient: the same credential works once the fault is gone.
		expect((await createBoard(token, 'Fine')).statusCode).toBe(201)
	})
})

describe('audit', () => {
	it('records the machine client as the actor, the human as owner, and no secret of any kind', async () => {
		const { token, agent } = await makeCreator()
		const response = await createBoard(token, 'Audited')
		const boardId = response.json().boardId as string

		const [created] = eventsOf('agent.board_created')
		expect(created.actor_user_id).toBeNull()
		expect(created.board_id).toBe(boardId)
		expect(JSON.parse(created.metadata_json)).toEqual({ actorKind: 'agent', agentName: agent.name, ownerUserId: f.owner.userId, boardId, name: 'Audited' })

		const [boardEvent] = eventsOf('board.created').filter((event) => event.board_id === boardId)
		expect(boardEvent.actor_user_id).toBeNull() // the owner did not personally create it
		expect(boardEvent.subject_user_id).toBe(f.owner.userId)
		expect(JSON.parse(boardEvent.metadata_json)).toEqual({ name: 'Audited', actorKind: 'agent', agentName: agent.name })

		// A human-made board is unchanged: the owner is the actor.
		const human = (await f.owner.post('/api/boards', { name: 'By hand' })).json().board.id as string
		const [humanEvent] = eventsOf('board.created').filter((event) => event.board_id === human)
		expect(humanEvent.actor_user_id).toBe(f.owner.userId)
		expect(JSON.parse(humanEvent.metadata_json)).toEqual({ name: 'By hand' })

		const secrets = new Set<string>([token])
		for (const name of readdirSync(storeDirectory)) {
			if (!name.startsWith('api-tokens.json')) continue
			for (const client of [...(JSON.parse(readFileSync(join(storeDirectory, name), 'utf8')).accountClients ?? []), ...(JSON.parse(readFileSync(join(storeDirectory, name), 'utf8')).clients ?? [])]) secrets.add(client.tokenHash)
		}
		const everything = JSON.stringify(rows('SELECT * FROM account_events')) + response.body
		for (const secret of secrets) expect(everything).not.toContain(secret)
		expect(everything).not.toMatch(/[0-9a-f]{64}/)
	})
})

describe('hostnames and the Origin check', () => {
	it('lets a genuine creator\'s bearer through the Origin check on this one path, as for every other machine route', async () => {
		const { token } = await makeCreator()
		const response = await createBoard(token, 'From elsewhere', { origin: 'https://not-allowed.example' })
		expect(response.statusCode, response.body).toBe(201)
	})

	it('does not extend that exemption to anything else', async () => {
		const creator = await makeCreator()
		const plain = await createClient({ file: storeFile, name: 'plain-rw', rooms: [f.boardId], access: 'read-write' })
		const foreign = { origin: 'https://not-allowed.example' }
		const before = boardCount()
		// an ordinary token, a made-up token and a cookie-only caller all stay behind the Origin check
		expect((await createBoard(plain.token, 'x', foreign)).statusCode).toBe(403)
		expect((await createBoard('n'.repeat(43), 'x', foreign)).statusCode).toBe(403)
		expect((await f.owner.request('POST', BOARDS, { name: 'x' }, foreign)).statusCode).toBe(403)
		// a different path, a different method and a trailing slash are not exempt, even for a genuine creator
		expect((await f.app.inject({ method: 'POST', url: `${BOARDS}/`, headers: { authorization: bearer(creator.token), ...foreign }, payload: { name: 'x' } })).statusCode).toBe(403)
		expect((await f.app.inject({ method: 'PUT', url: BOARDS, headers: { authorization: bearer(creator.token), ...foreign }, payload: { name: 'x' } })).statusCode).toBe(403)
		expect((await f.app.inject({ method: 'POST', url: '/api/boards', headers: { authorization: bearer(creator.token), ...foreign }, payload: { name: 'x' } })).statusCode).toBe(403)
		expect((await f.app.inject({ method: 'POST', url: `${ACCESS}`, headers: { authorization: bearer(creator.token), ...foreign }, payload: { kind: 'board-creator', displayName: 'x', access: 'read' } })).statusCode).toBe(403)
		expect(boardCount()).toBe(before)
	})

	describe('with the machine and browser hostnames configured', () => {
		const MACHINE_HOST = 'whiteboard-api.example.test'
		const HUMAN_HOST = 'whiteboard.example.test'
		const ORIGIN = 'http://127.0.0.1:8787'
		const accessVerifier: AccessVerifier = { async verify(assertion) { return assertion === 'valid' ? { ok: true, clientId: 'svc' } : { ok: false, reason: 'invalid' } } }

		async function world() {
			const directory = mkdtempSync(join(tmpdir(), 'agent-boards-hosts-'))
			const tokenFile = join(directory, 'api-tokens.json')
			process.env.CANVAS_API_TOKENS_FILE = tokenFile
			mkdirSync(join(directory, 'client'), { recursive: true })
			const app = await buildApp({ dataDirectory: directory, clientDirectory: join(directory, 'client'), logger: false, hostPolicy: { publicHost: HUMAN_HOST, machineHost: MACHINE_HOST, accessVerifier } })
			const registered = await app.inject({ method: 'POST', url: '/api/auth/register', headers: { host: HUMAN_HOST, origin: ORIGIN }, payload: { login: 'owner', displayName: 'Owner', password: 'a-long-test-password-1234' } })
			const cookie = `${registered.cookies[0].name}=${registered.cookies[0].value}`
			const created = await app.inject({ method: 'POST', url: ACCESS, headers: { host: HUMAN_HOST, origin: ORIGIN, cookie }, payload: { kind: 'board-creator', displayName: 'Planner', access: 'read-write-history' } })
			expect(created.statusCode, created.body).toBe(201)
			const plain = await createClient({ file: tokenFile, name: 'plain-board', rooms: ['some-board'], access: 'read' })
			return { app, directory, cookie, token: created.json().token as string, plain: plain.token }
		}

		it('serves it on the machine hostname behind Access with no Origin header, and nowhere else', async () => {
			const w = await world()
			try {
				const machine = { host: MACHINE_HOST, 'cf-access-jwt-assertion': 'valid' }
				const ok = await w.app.inject({ method: 'POST', url: BOARDS, headers: { ...machine, authorization: bearer(w.token) }, payload: { name: 'Via the API host' } })
				expect(ok.statusCode, ok.body).toBe(201)

				// no Access assertion: refused before the route runs
				expect((await w.app.inject({ method: 'POST', url: BOARDS, headers: { host: MACHINE_HOST, authorization: bearer(w.token) }, payload: { name: 'x' } })).statusCode).toBe(403)
				// an ordinary token, even behind Access
				expect((await w.app.inject({ method: 'POST', url: BOARDS, headers: { ...machine, authorization: bearer(w.plain) }, payload: { name: 'x' } })).statusCode).toBe(403)
				// a browser session is never a machine credential: with no bearer the Origin check refuses it before the route
				// could even look at the cookie (which the machine hostname also strips)
				expect((await w.app.inject({ method: 'POST', url: BOARDS, headers: { ...machine, cookie: w.cookie }, payload: { name: 'x' } })).statusCode).toBe(403)
				// the wrong method is not part of the allowlist
				expect((await w.app.inject({ method: 'GET', url: BOARDS, headers: { ...machine, authorization: bearer(w.token) } })).statusCode).toBe(404)
				// the browser hostname refuses every bearer
				const onHuman = await w.app.inject({ method: 'POST', url: BOARDS, headers: { host: HUMAN_HOST, authorization: bearer(w.token), origin: ORIGIN }, payload: { name: 'x' } })
				expect(onHuman.statusCode).toBe(401)
				expect(onHuman.json().error).toMatch(/Machine credentials are not accepted/)
				// and the browser hostname with only the owner's cookie gets nothing from this route either
				expect((await w.app.inject({ method: 'POST', url: BOARDS, headers: { host: HUMAN_HOST, cookie: w.cookie, origin: ORIGIN }, payload: { name: 'x' } })).statusCode).toBe(401)
			} finally {
				await w.app.close()
				rmSync(w.directory, { recursive: true, force: true })
			}
		})

		it('does not serve the management routes on the machine hostname', async () => {
			const w = await world()
			try {
				const machine = { host: MACHINE_HOST, 'cf-access-jwt-assertion': 'valid', cookie: w.cookie, origin: ORIGIN }
				expect((await w.app.inject({ method: 'GET', url: `${ACCESS}?scope=creators`, headers: machine })).statusCode).toBe(404)
				expect((await w.app.inject({ method: 'POST', url: ACCESS, headers: machine, payload: { kind: 'board-creator', displayName: 'x', access: 'read' } })).statusCode).toBe(404)
			} finally {
				await w.app.close()
				rmSync(w.directory, { recursive: true, force: true })
			}
		})
	})
})

describe('managing board-creating credentials (the Agents page)', () => {
	it('lets any signed-in person create one, but not an anonymous caller', async () => {
		expect((await f.anonymous.post(ACCESS, { kind: 'board-creator', displayName: 'x', access: 'read' })).statusCode).toBe(401)
		for (const identity of [f.owner, f.editor, f.viewer, f.nonmember]) {
			const response = await identity.post(ACCESS, { kind: 'board-creator', displayName: 'Mine', access: 'read' })
			expect(response.statusCode, identity.role).toBe(201)
		}
	})

	it('returns the one-time token, hides every hash, and registers the owner as the caller', async () => {
		const response = await f.editor.post(ACCESS, { kind: 'board-creator', displayName: '  Planner  ', access: 'read-write-history', expiresAt: new Date(Date.now() + 86_400_000).toISOString() })
		const body = response.json() as { agent: Record<string, any>; token: string }
		expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
		expect(body.agent).toMatchObject({ canCreateBoards: true, displayName: 'Planner', rooms: [], permissions: ['read', 'write', 'history'], status: 'active', createdByYou: true })
		expect(response.body).not.toMatch(/tokenHash|[0-9a-f]{64}/)
		expect(store().accountClients![0]).toMatchObject({ ownerUserId: f.editor.userId, createdByUserId: f.editor.userId, accountPermissions: ['board:create'], rooms: [] })
		expect(store().clients).toEqual([])
		// and the audit row names the kind, with no board and no secret
		const [event] = eventsOf('agent.created')
		expect(event.board_id).toBeNull()
		expect(event.actor_user_id).toBe(f.editor.userId)
		expect(JSON.parse(event.metadata_json)).toMatchObject({ kind: 'board-creator', displayName: 'Planner', access: 'read-write-history' })
		expect(event.metadata_json).not.toContain(body.token)
	})

	it('rejects a malformed creator request without writing anything', async () => {
		const bytes = (() => { try { return storeBytes() } catch { return null } })()
		for (const payload of [
			{ kind: 'board-creator', access: 'read' },
			{ kind: 'board-creator', displayName: 'x', access: 'root' },
			{ kind: 'board-creator', displayName: 'x', access: 'read', boardId: f.boardId },
			{ kind: 'board-creator', displayName: 'x', access: 'read', ownerUserId: 'someone-else' },
			{ kind: 'something-else', displayName: 'x', access: 'read' },
		]) {
			expect([400, 422], JSON.stringify(payload)).toContain((await f.owner.post(ACCESS, payload)).statusCode)
		}
		expect((() => { try { return storeBytes() } catch { return null } })()).toBe(bytes)
	})

	it('refuses the 21st creator', async () => {
		for (let index = 0; index < 20; index += 1) await makeCreator(f.owner, { displayName: `Planner ${index}` })
		const response = await f.owner.post(ACCESS, { kind: 'board-creator', displayName: 'one too many', access: 'read' })
		expect(response.statusCode).toBe(409)
		expect(store().accountClients).toHaveLength(20)
	})

	it('lists only the caller\'s own, including ones that hold no boards yet', async () => {
		const mine = await makeCreator(f.owner, { displayName: 'Mine' })
		await makeCreator(f.nonmember, { displayName: 'Theirs' })
		const listed = (await f.owner.get(`${ACCESS}?scope=creators`)).json().agents as Array<Record<string, any>>
		expect(listed.map((agent) => agent.displayName)).toEqual(['Mine'])
		expect(listed[0]).toMatchObject({ ref: mine.agent.ref, canCreateBoards: true, rooms: [] })
		expect((await f.anonymous.get(`${ACCESS}?scope=creators`)).statusCode).toBe(401)
	})

	it('never lists someone else\'s creator on my board, even if its record somehow holds that board', async () => {
		const theirs = await makeCreator(f.nonmember, { displayName: 'Theirs' })
		const data = store()
		data.accountClients!.find((client) => client.name === theirs.agent.name)!.rooms = [f.boardId]
		seed(data)
		const listed = (await f.owner.get(`${ACCESS}?boardId=${f.boardId}`)).json().agents as Array<Record<string, any>>
		expect(listed.map((agent) => agent.ref)).not.toContain(theirs.agent.ref)
	})

	it('shows a creator on the boards it made, to their owner only', async () => {
		const mine = await makeCreator(f.owner, { displayName: 'Mine' })
		const boardId = (await createBoard(mine.token)).json().boardId as string
		const listed = (await f.owner.get(`${ACCESS}?boardId=${boardId}`)).json().agents as Array<Record<string, any>>
		expect(listed.map((agent) => agent.ref)).toEqual([mine.agent.ref])
		expect(listed[0].rooms).toEqual([boardId])
		expect((await f.nonmember.get(`${ACCESS}?boardId=${boardId}`)).statusCode).toBe(404)
	})

	it('never lets someone other than the credential\'s owner rotate or revoke it, even though it holds no boards to compare', async () => {
		const mine = await makeCreator(f.owner)
		const bytes = storeBytes()
		for (const identity of [f.nonmember, f.editor, f.viewer]) {
			expect((await identity.post(`${ACCESS}/${mine.agent.ref}/rotate`, {})).statusCode, `rotate as ${identity.role}`).toBe(404)
			expect((await identity.delete(`${ACCESS}/${mine.agent.ref}`)).statusCode, `revoke as ${identity.role}`).toBe(404)
		}
		expect((await f.anonymous.delete(`${ACCESS}/${mine.agent.ref}`)).statusCode).toBe(401)
		expect(storeBytes()).toBe(bytes)
		expect((await createBoard(mine.token)).statusCode).toBe(201)
	})

	it('lets the owner rotate: the old token dies, the new one works, and it keeps its boards and capability', async () => {
		const mine = await makeCreator(f.owner)
		const boardId = (await createBoard(mine.token)).json().boardId as string
		const rotated = await f.owner.post(`${ACCESS}/${mine.agent.ref}/rotate`, {})
		expect(rotated.statusCode, rotated.body).toBe(200)
		const body = rotated.json() as { agent: Record<string, any>; token: string }
		expect(body.agent).toMatchObject({ canCreateBoards: true, rooms: [boardId] })
		expect(body.token).not.toBe(mine.token)
		expect((await createBoard(mine.token)).statusCode).toBe(401)
		expect((await f.app.inject({ method: 'GET', url: `/api/rooms/${boardId}/canvas`, headers: { authorization: bearer(mine.token) } })).statusCode).toBe(401)
		expect((await createBoard(body.token, 'After rotation')).statusCode).toBe(201)
		expect((await f.app.inject({ method: 'GET', url: `/api/rooms/${boardId}/canvas`, headers: { authorization: bearer(body.token) } })).statusCode).toBe(200)
	})

	it('lets the owner revoke: creation and access to every board it made stop at once', async () => {
		const mine = await makeCreator(f.owner)
		const boardId = (await createBoard(mine.token)).json().boardId as string
		expect((await f.owner.delete(`${ACCESS}/${mine.agent.ref}`)).statusCode).toBe(200)
		expect(store().accountClients).toEqual([])
		expect((await createBoard(mine.token)).statusCode).toBe(401)
		expect((await f.app.inject({ method: 'GET', url: `/api/rooms/${boardId}/canvas`, headers: { authorization: bearer(mine.token) } })).statusCode).toBe(401)
		// the boards themselves are the owner's and remain
		expect((await f.owner.get(`/api/boards/${boardId}`)).statusCode).toBe(200)
	})

	it('answers a stale reference with 409 and a rotated one cannot be aimed at its predecessor', async () => {
		const mine = await makeCreator(f.owner)
		await f.owner.post(`${ACCESS}/${mine.agent.ref}/rotate`, {})
		const bytes = storeBytes()
		expect((await f.owner.delete(`${ACCESS}/${mine.agent.ref}`)).statusCode).toBe(409)
		expect(storeBytes()).toBe(bytes)
	})

	it('leaves one audit row for a creator that holds no boards, and one per board for one that does', async () => {
		const empty = await makeCreator(f.owner, { displayName: 'Empty' })
		await f.owner.delete(`${ACCESS}/${empty.agent.ref}`)
		const revokedEmpty = eventsOf('agent.revoked')
		expect(revokedEmpty).toHaveLength(1)
		expect(revokedEmpty[0].board_id).toBeNull()
		expect(JSON.parse(revokedEmpty[0].metadata_json)).toMatchObject({ kind: 'board-creator' })

		const busy = await makeCreator(f.owner, { displayName: 'Busy' })
		await createBoard(busy.token, 'One')
		await createBoard(busy.token, 'Two')
		const rotated = await f.owner.post(`${ACCESS}/${busy.agent.ref}/rotate`, {})
		expect(rotated.statusCode).toBe(200)
		const rotations = eventsOf('agent.rotated')
		expect(rotations).toHaveLength(2)
		expect(new Set(rotations.map((event) => event.board_id)).size).toBe(2)
		expect(JSON.stringify(rotations)).not.toMatch(/[A-Za-z0-9_-]{43}|[0-9a-f]{64}/)
	})
})

describe('existing machine clients are unaffected', () => {
	it('leaves ordinary records byte-for-byte alone through every creator operation, and they keep authenticating', async () => {
		const legacyRecord = { name: 'codex-like', tokenHash: sha256('legacy-secret'), rooms: ['board-x'], permissions: ['read', 'write'], futureField: { keep: true } }
		seed({ schemaVersion: 3, clients: [legacyRecord] })
		const legacyBytes = JSON.stringify(legacyRecord)

		const mine = await makeCreator(f.owner)
		await createBoard(mine.token)
		await f.owner.post(`${ACCESS}/${mine.agent.ref}/rotate`, {})
		const data = store()
		expect(JSON.stringify(data.clients[0])).toBe(legacyBytes)
		expect(data.schemaVersion).toBe(3)
		expect(Object.keys(data)).toEqual(['schemaVersion', 'clients', 'accountClients'])
	})

	it('leaves a store that never had creators without the new key after ordinary management', async () => {
		const plain = await f.owner.post(ACCESS, { boardId: f.boardId, displayName: 'plain', access: 'read-write-history' })
		expect(plain.statusCode, plain.body).toBe(201)
		expect(plain.json().agent.canCreateBoards).toBeUndefined()
		expect(Object.keys(store())).toEqual(['clients'])
		expect(store().clients[0].permissions).toEqual(['read', 'write', 'history'])
	})
})

describe('the request-time reader keeps creators and ordinary clients independent', () => {
	const goodCreator = (token: string, rooms: string[] = ['board-c']) => ({
		name: 'creator-good', tokenHash: sha256(token), ownerUserId: 'user-1', accountPermissions: ['board:create'], permissions: ['read'], rooms,
	})
	const plain = { name: 'plain-good', tokenHash: sha256('plain-token'), rooms: ['board-a'], permissions: ['read'] }
	const T = (value: string) => value.padEnd(43, 'x')

	it('a malformed creator record disables that credential only', () => {
		seed({ clients: [{ ...plain, tokenHash: sha256(T('plain')) }], accountClients: [{ ...goodCreator(T('c1')), name: 'bad name!' }, goodCreator(T('c2'))] })
		expect(authorizeApiToken(bearer(T('plain')), 'board-a', 'read')).toBe('plain-good')
		expect(authorizeApiToken(bearer(T('c2')), 'board-c', 'read')).toBe('creator-good')
		expect(authorizeApiToken(bearer(T('c1')), 'board-c', 'read')).toBeNull()
	})

	it('junk in accountClients never takes ordinary clients down', () => {
		for (const accountClients of ['text', { a: 1 }, [null, 5, 'x', { name: 1 }], [{ ...goodCreator(T('c')), rooms: 'nope' }], [{ ...goodCreator(T('c')), tokenHash: 'short' }]]) {
			seed({ clients: [{ ...plain, tokenHash: sha256(T('plain')) }], accountClients })
			expect(authorizeApiToken(bearer(T('plain')), 'board-a', 'read'), JSON.stringify(accountClients)).toBe('plain-good')
		}
	})

	it('a creator authenticates on the boards it holds and nowhere else, with its configured permissions', () => {
		seed({ clients: [], accountClients: [goodCreator(T('c'), ['board-c', 'board-d'])] })
		expect(authorizeApiToken(bearer(T('c')), 'board-d', 'read')).toBe('creator-good')
		expect(authorizeApiToken(bearer(T('c')), 'board-d', 'write')).toBeNull()
		expect(authorizeApiToken(bearer(T('c')), 'board-a', 'read')).toBeNull()
	})

	it('distinguishes a genuine bearer without the capability (forbidden) from an unknown one (unauthenticated)', () => {
		seed({
			clients: [{ ...plain, tokenHash: sha256(T('plain')) }],
			accountClients: [goodCreator(T('c')), { ...goodCreator(T('d')), name: 'creator-nocap', accountPermissions: ['something:else'] }],
		})
		expect(authenticateBoardCreator(bearer(T('c')))).toMatchObject({ kind: 'ok', name: 'creator-good', ownerUserId: 'user-1', roomCount: 1 })
		expect(authenticateBoardCreator(bearer(T('plain')))).toEqual({ kind: 'forbidden' })
		expect(authenticateBoardCreator(bearer(T('d')))).toEqual({ kind: 'forbidden' })
		expect(authenticateBoardCreator(bearer(T('nobody')))).toEqual({ kind: 'unauthenticated' })
		expect(authenticateBoardCreator(undefined)).toEqual({ kind: 'unauthenticated' })
		expect(authenticateBoardCreator('Basic abc')).toEqual({ kind: 'unauthenticated' })
	})

	it('treats an expired or unreadable-expiry creator as unauthenticated', () => {
		seed({ clients: [], accountClients: [{ ...goodCreator(T('c')), expiresAt: '2001-01-01T00:00:00.000Z' }, { ...goodCreator(T('d')), name: 'creator-bad-expiry', expiresAt: 'soon' }] })
		expect(authenticateBoardCreator(bearer(T('c')))).toEqual({ kind: 'unauthenticated' })
		expect(authenticateBoardCreator(bearer(T('d')))).toEqual({ kind: 'unauthenticated' })
		expect(authorizeApiToken(bearer(T('c')), 'board-c', 'read')).toBeNull()
	})

	it('is a store a build without creator support reads exactly as before: creators fail closed, ordinary clients carry on', () => {
		// A faithful copy of the reader as it stood before this feature (the one deployed in production): it parses
		// `clients` with `.passthrough()` and has never heard of `accountClients`.
		const legacyClient = z.object({
			name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
			tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
			rooms: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,80}$/)).min(1).max(50),
			permissions: z.array(z.enum(['read', 'write', 'history', 'restore'])).min(1).max(4),
		}).passthrough()
		const legacyFile = z.object({ clients: z.array(legacyClient).max(100) }).passthrough()
		const legacyAuthorize = (header: string, room: string, permission: string) => {
			const match = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(header)
			if (!match) return null
			const text = readFileSync(storeFile, 'utf8')
			let clients
			try { clients = legacyFile.parse(JSON.parse(text)).clients } catch { return null }
			const digest = sha256(match[1])
			for (const client of clients) if (client.tokenHash === digest && client.rooms.includes(room) && client.permissions.includes(permission as never)) return client.name
			return null
		}
		// a creator with NO boards (the case that would have broken a legacy reader had it lived in `clients`) and one with boards
		seed({
			clients: [{ ...plain, tokenHash: sha256(T('plain')) }],
			accountClients: [goodCreator(T('empty'), []), { ...goodCreator(T('busy'), ['board-c']), name: 'creator-busy' }],
		})
		expect(legacyAuthorize(bearer(T('plain')), 'board-a', 'read')).toBe('plain-good') // ordinary clients are unaffected
		expect(legacyAuthorize(bearer(T('empty')), 'board-c', 'read')).toBeNull() // creators fail closed
		expect(legacyAuthorize(bearer(T('busy')), 'board-c', 'read')).toBeNull() // even on boards they hold
		// and the current reader agrees on the ordinary client
		expect(authorizeApiToken(bearer(T('plain')), 'board-a', 'read')).toBe('plain-good')
	})
})
