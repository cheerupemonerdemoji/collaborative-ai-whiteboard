/**
 * Expiry enforcement in the request-time reader (server/tokens.ts).
 *
 * The contract, each line pinned below:
 *   - no `expiresAt` means the client never expires (every pre-expiry registration);
 *   - a future `expiresAt` authorizes; at the instant of expiry and after, it does not;
 *   - an `expiresAt` the reader cannot read fails CLOSED for that client only;
 *   - an expired token is indistinguishable from an unknown one over HTTP;
 *   - one client's expiry never affects another's.
 *
 * Every test pins the clock through the `now` parameter, so none of them can
 * start failing because the real date moved.
 */

import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildApp } from '../server/app'
import { createClient } from '../server/token-store.mjs'
import { authorizeApiToken, type ApiPermission } from '../server/tokens'

const digest = (token: string) => createHash('sha256').update(token).digest('hex')
const previous = process.env.CANVAS_API_TOKENS_FILE
const directories: string[] = []

afterEach(() => {
	if (previous === undefined) delete process.env.CANVAS_API_TOKENS_FILE
	else process.env.CANVAS_API_TOKENS_FILE = previous
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function directory(): string {
	const created = mkdtempSync(join(tmpdir(), 'canvas-token-expiry-'))
	directories.push(created)
	return created
}

/** Writes a store verbatim and points the reader at it. */
function storeContaining(contents: unknown): string {
	const file = join(directory(), 'api-tokens.json')
	writeFileSync(file, JSON.stringify(contents, null, 2), { mode: 0o600 })
	process.env.CANVAS_API_TOKENS_FILE = file
	return file
}

const client = (name: string, token: string, extra: Record<string, unknown> = {}) => ({
	name,
	tokenHash: digest(token),
	rooms: ['board-a'],
	permissions: ['read', 'write'],
	...extra,
})

const bearer = (token: string) => `Bearer ${token}`
const fresh = () => randomBytes(32).toString('base64url')
const EXPIRY = '2026-11-01T00:00:00.000Z'
const expiryMs = Date.parse(EXPIRY)

describe('a client with no expiry never expires', () => {
	it('authorizes a registration that predates expiry, at any time at all', () => {
		const token = fresh()
		storeContaining({ clients: [client('legacy', token)] })

		expect(authorizeApiToken(bearer(token), 'board-a', 'read', expiryMs)).toBe('legacy')
		expect(authorizeApiToken(bearer(token), 'board-a', 'read', Date.UTC(2200, 0, 1))).toBe('legacy')
	})

	it('uses the real clock when none is supplied', () => {
		const token = fresh()
		storeContaining({ clients: [client('legacy', token)] })

		expect(authorizeApiToken(bearer(token), 'board-a', 'read')).toBe('legacy')
	})
})

describe('a client with an expiry stops authenticating at that instant', () => {
	it('authorizes before the expiry', () => {
		const token = fresh()
		storeContaining({ clients: [client('limited', token, { expiresAt: EXPIRY })] })

		expect(authorizeApiToken(bearer(token), 'board-a', 'read', expiryMs - 1)).toBe('limited')
		expect(authorizeApiToken(bearer(token), 'board-a', 'read', expiryMs - 86_400_000)).toBe('limited')
	})

	it('refuses at the exact instant of expiry, and from then on', () => {
		const token = fresh()
		storeContaining({ clients: [client('limited', token, { expiresAt: EXPIRY })] })

		expect(authorizeApiToken(bearer(token), 'board-a', 'read', expiryMs)).toBeNull()
		expect(authorizeApiToken(bearer(token), 'board-a', 'read', expiryMs + 1)).toBeNull()
		expect(authorizeApiToken(bearer(token), 'board-a', 'read', expiryMs + 365 * 86_400_000)).toBeNull()
	})

	it('refuses an expired client for every permission and every room it held', () => {
		const token = fresh()
		storeContaining({
			clients: [{
				name: 'wide',
				tokenHash: digest(token),
				rooms: ['board-a', 'board-b'],
				permissions: ['read', 'write', 'history', 'restore'],
				expiresAt: EXPIRY,
			}],
		})
		const permissions: ApiPermission[] = ['read', 'write', 'history', 'restore']

		for (const room of ['board-a', 'board-b']) {
			for (const permission of permissions) {
				expect(authorizeApiToken(bearer(token), room, permission, expiryMs - 1), `${room} ${permission} before`).toBe('wide')
				expect(authorizeApiToken(bearer(token), room, permission, expiryMs), `${room} ${permission} at`).toBeNull()
			}
		}
	})

	it('still applies the board and scope checks before expiry', () => {
		const token = fresh()
		storeContaining({ clients: [client('limited', token, { expiresAt: EXPIRY })] })

		expect(authorizeApiToken(bearer(token), 'board-b', 'read', expiryMs - 1)).toBeNull()
		expect(authorizeApiToken(bearer(token), 'board-a', 'restore', expiryMs - 1)).toBeNull()
	})

	it('uses the real clock when none is supplied', () => {
		const expired = fresh()
		const live = fresh()
		storeContaining({
			clients: [
				client('long-gone', expired, { expiresAt: '2000-01-01T00:00:00.000Z' }),
				client('far-future', live, { expiresAt: '2099-01-01T00:00:00.000Z' }),
			],
		})

		expect(authorizeApiToken(bearer(expired), 'board-a', 'read')).toBeNull()
		expect(authorizeApiToken(bearer(live), 'board-a', 'read')).toBe('far-future')
	})
})

describe('an unreadable expiry fails closed, for that client only', () => {
	const unreadable: Array<[string, unknown]> = [
		['a number', 1893456000000],
		['null', null],
		['an empty string', ''],
		['prose', 'soon'],
		['a bare year', '2099'],
		['a date with no time', '2099-01-01'],
		['a timestamp with no zone', '2099-01-01T00:00:00'],
		['a timestamp with an offset', '2099-01-01T00:00:00+00:00'],
		['a calendar-invalid date a lenient parser would roll over', '2099-02-31T00:00:00Z'],
		['an object', { at: '2099-01-01T00:00:00Z' }],
		['a boolean', false],
	]

	for (const [label, value] of unreadable) {
		it(`refuses a client whose expiresAt is ${label}`, () => {
			const token = fresh()
			storeContaining({ clients: [client('broken', token, { expiresAt: value })] })

			expect(authorizeApiToken(bearer(token), 'board-a', 'read', expiryMs)).toBeNull()
		})
	}

	it('does not let one broken or expired client lock out the others', () => {
		const good = fresh()
		const broken = fresh()
		const expired = fresh()
		const forever = fresh()
		storeContaining({
			clients: [
				client('broken', broken, { expiresAt: 'garbage' }),
				client('expired', expired, { expiresAt: '2000-01-01T00:00:00.000Z' }),
				client('good', good, { expiresAt: '2099-01-01T00:00:00.000Z' }),
				client('forever', forever),
			],
		})

		expect(authorizeApiToken(bearer(broken), 'board-a', 'read', expiryMs)).toBeNull()
		expect(authorizeApiToken(bearer(expired), 'board-a', 'read', expiryMs)).toBeNull()
		expect(authorizeApiToken(bearer(good), 'board-a', 'read', expiryMs)).toBe('good')
		expect(authorizeApiToken(bearer(forever), 'board-a', 'read', expiryMs)).toBe('forever')
	})
})

describe('expiry composes with the writer', () => {
	it('honours an expiry written by createClient, before and after it passes', async () => {
		const file = storeContaining({ clients: [] })
		const now = new Date('2026-10-08T12:00:00.000Z')
		const { token } = await createClient({ file, name: 'agent', rooms: ['board-a'], access: 'read-write', expiresAt: '2026-10-08T13:00:00Z', now })
		const at = (minutes: number) => now.getTime() + minutes * 60_000

		expect(authorizeApiToken(bearer(token), 'board-a', 'write', at(0))).toBe('agent')
		expect(authorizeApiToken(bearer(token), 'board-a', 'write', at(59))).toBe('agent')
		expect(authorizeApiToken(bearer(token), 'board-a', 'write', at(60))).toBeNull()
		expect(authorizeApiToken(bearer(token), 'board-a', 'write', at(120))).toBeNull()
	})

	it('keeps a client created with no expiry alive indefinitely', async () => {
		const file = storeContaining({ clients: [] })
		const { token } = await createClient({ file, name: 'agent', rooms: ['board-a'], access: 'read' })

		expect(authorizeApiToken(bearer(token), 'board-a', 'read', Date.UTC(2300, 0, 1))).toBe('agent')
	})
})

describe('over HTTP an expired token looks exactly like an unknown one', () => {
	it('answers the same status and body, so expiry does not confirm that a token once existed', async () => {
		const expired = fresh()
		const unknown = fresh()
		storeContaining({ clients: [client('long-gone', expired, { expiresAt: '2000-01-01T00:00:00.000Z' })] })
		const app = await buildApp({ dataDirectory: directory(), clientDirectory: directory(), logger: false })
		try {
			const ask = (token: string) => app.inject({ method: 'GET', url: '/api/rooms/board-a/semantic-context', headers: { authorization: bearer(token) } })

			const withExpired = await ask(expired)
			const withUnknown = await ask(unknown)

			expect(withExpired.statusCode).toBe(withUnknown.statusCode)
			expect(withExpired.statusCode).toBe(401)
			expect(withExpired.body).toBe(withUnknown.body)
		} finally {
			await app.close()
		}
	})
})
