import { createHash, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { MAX_CLIENTS, evaluateExpiry } from './token-store.mjs'

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
}).passthrough()
const tokenFileSchema = z.object({ clients: z.array(clientSchema).max(MAX_CLIENTS) }).passthrough()

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
	const file = process.env.CANVAS_API_TOKENS_FILE
	if (!file) return null
	let clients: z.infer<typeof clientSchema>[]
	try { clients = tokenFileSchema.parse(JSON.parse(readFileSync(file, 'utf8'))).clients }
	catch { return null }
	const digest = createHash('sha256').update(match[1]).digest()
	for (const client of clients) {
		const stored = Buffer.from(client.tokenHash, 'hex')
		if (!timingSafeEqual(digest, stored) || !client.rooms.includes(roomId) || !client.permissions.includes(permission)) continue
		const expiry = evaluateExpiry(client.expiresAt, now)
		if (expiry === 'expired' || expiry === 'invalid') continue
		return client.name
	}
	return null
}
