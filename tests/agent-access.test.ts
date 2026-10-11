/**
 * Owner-only agent management over the human session (server/agent-access.ts).
 *
 *   GET    /api/agent-access?boardId=ID
 *   POST   /api/agent-access                 { boardId, displayName, access, expiresAt? }
 *   POST   /api/agent-access/:ref/rotate     { expiresAt? }
 *   DELETE /api/agent-access/:ref
 *
 * These tests run the real application (buildApp) against a disposable data directory and a disposable token
 * store, and check the result with the same reader (authorizeApiToken) that guards the machine API. Nothing here
 * can reach a real host.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AccessVerifier } from '../server/access-jwt'
import { buildApp } from '../server/app'
import { ACCESS_MODES, MAX_CLIENTS, createClient, revokeClient } from '../server/token-store.mjs'
import { authorizeApiToken } from '../server/tokens'
import { createAcceptanceFixture, type AcceptanceFixture } from './helpers/acceptance-fixture'

let f: AcceptanceFixture
let storeDirectory: string
let storeFile: string

const BASE = '/api/agent-access'
const listUrl = (board = f.boardId) => `${BASE}?boardId=${board}`
const bearer = (token: string) => `Bearer ${token}`
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
// An independent statement of the reference format, so these tests do not just echo the implementation.
const fingerprintOfHash = (hash: string) => createHash('sha256').update(`agent-ref:${hash}`).digest('hex').slice(0, 16)
const refFor = (name: string, tokenHash: string) => `${name}.${fingerprintOfHash(tokenHash)}`
const storeBytes = () => (existsSync(storeFile) ? readFileSync(storeFile, 'utf8') : null)
const storedClients = () => (JSON.parse(readFileSync(storeFile, 'utf8')) as { clients: Array<Record<string, unknown>> }).clients
const inOneHour = () => new Date(Date.now() + 3_600_000).toISOString()
const NOT_A_REF = 'agent-000000000000.0000000000000000'

/** Writes a store verbatim, for tests that need clients the routes could not have made. */
function seedStore(contents: unknown): void {
	writeFileSync(storeFile, `${JSON.stringify(contents, null, 2)}\n`, { mode: 0o600 })
}

const legacy = (name: string, rooms: string[], extra: Record<string, unknown> = {}) => ({
	name, tokenHash: sha256(name), rooms, permissions: ['read'], ...extra,
})

async function accountEvents(): Promise<Array<{ type: string; actor_user_id: string; board_id: string; metadata_json: string }>> {
	const database = new Database(join(f.directory, 'auth.sqlite'), { readonly: true })
	try {
		return database.prepare("SELECT type, actor_user_id, board_id, metadata_json FROM account_events WHERE type LIKE 'agent.%' ORDER BY id").all() as never
	} finally {
		database.close()
	}
}

/** Creates an agent through the route as the board owner and returns its listing entry plus the one-time token. */
async function createAgent(extra: Record<string, unknown> = {}, identity = f.owner, board = f.boardId) {
	const response = await identity.post(BASE, { boardId: board, displayName: 'agent', access: 'read', ...extra })
	expect(response.statusCode, response.body).toBe(201)
	return response.json() as { agent: { ref: string; name: string; [key: string]: unknown }; token: string }
}

async function createOtherOwnersBoard(id = 'other-owners-board') {
	const response = await f.nonmember.post('/api/boards', { name: 'Other owner board', id })
	expect(response.statusCode).toBe(200)
}

beforeEach(async () => {
	f = await createAcceptanceFixture()
	storeDirectory = mkdtempSync(join(tmpdir(), 'agent-access-store-'))
	storeFile = join(storeDirectory, 'api-tokens.json')
	// The fixture clears this variable while it builds and restores it on cleanup, so set it afterwards.
	process.env.CANVAS_API_TOKENS_FILE = storeFile
})

afterEach(async () => {
	await f.cleanup()
	rmSync(storeDirectory, { recursive: true, force: true })
})

