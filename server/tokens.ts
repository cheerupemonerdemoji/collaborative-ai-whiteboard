import { createHash, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { BOARD_CREATE_PERMISSION, CAD_UPLOAD_MAX_LIFETIME_MS, MAX_CLIENTS, clientFingerprint, evaluateExpiry } from './token-store.mjs'

/**
 * The reader is deliberately forward-compatible.
 *
 * These schemas used to be `.strict()`, which rejects unknown keys. That made
 * the store a one-way door: the moment a newer server wrote a client carrying
 * metadata an older server did not know about, the older server's parse threw,
 * the `catch` below swallowed it, and *every* machine token stopped
 * authenticating - with no error anywhere, just blanket 401s. A rollback would
 * have been indistinguishable from an outage.
 *
 * `.passthrough()` removes that whole class of failure: an older server ignores
 * fields it does not understand instead of locking every agent out. It also
 * keeps unknown keys on the parsed object, so a read-modify-write cycle
 * preserves metadata rather than silently deleting it - forward compatibility
 * on read is worthless if the write path strips what it just tolerated.
 *
 * Tolerance is not laxity. Every field this file actually relies on is still
 * validated exactly as before: an unparseable hash, an out-of-range permission
 * or a malformed room id is still refused.
 */
const clientSchema = z.object({
	name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
	tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
	rooms: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,80}$/)).min(1).max(50),
	permissions: z.array(z.enum(['read', 'write', 'history', 'restore'])).min(1).max(4),
	// Per-client capabilities beside `permissions`. Plain strings on purpose: an enum here would make a newer capability reject the whole file on an older reader.
	// `.catch` as well: a malformed value (a typo, a different shape from a future version) disables this client's capabilities
	// and nothing else, instead of failing the whole parse and locking every agent out.
	capabilities: z.array(z.string().max(40)).max(8).optional().catch(undefined),
}).passthrough()
const tokenFileSchema = z.object({ clients: z.array(clientSchema).max(MAX_CLIENTS) }).passthrough()

/**
 * Board-creating credentials live in the separate top-level `accountClients` collection, because they begin with no
 * boards and a `clients` record with no rooms would make the whole file unreadable (see token-store.mjs). Each
 * record is validated on its own: a malformed creator disables only that credential, and can never take ordinary
 * clients down with it. A build that predates this collection never looks at it, so creators simply do not
 * authenticate there (fail closed) while ordinary clients carry on.
 */
const accountClientSchema = z.object({
	name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
	tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
	ownerUserId: z.string().regex(/^[A-Za-z0-9:_.-]{1,128}$/),
	accountPermissions: z.array(z.string()),
	permissions: z.array(z.enum(['read', 'write', 'history', 'restore'])).min(1).max(4),
	rooms: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,80}$/)).max(50),
}).passthrough()

type StoredClient = z.infer<typeof clientSchema>
type StoredAccountClient = z.infer<typeof accountClientSchema>

/** Both collections, or null when the token file is unusable (missing, unparseable, or `clients` invalid). */
function loadStore(): { clients: StoredClient[]; accountClients: StoredAccountClient[] } | null {
	const file = process.env.CANVAS_API_TOKENS_FILE
	if (!file) return null
	let raw: unknown
	let clients: StoredClient[]
	try {
		raw = JSON.parse(readFileSync(file, 'utf8'))
		clients = tokenFileSchema.parse(raw).clients
	} catch {
		return null
	}
	const accountClients: StoredAccountClient[] = []
	const listed = (raw as { accountClients?: unknown }).accountClients
	if (Array.isArray(listed)) {
		for (const entry of listed) {
			const parsed = accountClientSchema.safeParse(entry)
			if (parsed.success) accountClients.push(parsed.data)
		}
	}
	return { clients, accountClients }
}

export type ApiPermission = 'read' | 'write' | 'history' | 'restore'

/**
 * Returns the client name when `header` is a valid bearer for `roomId` with `permission`, otherwise null.
 *
 * A client whose `expiresAt` has passed is refused exactly like an unknown token (null, so the route answers
 * as it would for any bad credential and does not reveal that the token once existed). A client with no
 * `expiresAt` never expires, which is every registration made before expiry existed. A client whose
 * `expiresAt` is present but unreadable is refused too: an unparseable cut-off must fail closed. Only that
 * client is affected; the others in the same file are unaffected. `now` is injectable for tests.
 *
 * Rollback warning: this enforcement lives in this function. A server older than the commit that added it
 * ignores `expiresAt` entirely (see docs/operations/token-store-rollback-floor.md).
 */
export function authorizeApiToken(header: string | undefined, roomId: string, permission: ApiPermission, now: number = Date.now()): string | null {
	const match = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(header ?? '')
	if (!match) return null
	const store = loadStore()
	if (!store) return null
	const digest = createHash('sha256').update(match[1]).digest()
	// A board-creating credential authenticates here exactly like any other client once it holds the board.
	for (const client of [...store.clients, ...store.accountClients]) {
		const stored = Buffer.from(client.tokenHash, 'hex')
		if (!timingSafeEqual(digest, stored) || !client.rooms.includes(roomId) || !client.permissions.includes(permission)) continue
		const expiry = evaluateExpiry(client.expiresAt, now)
		if (expiry === 'expired' || expiry === 'invalid') continue
		return client.name
	}
	return null
}

