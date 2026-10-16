/**
 * Board-creating credentials in the token store (`accountClients`), and the locked create-and-grant operation.
 *
 * What these pin down:
 *   - a creator lives in `accountClients`, never in `clients`, so the invariant every reader enforces on `clients`
 *     ("at least one room") is untouched and a creator with no boards cannot make the whole file unreadable;
 *   - every mutation (create, revoke, rotate, grant) edits the raw object in place, so `accountClients`, unknown
 *     top-level keys and unknown per-client fields survive, and a store that never had the key never gains it;
 *   - `grantNewBoard` creates the board and adds the room under one lock, in that order, with a compensation path,
 *     and its failure modes never leave a grant to a board that does not exist.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
	ACCESS_MODES,
	BOARD_CREATE_PERMISSION,
	MAX_ACCOUNT_CLIENTS,
	MAX_ROOMS_PER_CLIENT,
	TokenStoreError,
	accountClientsOf,
	clientFingerprint,
	createAccountClient,
	createClient,
	describeClients,
	grantNewBoard,
	listClients,
	readStore,
	revokeClient,
	rotateClient,
} from '../server/token-store.mjs'

let directory: string
let file: string

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
const raw = () => readFileSync(file, 'utf8')
const parsed = () => JSON.parse(raw()) as { clients: Array<Record<string, unknown>>; accountClients?: Array<Record<string, unknown>>; [key: string]: unknown }
const seed = (contents: unknown) => writeFileSync(file, `${JSON.stringify(contents, null, 2)}\n`, { mode: 0o600 })
const backups = () => readdirSync(directory).filter((name) => name.endsWith('.bak'))
const leftovers = () => readdirSync(directory).filter((name) => name.endsWith('.tmp') || name.endsWith('.lock'))
const legacy = (name: string, rooms = ['board-a']) => ({ name, tokenHash: sha256(name), rooms, permissions: ['read'] })
const OWNER = 'user-owner-0001'

async function makeCreator(extra: Partial<Parameters<typeof createAccountClient>[0]> = {}) {
	return createAccountClient({ file, name: 'creator-one', ownerUserId: OWNER, access: 'read-write-history', displayName: 'Creator', ...extra })
}

/** The mutation-lock and failpoint environment must never leak between tests. */
const FAILPOINT = 'CANVAS_API_TOKENS_TEST_FAILPOINT'

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), 'token-store-accounts-'))
	file = join(directory, 'api-tokens.json')
})

afterEach(() => {
	delete process.env[FAILPOINT]
	rmSync(directory, { recursive: true, force: true })
})

describe('the read-write-history access mode', () => {
	it('is read, write and history, and deliberately not restore', () => {
		expect([...ACCESS_MODES['read-write-history']]).toEqual(['read', 'write', 'history'])
		expect(ACCESS_MODES['read-write-history']).not.toContain('restore')
	})

	it('can be used for an ordinary client too', async () => {
		await createClient({ file, name: 'plain', rooms: ['board-a'], access: 'read-write-history' })
		expect(parsed().clients[0].permissions).toEqual(['read', 'write', 'history'])
	})
})