describe('who may manage agents', () => {
	it('turns away anonymous callers with 401 on every route and creates nothing', async () => {
		expect((await f.anonymous.get(listUrl())).statusCode).toBe(401)
		expect((await f.anonymous.post(BASE, { boardId: f.boardId, displayName: 'x', access: 'read' })).statusCode).toBe(401)
		expect((await f.anonymous.post(`${BASE}/${NOT_A_REF}/rotate`, {})).statusCode).toBe(401)
		expect((await f.anonymous.delete(`${BASE}/${NOT_A_REF}`)).statusCode).toBe(401)

		expect(storeBytes()).toBeNull()
	})

	it('answers a signed-in nonmember exactly as it would for a board that does not exist', async () => {
		const get = await f.nonmember.get(listUrl())
		const missing = await f.nonmember.get(listUrl('no-such-board'))

		expect(get.statusCode).toBe(404)
		expect(get.body).toBe(missing.body)
		expect((await f.nonmember.post(BASE, { boardId: f.boardId, displayName: 'x', access: 'read' })).statusCode).toBe(404)
		expect(storeBytes()).toBeNull()
	})

	it('refuses editors and viewers with 403 when they name a board they do not own', async () => {
		for (const identity of [f.editor, f.viewer]) {
			expect((await identity.get(listUrl())).statusCode, identity.role).toBe(403)
			expect((await identity.post(BASE, { boardId: f.boardId, displayName: 'x', access: 'read' })).statusCode, identity.role).toBe(403)
		}
		expect(storeBytes()).toBeNull()
	})

	it('shows a real agent to nobody who does not own all of its boards: 404 for rotate and revoke', async () => {
		const { agent } = await createAgent()
		const before = storeBytes()

		for (const identity of [f.editor, f.viewer, f.nonmember]) {
			expect((await identity.post(`${BASE}/${agent.ref}/rotate`, {})).statusCode, `${identity.role} rotate`).toBe(404)
			expect((await identity.delete(`${BASE}/${agent.ref}`)).statusCode, `${identity.role} revoke`).toBe(404)
		}
		expect(storeBytes()).toBe(before)
	})

	it('lets the board owner in, and marks every answer no-store', async () => {
		const response = await f.owner.get(listUrl())

		expect(response.statusCode).toBe(200)
		expect(response.json()).toEqual({ agents: [] })
		expect(response.headers['cache-control']).toBe('no-store')
	})

	it('never lets a machine bearer token manage agents, even a full-scope one for this very board', async () => {
		const { agent } = await createAgent({ access: 'full' })
		const victim = await createAgent({ displayName: 'victim' })
		const { token } = await createClient({ file: storeFile, name: 'powerful', rooms: [f.boardId], access: 'full' })
		const before = storeBytes()
		const headers = { authorization: bearer(token) }

		expect((await f.anonymous.request('GET', listUrl(), undefined, headers)).statusCode).toBe(401)
		expect((await f.anonymous.request('POST', BASE, { boardId: f.boardId, displayName: 'sneaky', access: 'full' }, headers)).statusCode).toBe(401)
		expect((await f.anonymous.request('POST', `${BASE}/${victim.agent.ref}/rotate`, {}, headers)).statusCode).toBe(401)
		expect((await f.anonymous.request('DELETE', `${BASE}/${agent.ref}`, undefined, headers)).statusCode).toBe(401)

		expect(storeBytes()).toBe(before)
		expect(authorizeApiToken(bearer(token), f.boardId, 'read')).toBe('powerful')
	})

	it('rejects bad input shapes before touching the store', async () => {
		expect((await f.owner.get(`${BASE}`)).statusCode).toBe(400)
		expect((await f.owner.get(`${BASE}?boardId=bad.id`)).statusCode).toBe(400)
		expect((await f.owner.post(`${BASE}/not-a-reference/rotate`, {})).statusCode).toBe(400)
		expect((await f.owner.delete(`${BASE}/has%20space.0123456789abcdef`)).statusCode).toBe(400)
		expect((await f.owner.delete(`${BASE}/agent-aaaaaaaaaaaa.XYZ`)).statusCode).toBe(400)
		expect(storeBytes()).toBeNull()
	})

	it('says the feature is unconfigured when there is no token file setting', async () => {
		delete process.env.CANVAS_API_TOKENS_FILE

		for (const response of [
			await f.owner.get(listUrl()),
			await f.owner.post(BASE, { boardId: f.boardId, displayName: 'x', access: 'read' }),
			await f.owner.post(`${BASE}/${NOT_A_REF}/rotate`, {}),
			await f.owner.delete(`${BASE}/${NOT_A_REF}`),
		]) {
			expect(response.statusCode).toBe(503)
			expect(response.json().error).toMatch(/not configured/)
		}
	})
})

describe('the Origin check cannot be sidestepped on these routes', () => {
	const foreign = 'https://evil.example'

	it('is the premise: on a board path a valid bearer for that board does skip the Origin requirement', async () => {
		const { token } = await createClient({ file: storeFile, name: 'checkpointer', rooms: [f.boardId], access: 'full' })

		const exempt = await f.anonymous.request('POST', `/api/boards/${f.boardId}/checkpoints`, { label: 'from a bearer' }, { authorization: bearer(token), origin: foreign })
		const refused = await f.anonymous.request('POST', `/api/boards/${f.boardId}/checkpoints`, { label: 'no bearer' }, { origin: foreign })

		expect(exempt.statusCode).toBe(200)
		expect(refused.statusCode).toBe(403)
	})

	it('but these routes are not on a board path, so the same bearer buys nothing: a foreign Origin is refused', async () => {
		const { agent } = await createAgent()
		const { token } = await createClient({ file: storeFile, name: 'checkpointer', rooms: [f.boardId], access: 'full' })
		const before = storeBytes()
		const withBearer = { authorization: bearer(token), origin: foreign }

		expect((await f.anonymous.request('POST', BASE, { boardId: f.boardId, displayName: 'x', access: 'read' }, withBearer)).statusCode).toBe(403)
		expect((await f.anonymous.request('POST', `${BASE}/${agent.ref}/rotate`, {}, withBearer)).statusCode).toBe(403)
		expect((await f.anonymous.request('DELETE', `${BASE}/${agent.ref}`, undefined, withBearer)).statusCode).toBe(403)
		expect(storeBytes()).toBe(before)
	})

	it('and a signed-in owner is refused too when the request does not come from an allowed origin', async () => {
		const { agent } = await createAgent()
		const before = storeBytes()

		expect((await f.owner.request('POST', BASE, { boardId: f.boardId, displayName: 'x', access: 'read' }, { origin: foreign })).statusCode).toBe(403)
		expect((await f.owner.request('POST', `${BASE}/${agent.ref}/rotate`, {}, { origin: foreign })).statusCode).toBe(403)
		expect((await f.owner.request('DELETE', `${BASE}/${agent.ref}`, undefined, { origin: foreign })).statusCode).toBe(403)
		expect(storeBytes()).toBe(before)
	})

	it('and the board-path shape the first draft used does not exist', async () => {
		expect((await f.owner.get(`/api/boards/${f.boardId}/agents`)).statusCode).toBe(404)
		expect((await f.owner.post(`/api/boards/${f.boardId}/agents`, { displayName: 'x', access: 'read' })).statusCode).toBe(404)
	})
})