/**
 * Returns the client name when `header` is a valid, unexpired bearer for exactly `roomId` that holds BOTH the `write`
 * permission and the named capability, otherwise null. A board-creating credential never carries a capability, and a
 * capability without write access is refused here even if one was stored (for example after an access change).
 *
 * A capability credential must also carry a live expiry that is no more than CAD_UPLOAD_MAX_LIFETIME_MS away. One with no
 * expiry, an unreadable one, or one set further out by hand is refused, so the short-life rule holds at the point of use
 * and not only when the credential is minted.
 */
export function authorizeApiCapability(header: string | undefined, roomId: string, capability: string, now: number = Date.now()): string | null {
	const match = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(header ?? '')
	if (!match) return null
	const store = loadStore()
	if (!store) return null
	const digest = createHash('sha256').update(match[1]).digest()
	for (const client of store.clients) {
		const stored = Buffer.from(client.tokenHash, 'hex')
		if (!timingSafeEqual(digest, stored)) continue
		if (client.rooms.length !== 1 || client.rooms[0] !== roomId) continue
		if (!client.permissions.includes('write') || !client.capabilities?.includes(capability)) continue
		if (evaluateExpiry(client.expiresAt, now) !== 'active') continue
		if (Date.parse(String(client.expiresAt)) - now > CAD_UPLOAD_MAX_LIFETIME_MS) continue
		return client.name
	}
	return null
}

export interface ApiTokenDescription {
	name: string
	kind: 'board' | 'board-creator'
	/** The permissions this credential holds on every board it reaches. */
	permissions: ApiPermission[]
	rooms: string[]
	expiresAt?: string
	accountPermissions: string[]
}

/**
 * Describes a valid, unexpired bearer for the diagnostics route: its name, what it may do, which boards it reaches and when it expires.
 * Never the hash, the fingerprint or anything that would help forge, rotate or identify the secret. Null for anything that would not authenticate.
 */
export function describeApiToken(header: string | undefined, now: number = Date.now()): ApiTokenDescription | null {
	const match = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(header ?? '')
	if (!match) return null
	const store = loadStore()
	if (!store) return null
	const digest = createHash('sha256').update(match[1]).digest()
	const candidates: Array<{ client: StoredClient | StoredAccountClient; kind: 'board' | 'board-creator' }> = [
		...store.clients.map((client) => ({ client, kind: 'board' as const })),
		...store.accountClients.map((client) => ({ client, kind: 'board-creator' as const })),
	]
	for (const { client, kind } of candidates) {
		if (!timingSafeEqual(digest, Buffer.from(client.tokenHash, 'hex'))) continue
		const expiry = evaluateExpiry(client.expiresAt, now)
		if (expiry === 'expired' || expiry === 'invalid') return null
		return {
			name: client.name, kind, permissions: [...client.permissions], rooms: [...client.rooms],
			...(typeof client.expiresAt === 'string' ? { expiresAt: client.expiresAt } : {}),
			accountPermissions: 'accountPermissions' in client && Array.isArray(client.accountPermissions) ? client.accountPermissions.filter((p): p is string => typeof p === 'string') : [],
		}
	}
	return null
}

export type BoardCreatorAuth =
	| { kind: 'ok'; name: string; ownerUserId: string; permissions: ApiPermission[]; fingerprint: string; roomCount: number }
	/** A valid, unexpired bearer that does not carry the `board:create` capability. */
	| { kind: 'forbidden' }
	/** No bearer, an unknown or expired one, or no usable token file. */
	| { kind: 'unauthenticated' }

/**
 * Authenticate a bearer for POST /api/agent-boards. Not tied to any board. Returns `ok` only for a credential in
 * `accountClients` that carries `board:create`, is unexpired, and names an owner. An ordinary board-scoped client
 * is `forbidden` (the bearer is genuine but cannot do this), while an unknown or expired token is
 * `unauthenticated`, exactly as for every other machine route.
 */
export function authenticateBoardCreator(header: string | undefined, now: number = Date.now()): BoardCreatorAuth {
	const match = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(header ?? '')
	if (!match) return { kind: 'unauthenticated' }
	const store = loadStore()
	if (!store) return { kind: 'unauthenticated' }
	const digest = createHash('sha256').update(match[1]).digest()
	for (const client of store.clients) {
		if (!timingSafeEqual(digest, Buffer.from(client.tokenHash, 'hex'))) continue
		const expiry = evaluateExpiry(client.expiresAt, now)
		return expiry === 'expired' || expiry === 'invalid' ? { kind: 'unauthenticated' } : { kind: 'forbidden' }
	}
	for (const client of store.accountClients) {
		if (!timingSafeEqual(digest, Buffer.from(client.tokenHash, 'hex'))) continue
		const expiry = evaluateExpiry(client.expiresAt, now)
		if (expiry === 'expired' || expiry === 'invalid') return { kind: 'unauthenticated' }
		if (!client.accountPermissions.includes(BOARD_CREATE_PERMISSION)) return { kind: 'forbidden' }
		return {
			kind: 'ok',
			name: client.name,
			ownerUserId: client.ownerUserId,
			permissions: [...client.permissions],
			fingerprint: clientFingerprint(client.tokenHash),
			roomCount: client.rooms.length,
		}
	}
	return { kind: 'unauthenticated' }
}