describe('createAccountClient', () => {
	it('stores the credential in accountClients with no boards, and leaves clients alone', async () => {
		seed({ clients: [legacy('old')] })
		const created = await makeCreator({ expiresAt: new Date(Date.now() + 86_400_000) })
		const store = parsed()

		expect(store.clients).toEqual([legacy('old')])
		expect(store.accountClients).toHaveLength(1)
		const [record] = store.accountClients!
		expect(record).toMatchObject({
			name: 'creator-one',
			ownerUserId: OWNER,
			accountPermissions: [BOARD_CREATE_PERMISSION],
			permissions: ['read', 'write', 'history'],
			rooms: [],
			displayName: 'Creator',
		})
		expect(typeof record.createdAt).toBe('string')
		expect(typeof record.expiresAt).toBe('string')
		expect(created.fingerprint).toBe(clientFingerprint(record.tokenHash as string))
	})

	it('persists only the hash of the token, and returns the token once', async () => {
		const created = await makeCreator()
		expect(created.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
		expect(raw()).not.toContain(created.token)
		expect(parsed().accountClients![0].tokenHash).toBe(sha256(created.token))
		expect(JSON.stringify(created)).toContain(created.token) // returned to the caller...
		expect(JSON.stringify(await describeClients(file))).not.toContain(created.token) // ...and never listed again
	})

	it('refuses bad input without writing anything', async () => {
		seed({ clients: [legacy('old')] })
		const before = raw()
		await expect(makeCreator({ access: 'root' })).rejects.toMatchObject({ code: 'invalid-access' })
		await expect(makeCreator({ ownerUserId: '' })).rejects.toMatchObject({ code: 'invalid-creator' })
		await expect(makeCreator({ ownerUserId: undefined as never })).rejects.toMatchObject({ code: 'invalid-creator' })
		await expect(makeCreator({ name: 'bad name!' })).rejects.toMatchObject({ code: 'invalid-name' })
		await expect(makeCreator({ expiresAt: '2001-01-01T00:00:00Z' })).rejects.toMatchObject({ code: 'invalid-expiry' })
		expect(raw()).toBe(before)
		expect(backups()).toEqual([])
	})

	it(`refuses the ${MAX_ACCOUNT_CLIENTS + 1}th creator and leaves the store as it was`, async () => {
		for (let index = 0; index < MAX_ACCOUNT_CLIENTS; index += 1) await makeCreator({ name: `creator-${index}` })
		const before = raw()
		await expect(makeCreator({ name: 'one-too-many' })).rejects.toMatchObject({ code: 'store-full' })
		expect(raw()).toBe(before)
	})

	it('shares one name space with ordinary clients, in both directions', async () => {
		seed({ clients: [legacy('taken-by-client')] })
		await expect(makeCreator({ name: 'taken-by-client' })).rejects.toMatchObject({ code: 'duplicate-name' })
		await makeCreator({ name: 'taken-by-creator' })
		await expect(createClient({ file, name: 'taken-by-creator', rooms: ['board-a'], access: 'read' })).rejects.toMatchObject({ code: 'duplicate-name' })
	})

	it('preserves unknown top-level keys and unknown fields on every existing record', async () => {
		const existing = { ...legacy('old'), futureField: { nested: [1, 2, 3] } }
		seed({ schemaVersion: 9, somethingElse: { a: 1 }, clients: [existing] })
		await makeCreator()
		const store = parsed()
		expect(store.schemaVersion).toBe(9)
		expect(store.somethingElse).toEqual({ a: 1 })
		expect(store.clients).toEqual([existing])
	})

	it('refuses to overwrite an accountClients value that is not an array', async () => {
		seed({ clients: [legacy('old')], accountClients: { surprise: true } })
		const before = raw()
		await expect(makeCreator()).rejects.toMatchObject({ code: 'invalid-store' })
		expect(raw()).toBe(before)
	})

	it('accountClientsOf tolerates a missing or malformed collection', async () => {
		expect(accountClientsOf({ clients: [] })).toEqual([])
		expect(accountClientsOf({ clients: [], accountClients: 'nope' })).toEqual([])
	})
})

describe('revoke, rotate and listing span both collections', () => {
	it('revokes a creator by name and fingerprint without touching anything else', async () => {
		seed({ keep: true, clients: [legacy('old')] })
		const created = await makeCreator()
		await revokeClient(file, 'creator-one', { fingerprint: created.fingerprint })
		const store = parsed()
		expect(store.accountClients).toEqual([])
		expect(store.clients).toEqual([legacy('old')])
		expect(store.keep).toBe(true)
	})

	it('revoking an ordinary client from a store with no accountClients does not add the key', async () => {
		seed({ clients: [legacy('old'), legacy('other')] })
		await revokeClient(file, 'old')
		expect(Object.keys(parsed())).toEqual(['clients'])
	})

	it('a stale fingerprint is refused and changes nothing', async () => {
		await makeCreator()
		const before = raw()
		await expect(revokeClient(file, 'creator-one', { fingerprint: '0000000000000000' })).rejects.toMatchObject({ code: 'stale-reference' })
		expect(raw()).toBe(before)
	})

	it('hands the creator record to the caller\'s authorise callback, inside the lock', async () => {
		const created = await makeCreator()
		let seen: Record<string, unknown> | undefined
		await rotateClient({ file, name: 'creator-one', fingerprint: created.fingerprint, authorise: (client) => { seen = client } })
		expect(seen).toMatchObject({ name: 'creator-one', ownerUserId: OWNER })
		await expect(
			revokeClient(file, 'creator-one', { authorise: () => { throw new Error('not yours') } }),
		).rejects.toThrow('not yours')
		expect(parsed().accountClients).toHaveLength(1)
	})

	it('rotation replaces the credential and keeps the owner, capability, permissions and boards', async () => {
		const created = await makeCreator()
		const before = parsed().accountClients![0]
		const rotated = await rotateClient({ file, name: 'creator-one', fingerprint: created.fingerprint })
		const after = parsed().accountClients![0]
		expect(after.tokenHash).not.toBe(before.tokenHash)
		expect(after.tokenHash).toBe(sha256(rotated.token))
		expect(rotated.fingerprint).not.toBe(created.fingerprint)
		for (const key of ['name', 'ownerUserId', 'accountPermissions', 'permissions', 'rooms', 'createdAt', 'displayName']) expect(after[key]).toEqual(before[key])
		expect(typeof after.rotatedAt).toBe('string')
	})

	it('lists creators with their capability and owner, and never a hash', async () => {
		seed({ clients: [legacy('old')] })
		await makeCreator()
		const described = await describeClients(file)
		expect(described.map((client) => client.name).sort()).toEqual(['creator-one', 'old'])
		const creator = described.find((client) => client.name === 'creator-one')!
		expect(creator).toMatchObject({ accountPermissions: ['board:create'], ownerUserId: OWNER, rooms: [], status: 'none' })
		const ordinary = described.find((client) => client.name === 'old')!
		expect(Object.keys(ordinary)).not.toContain('accountPermissions')
		expect(Object.keys(ordinary)).not.toContain('ownerUserId')
		expect(JSON.stringify(described)).not.toMatch(/tokenHash|[0-9a-f]{64}/)
		expect((await listClients(file)).map((client) => client.name).sort()).toEqual(['creator-one', 'old'])
	})
})

describe('grantNewBoard', () => {
	const request = (overrides: Record<string, unknown> = {}) => ({
		file,
		name: 'creator-one',
		fingerprint: '',
		prepare: () => 'board-new',
		rollback: () => {},
		...overrides,
	})

	async function readyCreator(mutate?: (record: Record<string, unknown>) => void) {
		const created = await makeCreator()
		if (mutate) {
			const store = parsed()
			mutate(store.accountClients![0])
			seed(store)
		}
		return created
	}

	it('creates the board first, then grants the room, in one operation', async () => {
		const created = await readyCreator()
		const backupsBefore = backups().length
		const order: string[] = []
		const result = await grantNewBoard(request({
			fingerprint: created.fingerprint,
			prepare: (client: { ownerUserId: string; rooms: string[] }) => {
				order.push(`prepare(owner=${client.ownerUserId}, rooms=${client.rooms.length}, onDisk=${parsed().accountClients![0].rooms.length})`)
				return 'board-new'
			},
		}))
		expect(order).toEqual([`prepare(owner=${OWNER}, rooms=0, onDisk=0)`]) // the board exists before the grant is on disk
		expect(result).toEqual({ boardId: 'board-new', rooms: ['board-new'] })
		expect(parsed().accountClients![0].rooms).toEqual(['board-new'])
		expect(backups()).toHaveLength(backupsBefore + 1) // the grant is backed up like every other mutation
		expect(leftovers()).toEqual([])
	})

	it('adds boards one after another and keeps everything else about the credential', async () => {
		const created = await readyCreator()
		const before = parsed().accountClients![0]
		await grantNewBoard(request({ fingerprint: created.fingerprint, prepare: () => 'board-one' }))
		await grantNewBoard(request({ fingerprint: created.fingerprint, prepare: () => 'board-two' }))
		const after = parsed().accountClients![0]
		expect(after.rooms).toEqual(['board-one', 'board-two'])
		expect({ ...after, rooms: [] }).toEqual({ ...before, rooms: [] })
	})

	it('refuses everything it can refuse BEFORE creating a board, and writes nothing', async () => {
		const created = await readyCreator()
		const calls: string[] = []
		const prepare = () => { calls.push('prepare'); return 'never' }
		const before = raw()

		await expect(grantNewBoard(request({ fingerprint: '0000000000000000', prepare }))).rejects.toMatchObject({ code: 'stale-reference' })
		await expect(grantNewBoard(request({ name: 'does-not-exist', fingerprint: created.fingerprint, prepare }))).rejects.toMatchObject({ code: 'not-found' })
		await expect(grantNewBoard(request({ name: 'bad name', fingerprint: created.fingerprint, prepare }))).rejects.toMatchObject({ code: 'invalid-name' })
		expect(calls).toEqual([])
		expect(raw()).toBe(before)
	})

	it('refuses a record without the capability, an expired one and an unreadable expiry', async () => {
		const noCapability = await readyCreator((record) => { record.accountPermissions = [] })
		const calls: string[] = []
		const prepare = () => { calls.push('prepare'); return 'never' }
		await expect(grantNewBoard(request({ fingerprint: noCapability.fingerprint, prepare }))).rejects.toMatchObject({ code: 'no-capability' })

		rmSync(file)
		const expired = await readyCreator()
		const store = parsed()
		store.accountClients![0].expiresAt = '2001-01-01T00:00:00.000Z'
		seed(store)
		await expect(grantNewBoard(request({ fingerprint: expired.fingerprint, prepare }))).rejects.toMatchObject({ code: 'expired' })

		store.accountClients![0].expiresAt = 'next tuesday'
		seed(store)
		await expect(grantNewBoard(request({ fingerprint: expired.fingerprint, prepare }))).rejects.toMatchObject({ code: 'expired' })
		expect(calls).toEqual([])
	})

	it('does not treat an ordinary client of the same name as a creator', async () => {
		seed({ clients: [legacy('creator-one')] })
		const calls: string[] = []
		await expect(
			grantNewBoard(request({ fingerprint: clientFingerprint(sha256('creator-one')), prepare: () => { calls.push('prepare'); return 'never' } })),
		).rejects.toMatchObject({ code: 'stale-reference' })
		expect(calls).toEqual([])
	})

	it(`rechecks the ${MAX_ROOMS_PER_CLIENT}-board cap inside the lock, immediately before creating`, async () => {
		const created = await readyCreator((record) => { record.rooms = Array.from({ length: MAX_ROOMS_PER_CLIENT - 1 }, (_, index) => `board-${index}`) })
		const prepared: string[] = []
		const prepare = () => { prepared.push('board-last'); return 'board-last' }
		await grantNewBoard(request({ fingerprint: created.fingerprint, prepare })) // the 50th is allowed
		expect(parsed().accountClients![0].rooms).toHaveLength(MAX_ROOMS_PER_CLIENT)

		const before = raw()
		await expect(grantNewBoard(request({ fingerprint: created.fingerprint, prepare }))).rejects.toMatchObject({ code: 'room-limit' }) // the 51st is not
		expect(prepared).toEqual(['board-last']) // the board for the refused call was never created
		expect(raw()).toBe(before)
	})

	it('leaves the store untouched, with no backup, when creating the board fails', async () => {
		const created = await readyCreator()
		const before = raw()
		const backupsBefore = backups().length
		await expect(grantNewBoard(request({ fingerprint: created.fingerprint, prepare: () => { throw new Error('database is on fire') } }))).rejects.toThrow('database is on fire')
		expect(raw()).toBe(before)
		expect(backups()).toHaveLength(backupsBefore)
		expect(leftovers()).toEqual([])
	})

	it('rolls the board back when the grant cannot be persisted, and leaves the store byte-identical', async () => {
		const created = await readyCreator()
		const before = raw()
		const rolledBack: string[] = []
		process.env[FAILPOINT] = 'before-rename'
		await expect(
			grantNewBoard(request({ fingerprint: created.fingerprint, prepare: () => 'board-new', rollback: (id: string) => { rolledBack.push(id) } })),
		).rejects.toThrow('Injected failure')
		delete process.env[FAILPOINT]
		expect(rolledBack).toEqual(['board-new'])
		expect(raw()).toBe(before)
		expect(parsed().accountClients![0].rooms).toEqual([])
		expect(leftovers()).toEqual([])
		// The lock was released: the next attempt works.
		await grantNewBoard(request({ fingerprint: created.fingerprint, prepare: () => 'board-second' }))
		expect(parsed().accountClients![0].rooms).toEqual(['board-second'])
	})

	it('keeps the board when the grant turns out to be on disk after all', async () => {
		const created = await readyCreator()
		const rolledBack: string[] = []
		process.env[FAILPOINT] = 'before-rename'
		const result = await grantNewBoard(request({
			fingerprint: created.fingerprint,
			// Simulates a failure AFTER the rename: the grant is on disk by the time the error surfaces.
			prepare: () => {
				const store = parsed()
				store.accountClients![0].rooms = ['board-new']
				seed(store)
				return 'board-new'
			},
			rollback: (id: string) => { rolledBack.push(id) },
		}))
		delete process.env[FAILPOINT]
		expect(result.boardId).toBe('board-new')
		expect(rolledBack).toEqual([])
	})

	it('reports rollback-failed with the orphaned board id when the compensation itself fails', async () => {
		const created = await readyCreator()
		process.env[FAILPOINT] = 'before-rename'
		const error = await grantNewBoard(request({
			fingerprint: created.fingerprint,
			prepare: () => 'board-orphan',
			rollback: () => { throw new Error('cannot delete') },
		})).catch((caught: unknown) => caught)
		delete process.env[FAILPOINT]
		expect(error).toBeInstanceOf(TokenStoreError)
		expect(error).toMatchObject({ code: 'rollback-failed', boardId: 'board-orphan' })
		expect((error as { cause?: Error }).cause?.message).toContain('Injected failure')
		expect(parsed().accountClients![0].rooms).toEqual([]) // never a grant to the orphan
	})

	it('rejects a prepare that does not return a usable board id, and undoes a board it did make', async () => {
		const created = await readyCreator()
		const rolledBack: string[] = []
		const rollback = (id: string) => { rolledBack.push(id) }
		await expect(grantNewBoard(request({ fingerprint: created.fingerprint, prepare: () => 'has spaces!', rollback }))).rejects.toThrow(TypeError)
		await expect(grantNewBoard(request({ fingerprint: created.fingerprint, prepare: () => Promise.resolve('board-async'), rollback }))).rejects.toThrow(TypeError)
		expect(rolledBack).toEqual(['has spaces!']) // a string was returned, so it is undone; a promise cannot be
		expect(parsed().accountClients![0].rooms).toEqual([])
	})

	it('serialises concurrent grants on the lock: the loser is told the store is locked, never a lost update', async () => {
		const created = await readyCreator()
		const outcomes = await Promise.allSettled([
			grantNewBoard(request({ fingerprint: created.fingerprint, prepare: () => 'board-x' })),
			grantNewBoard(request({ fingerprint: created.fingerprint, prepare: () => 'board-y' })),
		])
		const rooms = parsed().accountClients![0].rooms as string[]
		const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled').length
		expect(fulfilled).toBeGreaterThanOrEqual(1)
		expect(rooms).toHaveLength(fulfilled) // every success is on disk, every failure is not
		for (const outcome of outcomes) if (outcome.status === 'rejected') expect(outcome.reason).toMatchObject({ code: 'locked' })
	})

	it('preserves unknown top-level keys, ordinary clients and unknown fields on the creator', async () => {
		seed({ schemaVersion: 4, clients: [legacy('old')] })
		const created = await makeCreator()
		const store = parsed()
		store.accountClients![0].futureField = { keep: 'me' }
		seed(store)
		await grantNewBoard(request({ fingerprint: created.fingerprint }))
		const after = parsed()
		expect(after.schemaVersion).toBe(4)
		expect(after.clients).toEqual([legacy('old')])
		expect(after.accountClients![0].futureField).toEqual({ keep: 'me' })
	})

	it('never writes the bearer or its hash anywhere new', async () => {
		const created = await readyCreator()
		await grantNewBoard(request({ fingerprint: created.fingerprint }))
		const everything = [raw(), ...backups().map((name) => readFileSync(join(directory, name), 'utf8'))].join('\n')
		expect(everything).not.toContain(created.token)
		expect(existsSync(`${file}.lock`)).toBe(false)
	})
})

describe('readStore', () => {
	it('still requires clients to be an array and says nothing about accountClients', async () => {
		seed({ clients: [], accountClients: 'whatever' })
		await expect(readStore(file)).resolves.toMatchObject({ data: { clients: [] } })
		seed({ accountClients: [] })
		await expect(readStore(file)).rejects.toMatchObject({ code: 'invalid-store' })
	})
})