describe('creating an agent', () => {
	it('returns the bearer once, in the creation response, with a reference and a view with no hash', async () => {
		const response = await f.owner.post(BASE, { boardId: f.boardId, displayName: 'Chibi notes bot', access: 'read-write' })

		expect(response.statusCode).toBe(201)
		expect(response.headers['cache-control']).toBe('no-store')
		const { agent, token } = response.json()
		expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
		expect(agent).toMatchObject({
			displayName: 'Chibi notes bot', permissions: ['read', 'write'], rooms: [f.boardId], sharedWithOtherBoards: false, status: 'none', createdByYou: true,
		})
		expect(agent.name).toMatch(/^agent-[0-9a-f]{12}$/)
		expect(agent.ref).toBe(refFor(agent.name, sha256(token)))
		expect(agent).not.toHaveProperty('expiresAt')
		expect(agent).not.toHaveProperty('tokenHash')
		expect(JSON.stringify(response.json())).not.toContain(sha256(token))
	})

	it('stores a one-board client carrying who made it and when, and only the hash of the token', async () => {
		const { agent, token } = await createAgent({ displayName: 'Chibi notes bot' })

		const [stored] = storedClients()
		expect(stored).toMatchObject({ name: agent.name, rooms: [f.boardId], permissions: ['read'], displayName: 'Chibi notes bot', createdByUserId: f.owner.userId, tokenHash: sha256(token) })
		expect(typeof stored.createdAt).toBe('string')
		expect(readFileSync(storeFile, 'utf8')).not.toContain(token)
	})

	it('issues a token the machine reader accepts for this board and this scope only', async () => {
		const { agent, token } = await createAgent({ access: 'read-write' })

		expect(authorizeApiToken(bearer(token), f.boardId, 'write')).toBe(agent.name)
		expect(authorizeApiToken(bearer(token), f.boardId, 'read')).toBe(agent.name)
		expect(authorizeApiToken(bearer(token), f.boardId, 'history')).toBeNull()
		expect(authorizeApiToken(bearer(token), f.boardId, 'restore')).toBeNull()
		expect(authorizeApiToken(bearer(token), 'some-other-board', 'read')).toBeNull()
	})

	for (const [mode, permissions] of Object.entries(ACCESS_MODES)) {
		it(`maps access mode "${mode}" to its permissions`, async () => {
			const response = await f.owner.post(BASE, { boardId: f.boardId, displayName: mode, access: mode })

			expect(response.statusCode).toBe(201)
			expect(response.json().agent.permissions).toEqual(permissions)
		})
	}

	it('honours an expiry: valid right up to the instant, refused from it', async () => {
		const expiresAt = inOneHour()
		const { agent, token } = await createAgent({ expiresAt })
		const at = Date.parse(expiresAt)

		expect(agent).toMatchObject({ expiresAt, status: 'active' })
		expect(authorizeApiToken(bearer(token), f.boardId, 'read', at - 1)).toBe(agent.name)
		expect(authorizeApiToken(bearer(token), f.boardId, 'read', at)).toBeNull()
	})

	it('refuses bodies it should not accept, and writes nothing for any of them', async () => {
		const ok = { boardId: f.boardId, displayName: 'x', access: 'read' }
		const bad: Array<[string, unknown]> = [
			['no board', { displayName: 'x', access: 'read' }],
			['malformed board id', { ...ok, boardId: 'bad.id' }],
			['no display name', { boardId: f.boardId, access: 'read' }],
			['blank display name', { ...ok, displayName: '   ' }],
			['display name too long', { ...ok, displayName: 'x'.repeat(81) }],
			['control character in the display name', { ...ok, displayName: 'bell\u0007' }],
			['no access', { boardId: f.boardId, displayName: 'x' }],
			['unknown access mode', { ...ok, access: 'sudo' }],
			['caller-chosen rooms', { ...ok, rooms: ['someone-elses-board'] }],
			['caller-chosen name', { ...ok, name: 'chosen' }],
			['caller-chosen permissions', { ...ok, permissions: ['restore'] }],
			['expiry in the past', { ...ok, expiresAt: '2000-01-01T00:00:00Z' }],
			['expiry that is prose', { ...ok, expiresAt: 'tomorrow' }],
			['expiry that is a number', { ...ok, expiresAt: 5 }],
			['expiry with an offset', { ...ok, expiresAt: '2099-01-01T00:00:00+01:00' }],
		]

		for (const [label, body] of bad) {
			const response = await f.owner.post(BASE, body)
			expect(response.statusCode, label).toBe(422)
		}

		expect(storeBytes()).toBeNull()
	})

	it('refuses to cross the reader\'s client limit, so one more registration cannot lock out every agent', async () => {
		seedStore({ clients: Array.from({ length: MAX_CLIENTS }, (_, index) => legacy(`filler-${index}`, ['elsewhere'])) })
		const before = storeBytes()

		const response = await f.owner.post(BASE, { boardId: f.boardId, displayName: 'one too many', access: 'read' })

		expect(response.statusCode).toBe(409)
		expect(response.json().error).toMatch(/maximum of 100/)
		expect(storeBytes()).toBe(before)
	})

	it('keeps metadata it does not understand through a create, a rotate and a revoke', async () => {
		seedStore({ schemaVersion: 7, futureThing: { deep: ['x'] }, clients: [legacy('old-timer', ['elsewhere'], { createdAt: '2026-01-01T00:00:00.000Z', somethingNew: true })] })

		const { agent } = await createAgent()
		const rotated = await f.owner.post(`${BASE}/${agent.ref}/rotate`, {})
		await f.owner.delete(`${BASE}/${rotated.json().agent.ref}`)

		const parsed = JSON.parse(readFileSync(storeFile, 'utf8'))
		expect(parsed.schemaVersion).toBe(7)
		expect(parsed.futureThing).toEqual({ deep: ['x'] })
		expect(parsed.clients).toHaveLength(1)
		expect(parsed.clients[0]).toMatchObject({ name: 'old-timer', createdAt: '2026-01-01T00:00:00.000Z', somethingNew: true })
	})

	it('answers 503 and changes nothing while another operation holds the store lock', async () => {
		seedStore({ clients: [] })
		writeFileSync(`${storeFile}.lock`, 'held-by-the-cli\n', { mode: 0o600 })
		const before = storeBytes()

		const response = await f.owner.post(BASE, { boardId: f.boardId, displayName: 'x', access: 'read' })

		expect(response.statusCode).toBe(503)
		expect(response.json().error).toMatch(/another operation/)
		expect(storeBytes()).toBe(before)
		expect(readFileSync(`${storeFile}.lock`, 'utf8')).toBe('held-by-the-cli\n')
	})

	it('serialises two creates at the same moment: each either succeeds or is told to retry, and none is lost', async () => {
		seedStore({ clients: [] })

		const outcomes = await Promise.all([
			f.owner.post(BASE, { boardId: f.boardId, displayName: 'one', access: 'read' }),
			f.owner.post(BASE, { boardId: f.boardId, displayName: 'two', access: 'read' }),
		])

		const codes = outcomes.map((outcome) => outcome.statusCode).sort()
		for (const code of codes) expect([201, 503]).toContain(code)
		expect(codes).toContain(201)
		expect(storedClients()).toHaveLength(codes.filter((code) => code === 201).length)
	})
})

describe('listing agents', () => {
	it('shows the agents that can reach this board, with a reference, without hashes or tokens', async () => {
		const { agent, token } = await createAgent({ displayName: 'Chibi notes bot' })
		await createClient({ file: storeFile, name: 'cli-made', rooms: [f.boardId], access: 'write' })
		await createClient({ file: storeFile, name: 'other-board-agent', rooms: ['unrelated-board'], access: 'read' })

		const response = await f.owner.get(listUrl())

		const agents = response.json().agents as Array<{ name: string; ref: string; createdByYou: boolean }>
		expect(agents.map((entry) => entry.name)).toEqual([agent.name, 'cli-made'])
		expect(agents[0]).toMatchObject({ ref: agent.ref, displayName: 'Chibi notes bot', createdByYou: true, status: 'none' })
		expect(agents[1]).toMatchObject({ createdByYou: false })
		expect(agents[1].ref).toBe(refFor('cli-made', storedClients().find((client) => client.name === 'cli-made')!.tokenHash as string))
		expect(response.body).not.toContain(token)
		expect(response.body).not.toContain(sha256(token))
		expect(response.body).not.toContain('tokenHash')
		expect(response.body).not.toContain('unrelated-board')
	})

	it('shows each agent\'s live expiry status', async () => {
		seedStore({
			clients: [
				legacy('forever', [f.boardId]),
				legacy('live', [f.boardId], { expiresAt: '2099-01-01T00:00:00.000Z' }),
				legacy('lapsed', [f.boardId], { expiresAt: '2000-01-01T00:00:00.000Z' }),
				legacy('garbled', [f.boardId], { expiresAt: 'not a date' }),
			],
		})

		const agents = (await f.owner.get(listUrl())).json().agents as Array<{ name: string; status: string }>

		expect(agents.map((entry) => [entry.name, entry.status])).toEqual([['forever', 'none'], ['live', 'active'], ['lapsed', 'expired'], ['garbled', 'invalid']])
	})

	it('shows an owner only their own boards, and only whether others exist, never which', async () => {
		await createOtherOwnersBoard()
		await createClient({ file: storeFile, name: 'spans-both', rooms: [f.boardId, 'other-owners-board'], access: 'read' })

		const ownerView = await f.owner.get(listUrl())
		const otherView = await f.nonmember.get(listUrl('other-owners-board'))

		expect(ownerView.json().agents[0]).toMatchObject({ name: 'spans-both', rooms: [f.boardId], sharedWithOtherBoards: true })
		expect(ownerView.body).not.toContain('other-owners-board')
		expect(otherView.json().agents[0]).toMatchObject({ name: 'spans-both', rooms: ['other-owners-board'], sharedWithOtherBoards: true })
		expect(otherView.body).not.toContain(f.boardId)
	})

	it('does not let an owner read another board\'s agents by naming that board', async () => {
		await createOtherOwnersBoard()
		await createAgent({}, f.nonmember, 'other-owners-board')

		expect((await f.owner.get(listUrl('other-owners-board'))).statusCode).toBe(404)
		expect((await f.owner.get(listUrl())).json()).toEqual({ agents: [] })
	})
})

describe('revoking an agent', () => {
	it('revokes the token at once and removes the agent from the listing', async () => {
		const { agent, token } = await createAgent()
		expect(authorizeApiToken(bearer(token), f.boardId, 'read')).toBe(agent.name)

		const response = await f.owner.delete(`${BASE}/${agent.ref}`)

		expect(response.statusCode).toBe(200)
		expect(response.json()).toEqual({ ok: true })
		expect(authorizeApiToken(bearer(token), f.boardId, 'read')).toBeNull()
		expect((await f.owner.get(listUrl())).json()).toEqual({ agents: [] })
	})

	it('answers 404 the second time, and for a well-formed reference that matches nothing', async () => {
		const { agent } = await createAgent()
		await f.owner.delete(`${BASE}/${agent.ref}`)

		expect((await f.owner.delete(`${BASE}/${agent.ref}`)).statusCode).toBe(404)
		expect((await f.owner.delete(`${BASE}/${NOT_A_REF}`)).statusCode).toBe(404)
	})

	it('leaves the other agents alone', async () => {
		const keep = await createAgent({ displayName: 'keep' })
		const drop = await createAgent({ displayName: 'drop' })

		await f.owner.delete(`${BASE}/${drop.agent.ref}`)

		expect(authorizeApiToken(bearer(keep.token), f.boardId, 'read')).toBe(keep.agent.name)
		expect(authorizeApiToken(bearer(drop.token), f.boardId, 'read')).toBeNull()
	})

	it('cannot reach an agent that belongs to another owner\'s board, even with its exact reference', async () => {
		await createOtherOwnersBoard()
		const theirs = await createAgent({}, f.nonmember, 'other-owners-board')

		const response = await f.owner.delete(`${BASE}/${theirs.agent.ref}`)

		expect(response.statusCode).toBe(404)
		expect(authorizeApiToken(bearer(theirs.token), 'other-owners-board', 'read')).toBe(theirs.agent.name)
	})

	it('refuses to revoke an agent that also reaches a board the caller does not own, from either owner\'s side', async () => {
		await createOtherOwnersBoard()
		const { token } = await createClient({ file: storeFile, name: 'spans-both', rooms: [f.boardId, 'other-owners-board'], access: 'read' })
		const ref = refFor('spans-both', sha256(token))

		const fromFirst = await f.owner.delete(`${BASE}/${ref}`)
		const fromSecond = await f.nonmember.delete(`${BASE}/${ref}`)

		expect(fromFirst.statusCode).toBe(403)
		expect(fromSecond.statusCode).toBe(403)
		expect(fromFirst.json().error).toMatch(/administrator/)
		expect(authorizeApiToken(bearer(token), f.boardId, 'read')).toBe('spans-both')
		expect(authorizeApiToken(bearer(token), 'other-owners-board', 'read')).toBe('spans-both')
	})

	it('lets an owner revoke an agent that spans a board they owned and have since deleted', async () => {
		expect((await f.owner.post('/api/boards', { name: 'Scratch', id: 'scratch-board' })).statusCode).toBe(200)
		const { token } = await createClient({ file: storeFile, name: 'spans-scratch', rooms: [f.boardId, 'scratch-board'], access: 'read' })
		expect((await f.owner.delete('/api/boards/scratch-board')).statusCode).toBe(200)

		const listed = (await f.owner.get(listUrl())).json().agents[0]
		const revoked = await f.owner.delete(`${BASE}/${listed.ref}`)

		expect(listed).toMatchObject({ name: 'spans-scratch', sharedWithOtherBoards: false })
		expect(revoked.statusCode).toBe(200)
		expect(authorizeApiToken(bearer(token), f.boardId, 'read')).toBeNull()
	})

	it('cannot be aimed at a successor that merely reuses the revoked name: 409, and the successor is untouched', async () => {
		await createOtherOwnersBoard()
		const { agent } = await createAgent()
		// The owner's page still shows `agent.ref`. Meanwhile an administrator revokes that agent and registers a
		// different one under the very same name, on another owner's board.
		await revokeClient(storeFile, agent.name)
		const successor = await createClient({ file: storeFile, name: agent.name, rooms: ['other-owners-board'], access: 'full' })

		const stale = await f.owner.delete(`${BASE}/${agent.ref}`)

		expect(stale.statusCode).toBe(409)
		expect(storedClients().map((client) => client.name)).toEqual([agent.name])
		expect(authorizeApiToken(bearer(successor.token), 'other-owners-board', 'restore')).toBe(agent.name)
	})

	it('is refused the same way when the successor sits on the owner\'s own board', async () => {
		const { agent } = await createAgent()
		await revokeClient(storeFile, agent.name)
		const successor = await createClient({ file: storeFile, name: agent.name, rooms: [f.boardId], access: 'full' })

		expect((await f.owner.delete(`${BASE}/${agent.ref}`)).statusCode).toBe(409)
		expect(authorizeApiToken(bearer(successor.token), f.boardId, 'restore')).toBe(agent.name)
	})
})

describe('rotating an agent', () => {
	it('issues a new token, kills the old one at once, and keeps everything else about the agent', async () => {
		const expiresAt = inOneHour()
		const { agent, token: oldToken } = await createAgent({ displayName: 'Chibi notes bot', access: 'read-write', expiresAt })
		const [before] = storedClients()

		const response = await f.owner.post(`${BASE}/${agent.ref}/rotate`, {})

		expect(response.statusCode).toBe(200)
		expect(response.headers['cache-control']).toBe('no-store')
		const { agent: after, token: newToken } = response.json()
		expect(newToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
		expect(newToken).not.toBe(oldToken)
		expect(authorizeApiToken(bearer(oldToken), f.boardId, 'read')).toBeNull()
		expect(authorizeApiToken(bearer(newToken), f.boardId, 'write')).toBe(agent.name)
		expect(authorizeApiToken(bearer(newToken), f.boardId, 'history')).toBeNull()
		expect(after).toMatchObject({ name: agent.name, displayName: 'Chibi notes bot', permissions: ['read', 'write'], rooms: [f.boardId], expiresAt })
		expect(typeof after.rotatedAt).toBe('string')
		expect(after.ref).toBe(refFor(agent.name, sha256(newToken)))
		expect(after.ref).not.toBe(agent.ref)
		const [stored] = storedClients()
		expect(stored).toMatchObject({ name: agent.name, rooms: [f.boardId], permissions: ['read', 'write'], displayName: 'Chibi notes bot', createdByUserId: f.owner.userId, createdAt: before.createdAt, expiresAt, tokenHash: sha256(newToken) })
		expect(typeof stored.rotatedAt).toBe('string')
		expect(storedClients()).toHaveLength(1)
	})

	it('never writes the new token anywhere but the response', async () => {
		const { agent } = await createAgent()

		const { token } = (await f.owner.post(`${BASE}/${agent.ref}/rotate`, {})).json()

		expect(readFileSync(storeFile, 'utf8')).not.toContain(token)
		for (const event of await accountEvents()) expect(event.metadata_json).not.toContain(token)
	})

	it('shows the rotated agent in the listing under its new reference', async () => {
		const { agent } = await createAgent()
		const { agent: rotated } = (await f.owner.post(`${BASE}/${agent.ref}/rotate`, {})).json()

		const listed = (await f.owner.get(listUrl())).json().agents

		expect(listed).toHaveLength(1)
		expect(listed[0]).toMatchObject({ ref: rotated.ref, name: agent.name, rotatedAt: rotated.rotatedAt })
	})

	it('replaces the expiry when one is supplied, and only then', async () => {
		const { agent } = await createAgent({ expiresAt: inOneHour() })
		const later = new Date(Date.now() + 7 * 86_400_000).toISOString()

		const response = await f.owner.post(`${BASE}/${agent.ref}/rotate`, { expiresAt: later })

		expect(response.statusCode).toBe(200)
		expect(response.json().agent).toMatchObject({ expiresAt: later, status: 'active' })
		expect(storedClients()[0].expiresAt).toBe(later)
	})

	it('refuses to rotate an expired agent into another dead token, and writes nothing', async () => {
		seedStore({ clients: [legacy('lapsed', [f.boardId], { expiresAt: '2000-01-01T00:00:00.000Z' })] })
		const before = storeBytes()
		const ref = refFor('lapsed', sha256('lapsed'))

		const response = await f.owner.post(`${BASE}/${ref}/rotate`, {})

		expect(response.statusCode).toBe(422)
		expect(response.json().error).toMatch(/expired/)
		expect(storeBytes()).toBe(before)
	})

	it('brings an expired agent back to life when a new expiry is supplied', async () => {
		seedStore({ clients: [legacy('lapsed', [f.boardId], { expiresAt: '2000-01-01T00:00:00.000Z' })] })
		const ref = refFor('lapsed', sha256('lapsed'))
		const expiresAt = inOneHour()

		const response = await f.owner.post(`${BASE}/${ref}/rotate`, { expiresAt })

		expect(response.statusCode).toBe(200)
		expect(authorizeApiToken(bearer(response.json().token), f.boardId, 'read')).toBe('lapsed')
	})

	it('rotates a legacy agent made before any metadata existed', async () => {
		seedStore({ clients: [legacy('old-timer', [f.boardId])] })
		const ref = refFor('old-timer', sha256('old-timer'))

		const response = await f.owner.post(`${BASE}/${ref}/rotate`, {})

		expect(response.statusCode).toBe(200)
		expect(response.json().agent).toMatchObject({ name: 'old-timer', status: 'none' })
		expect(response.json().agent).not.toHaveProperty('displayName')
		expect(authorizeApiToken(bearer(response.json().token), f.boardId, 'read')).toBe('old-timer')
	})

	it('treats a second rotation with the same reference as stale: 409, and nothing changes', async () => {
		const { agent } = await createAgent()
		const first = (await f.owner.post(`${BASE}/${agent.ref}/rotate`, {})).json()
		const before = storeBytes()

		const second = await f.owner.post(`${BASE}/${agent.ref}/rotate`, {})

		expect(second.statusCode).toBe(409)
		expect(storeBytes()).toBe(before)
		expect(authorizeApiToken(bearer(first.token), f.boardId, 'read')).toBe(agent.name)
	})

	it('cannot be aimed at a successor that reuses the name: 409, and the successor keeps its token', async () => {
		const { agent } = await createAgent()
		await revokeClient(storeFile, agent.name)
		const successor = await createClient({ file: storeFile, name: agent.name, rooms: [f.boardId], access: 'full' })

		const response = await f.owner.post(`${BASE}/${agent.ref}/rotate`, {})

		expect(response.statusCode).toBe(409)
		expect(authorizeApiToken(bearer(successor.token), f.boardId, 'restore')).toBe(agent.name)
	})

	it('refuses an unknown field in the body, and an unreadable expiry', async () => {
		const { agent } = await createAgent()
		const before = storeBytes()

		expect((await f.owner.post(`${BASE}/${agent.ref}/rotate`, { access: 'full' })).statusCode).toBe(422)
		expect((await f.owner.post(`${BASE}/${agent.ref}/rotate`, { rooms: ['x'] })).statusCode).toBe(422)
		expect((await f.owner.post(`${BASE}/${agent.ref}/rotate`, { expiresAt: 'tomorrow' })).statusCode).toBe(422)
		expect((await f.owner.post(`${BASE}/${agent.ref}/rotate`, { expiresAt: '2000-01-01T00:00:00Z' })).statusCode).toBe(422)
		expect(storeBytes()).toBe(before)
	})

	it('applies the ownership rule: 404 for a stranger\'s agent, 403 for one that also reaches a board the caller does not own', async () => {
		await createOtherOwnersBoard()
		const theirs = await createAgent({}, f.nonmember, 'other-owners-board')
		const { token } = await createClient({ file: storeFile, name: 'spans-both', rooms: [f.boardId, 'other-owners-board'], access: 'read' })
		const spans = refFor('spans-both', sha256(token))
		const before = storeBytes()

		expect((await f.owner.post(`${BASE}/${theirs.agent.ref}/rotate`, {})).statusCode).toBe(404)
		expect((await f.owner.post(`${BASE}/${spans}/rotate`, {})).statusCode).toBe(403)
		expect((await f.nonmember.post(`${BASE}/${spans}/rotate`, {})).statusCode).toBe(403)
		expect(storeBytes()).toBe(before)
	})

	it('leaves the other agents alone, and the order of the store', async () => {
		const first = await createAgent({ displayName: 'first' })
		const middle = await createAgent({ displayName: 'middle' })
		const last = await createAgent({ displayName: 'last' })

		await f.owner.post(`${BASE}/${middle.agent.ref}/rotate`, {})

		expect(storedClients().map((client) => client.displayName)).toEqual(['first', 'middle', 'last'])
		expect(authorizeApiToken(bearer(first.token), f.boardId, 'read')).toBe(first.agent.name)
		expect(authorizeApiToken(bearer(last.token), f.boardId, 'read')).toBe(last.agent.name)
		expect(authorizeApiToken(bearer(middle.token), f.boardId, 'read')).toBeNull()
	})

	it('answers 503 and changes nothing while another operation holds the store lock', async () => {
		const { agent } = await createAgent()
		writeFileSync(`${storeFile}.lock`, 'held-by-the-cli\n', { mode: 0o600 })
		const before = storeBytes()

		const response = await f.owner.post(`${BASE}/${agent.ref}/rotate`, {})

		expect(response.statusCode).toBe(503)
		expect(storeBytes()).toBe(before)
	})
})

describe('the audit trail', () => {
	it('records who created, rotated and revoked which agent on which board, and never a token', async () => {
		const { agent, token } = await createAgent({ displayName: 'audited', access: 'full', expiresAt: inOneHour() })
		const rotated = (await f.owner.post(`${BASE}/${agent.ref}/rotate`, {})).json()
		await f.owner.delete(`${BASE}/${rotated.agent.ref}`)

		const events = await accountEvents()

		expect(events.map((event) => event.type)).toEqual(['agent.created', 'agent.rotated', 'agent.revoked'])
		for (const event of events) {
			expect(event.actor_user_id).toBe(f.owner.userId)
			expect(event.board_id).toBe(f.boardId)
			for (const secret of [token, rotated.token, sha256(token), sha256(rotated.token)]) expect(event.metadata_json).not.toContain(secret)
			expect(JSON.parse(event.metadata_json).agent).toBe(agent.name)
		}
		expect(JSON.parse(events[0].metadata_json)).toMatchObject({ displayName: 'audited', access: 'full', fingerprint: agent.ref.split('.')[1] })
		expect(JSON.parse(events[1].metadata_json)).toMatchObject({ previousFingerprint: agent.ref.split('.')[1], fingerprint: rotated.agent.ref.split('.')[1] })
		expect(JSON.parse(events[2].metadata_json)).toMatchObject({ fingerprint: rotated.agent.ref.split('.')[1] })
	})

	it('records one event per board when an agent that spans several of the caller\'s boards is rotated or revoked', async () => {
		expect((await f.owner.post('/api/boards', { name: 'Second', id: 'second-board' })).statusCode).toBe(200)
		const { token } = await createClient({ file: storeFile, name: 'spans-two', rooms: [f.boardId, 'second-board'], access: 'read' })
		const rotated = (await f.owner.post(`${BASE}/${refFor('spans-two', sha256(token))}/rotate`, {})).json()
		await f.owner.delete(`${BASE}/${rotated.agent.ref}`)

		const events = await accountEvents()

		expect(events.map((event) => [event.type, event.board_id])).toEqual([
			['agent.rotated', f.boardId], ['agent.rotated', 'second-board'], ['agent.revoked', f.boardId], ['agent.revoked', 'second-board'],
		])
	})

	it('records nothing for a refused request', async () => {
		const { agent } = await createAgent()
		const created = (await accountEvents()).length
		await f.editor.post(BASE, { boardId: f.boardId, displayName: 'x', access: 'read' })
		await f.owner.post(BASE, { boardId: f.boardId, displayName: 'x', access: 'sudo' })
		await f.owner.delete(`${BASE}/${NOT_A_REF}`)
		await f.owner.post(`${BASE}/${NOT_A_REF}/rotate`, {})
		await f.nonmember.delete(`${BASE}/${agent.ref}`)
		await f.owner.post(`${BASE}/${agent.ref}.0000/rotate`, {})

		expect((await accountEvents()).length).toBe(created)
	})
})

describe('the request budget', () => {
	it('answers 429 once a user spends it, without affecting anyone else', async () => {
		await f.cleanup()
		f = await createAcceptanceFixture({ rateLimits: { agentAccess: { limit: 3, windowMs: 60_000 } } })
		process.env.CANVAS_API_TOKENS_FILE = storeFile

		for (let index = 0; index < 3; index += 1) expect((await f.owner.get(listUrl())).statusCode).toBe(200)
		const refused = await f.owner.get(listUrl())

		expect(refused.statusCode).toBe(429)
		expect((await f.nonmember.get(listUrl())).statusCode).toBe(404)
	})

	it('counts rotate and revoke against the same budget', async () => {
		await f.cleanup()
		f = await createAcceptanceFixture({ rateLimits: { agentAccess: { limit: 2, windowMs: 60_000 } } })
		process.env.CANVAS_API_TOKENS_FILE = storeFile

		expect((await f.owner.post(`${BASE}/${NOT_A_REF}/rotate`, {})).statusCode).toBe(404)
		expect((await f.owner.delete(`${BASE}/${NOT_A_REF}`)).statusCode).toBe(404)
		expect((await f.owner.delete(`${BASE}/${NOT_A_REF}`)).statusCode).toBe(429)
	})
})

describe('the machine hostname and the browser hostname', () => {
	const MACHINE_HOST = 'whiteboard-api.example.test'
	const HUMAN_HOST = 'whiteboard.example.test'
	const ORIGIN = 'http://127.0.0.1:8787'
	const accessVerifier: AccessVerifier = { async verify(assertion) { return assertion === 'valid' ? { ok: true, clientId: 'svc' } : { ok: false, reason: 'invalid' } } }

	it('serves these routes on neither: 404 on the machine host, 401 for any bearer on the browser host', async () => {
		const directory = mkdtempSync(join(tmpdir(), 'agent-access-hosts-'))
		const app = await buildApp({ dataDirectory: directory, clientDirectory: directory, logger: false, hostPolicy: { publicHost: HUMAN_HOST, machineHost: MACHINE_HOST, accessVerifier } })
		try {
			const registered = await app.inject({ method: 'POST', url: '/api/auth/register', headers: { host: HUMAN_HOST, origin: ORIGIN }, payload: { login: 'owner', displayName: 'Owner', password: 'correct horse battery staple' } })
			const cookie = `${registered.cookies[0].name}=${registered.cookies[0].value}`
			await app.inject({ method: 'POST', url: '/api/boards', headers: { host: HUMAN_HOST, origin: ORIGIN, cookie }, payload: { name: 'b', id: 'board-x' } })

			const human = await app.inject({ method: 'GET', url: `${BASE}?boardId=board-x`, headers: { host: HUMAN_HOST, cookie } })
			expect(human.statusCode).toBe(200)

			const attempts: Array<['GET' | 'POST' | 'DELETE', string, unknown]> = [
				['GET', `${BASE}?boardId=board-x`, undefined],
				['POST', BASE, { boardId: 'board-x', displayName: 'x', access: 'read' }],
				['POST', `${BASE}/${NOT_A_REF}/rotate`, {}],
				['DELETE', `${BASE}/${NOT_A_REF}`, undefined],
			]
			for (const [method, url, payload] of attempts) {
				const onMachine = await app.inject({ method, url, headers: { host: MACHINE_HOST, 'cf-access-jwt-assertion': 'valid', cookie, origin: ORIGIN }, ...(payload === undefined ? {} : { payload: payload as object }) })
				expect(onMachine.statusCode, `${method} ${url} on the machine host`).toBe(404)
				const withBearer = await app.inject({ method, url, headers: { host: HUMAN_HOST, authorization: bearer('b'.repeat(43)), cookie, origin: ORIGIN }, ...(payload === undefined ? {} : { payload: payload as object }) })
				expect(withBearer.statusCode, `${method} ${url} with a bearer on the browser host`).toBe(401)
			}
		} finally {
			await app.close()
			rmSync(directory, { recursive: true, force: true })
		}
	})
})
