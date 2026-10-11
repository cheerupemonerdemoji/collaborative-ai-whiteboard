// Shared, hardened mutation path for the machine-token store.
//
// This module is the ONE implementation of every destructive operation on the
// machine-token file. `scripts/manage-api-tokens.mjs` and the owner-only
// agent-access HTTP routes both call it, so a hardening fix lands in both at
// once. A production registration was once destroyed by a second, divergent
// writer; that is the failure this module exists to make structurally
// impossible.
//
// It is plain ES-module JavaScript (`.mjs`) with a hand-written declaration
// file (`token-store.d.mts`) on purpose. The operator CLI is run with a bare
// `node scripts/manage-api-tokens.mjs ...` on a Node build that cannot load
// TypeScript, so the CLI must be able to import this file directly, with no
// loader, no transpiler and no dependency that is not in Node itself. The
// server's TypeScript still gets full types from the declaration file, and
// `tests/token-store.test.ts` fails if the two files ever drift apart.
// Because of that constraint this file may import only `node:` built-ins.
//
// Four invariants hold for every mutation, in this order:
//
//   1. Exclusive lock. `open(lock, 'wx')` is the only gate. If the lock exists
//      we refuse and we do NOT remove it -- a lock we did not create is never
//      ours to clear. A lock we created but failed to initialise is cleaned up.
//   2. Validate before writing anything. The mutator runs against the parsed
//      store and may throw; nothing has been written at that point, so a
//      rejected mutation cannot leave a backup, a temp file or a damaged store.
//   3. Pre-mutation backup. The exact bytes read from disk are copied to a
//      timestamped 0600 `.bak` BEFORE the new store is put in place.
//   4. Temp file + atomic rename, 0600 throughout. A crash or an injected
//      failure before the rename leaves the previous store byte-identical.
//
// Deliberately NOT used here: zod. `server/tokens.ts` validates on the read
// path, where rejecting a malformed client is the safe action. On the mutation
// path the safe action is the opposite -- preserve every byte we do not
// understand. A schema that strips unknown keys would silently delete metadata
// written by a newer version of this application during an ordinary
// read-modify-write. So mutations work on the raw parsed JSON and only assert
// the single structural fact they depend on: `clients` is an array.
//
// Token plaintext never enters a log line, an error message, a backup or the
// store. Only the SHA-256 hash is persisted, and the plaintext is returned to
// the caller exactly once.

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { chmod, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Access-mode shorthands shared by the CLI and the HTTP routes. */
export const ACCESS_MODES = {
	read: ['read'],
	write: ['write'],
	'read-write': ['read', 'write'],
	'read-history': ['read', 'history'],
	full: ['read', 'write', 'history', 'restore'],
}

/**
 * Carries a stable machine-readable `code` so HTTP routes can map failures to
 * status codes without matching on message text. Messages are built only from
 * already-validated names and from paths; never from token material.
 */
export class TokenStoreError extends Error {
	constructor(code, message) {
		super(message)
		this.name = 'TokenStoreError'
		this.code = code
	}
}

const CLIENT_NAME = /^[A-Za-z0-9_-]{1,64}$/
const ROOM_ID = /^[A-Za-z0-9_-]{1,80}$/
const MAX_ROOMS = 50

/**
 * The most clients one store may hold. This is the reader's limit, not a policy choice: server/tokens.ts parses
 * the whole file with a schema capped at this many clients, and a file over the cap fails that parse as a
 * whole, so EVERY agent would be locked out at once, silently. The writer therefore refuses the client that
 * would cross the line, for the CLI and the HTTP routes alike.
 */
export const MAX_CLIENTS = 100

export function isValidClientName(value) {
	return typeof value === 'string' && CLIENT_NAME.test(value)
}

export function isValidRoomId(value) {
	return typeof value === 'string' && ROOM_ID.test(value)
}

export function isAccessMode(value) {
	return typeof value === 'string' && Object.hasOwn(ACCESS_MODES, value)
}

// Stored timestamps are always `Date#toISOString()` output. The reader accepts
// exactly that shape and nothing looser: Date.parse alone would happily read
// "2027" or "1" as a date, and a security cut-off must not depend on a parser's
// leniency.
const TIMESTAMP_FORMAT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/
const CREATOR_ID = /^[A-Za-z0-9:_.-]{1,128}$/
const DISPLAY_NAME_MAX = 80

/**
 * Parse a stored timestamp strictly. Returns epoch milliseconds, or null for
 * anything that is not a well-formed, calendar-valid UTC timestamp (so
 * "2027-02-31T00:00:00Z", which a lenient parser rolls into March, is rejected).
 */
function parseTimestamp(value) {
	if (typeof value !== 'string' || !TIMESTAMP_FORMAT.test(value)) return null
	const at = Date.parse(value)
	if (Number.isNaN(at)) return null
	if (new Date(at).toISOString().slice(0, 19) !== value.slice(0, 19)) return null
	return at
}

/**
 * The single definition of whether a stored client's expiry has passed. The
 * writer (describeClients), the HTTP routes and the request-time reader in
 * server/tokens.ts all call this, so they cannot disagree.
 *
 *   'none'     no expiresAt key at all: the client never expires. Every
 *              registration made before expiry existed is in this state.
 *   'active'   expiresAt is strictly in the future.
 *   'expired'  expiresAt is now or earlier. The instant of expiry is already
 *              expired, so there is no moment at which a token is both.
 *   'invalid'  expiresAt is present but is not a well-formed timestamp. The
 *              caller must treat this as expired: an unreadable cut-off has to
 *              fail closed, never open.
 */
export function evaluateExpiry(expiresAt, now = Date.now()) {
	if (expiresAt === undefined) return 'none'
	const at = parseTimestamp(expiresAt)
	if (at === null) return 'invalid'
	return at > now ? 'active' : 'expired'
}

/**
 * A short, stable fingerprint of one specific credential, derived from its stored hash (not a prefix of it, so it
 * discloses no bits of the hash itself). A client's NAME is reusable: revoke it and an administrator can register a
 * different client under the same name. The name together with the fingerprint pins the exact credential that was
 * read, so an action meant for one record can never land on a successor that merely shares its name. Rotating a
 * client replaces its hash, so its fingerprint changes.
 */
export function clientFingerprint(tokenHash) {
	return createHash('sha256').update(`agent-ref:${tokenHash}`).digest('hex').slice(0, 16)
}

/** Default store location, overridable with CANVAS_API_TOKENS_FILE. */
export function resolveStorePath(env = process.env) {
	return env.CANVAS_API_TOKENS_FILE ?? join(homedir(), '.config', 'collaborative-ai-canvas', 'api-tokens.json')
}

function serialise(data) {
	return `${JSON.stringify(data, null, 2)}\n`
}

function emptyStore() {
	return { clients: [] }
}

function errnoCode(error) {
	return error?.code
}

/**
 * Read the store as raw parsed JSON plus the exact bytes that produced it.
 *
 * `source` is what the pre-mutation backup copies, so the backup is a faithful
 * byte copy rather than a re-serialisation. A missing file is not an error: it
 * yields an empty store, which is how the first client is ever created.
 *
 * Anything that is not an object with an array `clients` is rejected as
 * `invalid-store`. Rejecting here -- before the lock has produced any write --
 * is what guarantees a malformed store is left exactly as it was found.
 */
export async function readStore(file) {
	let source
	try {
		source = await readFile(file, 'utf8')
	} catch (error) {
		if (errnoCode(error) === 'ENOENT') {
			const data = emptyStore()
			return { data, source: serialise(data) }
		}
		throw error
	}
	let parsed
	try {
		parsed = JSON.parse(source)
	} catch {
		throw new TokenStoreError('invalid-store', 'Invalid token file')
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		throw new TokenStoreError('invalid-store', 'Invalid token file')
	}
	if (!Array.isArray(parsed.clients)) {
		throw new TokenStoreError('invalid-store', 'Invalid token file')
	}
	return { data: parsed, source }
}

/** Clients as they are safe to return to a caller: never the stored hash. */
export function summariseClients(data) {
	return data.clients.map((client) => ({
		name: client.name,
		rooms: client.rooms,
		permissions: client.permissions,
	}))
}

/**
 * Take the exclusive mutation lock, returning an idempotent release.
 *
 * Fail-safe in both directions: an existing lock is refused and left alone, and
 * a lock this process created but could not initialise is removed. A lock that
 * belongs to another operation is never cleared here -- recovering from a stale
 * lock is a deliberate human act, not something a concurrent writer guesses at.
 */
export async function acquireMutationLock(file) {
	await mkdir(dirname(file), { recursive: true, mode: 0o700 })
	const lockFile = `${file}.lock`
	let handle
	try {
		handle = await open(lockFile, 'wx', 0o600)
	} catch (error) {
		if (errnoCode(error) === 'EEXIST') {
			throw new TokenStoreError('locked', `Token store is locked by another management operation: ${lockFile}`)
		}
		// The lock was not created by us, so it is not ours to remove.
		throw error
	}
	try {
		await handle.writeFile(`${process.pid}\n`, 'utf8')
		await handle.close()
	} catch (error) {
		await handle.close().catch(() => {})
		await rm(lockFile, { force: true }).catch(() => {})
		throw error
	}
	let released = false
	return async () => {
		if (released) return
		released = true
		await rm(lockFile, { force: true })
	}
}

/** Copy the pre-mutation bytes to a unique, timestamped 0600 backup. */
export async function backUpStore(file, source) {
	const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
	const backup = `${file}.${timestamp}.${randomUUID()}.bak`
	await writeFile(backup, source, { mode: 0o600, flag: 'wx' })
	await chmod(backup, 0o600)
	return backup
}

/**
 * Write the store through a temp file and an atomic rename.
 *
 * Every failure path removes the temp file and rethrows without touching the
 * live store, so the previous registration set stays usable. The explicit
 * chmod calls exist because the mode argument to writeFile is masked by umask.
 */
export async function writeStoreAtomically(file, data) {
	const temporary = `${file}.${randomUUID()}.tmp`
	try {
		await writeFile(temporary, serialise(data), { mode: 0o600, flag: 'wx' })
		await chmod(temporary, 0o600)
		if (process.env.CANVAS_API_TOKENS_TEST_FAILPOINT === 'before-rename') {
			// Test-only hook. It proves the pre-rename crash path really does
			// leave the previous store intact; nothing in production sets it.
			throw new Error('Injected failure before token-store rename')
		}
		await rename(temporary, file)
		await chmod(file, 0o600)
	} catch (error) {
		await rm(temporary, { force: true }).catch(() => {})
		throw error
	}
}

/**
 * Run `mutate` against the store under the exclusive lock, then persist it.
 *
 * The ordering is the whole point: lock, read, mutate (may throw), back up,
 * atomically replace, release. A mutator that rejects the request throws before
 * step 4, so a refused mutation produces no backup, no temp file and no change.
 *
 * `mutate` receives the raw parsed store and edits it in place, which is how
 * unknown top-level and per-client metadata survives untouched.
 */
export async function mutateStore(file, mutate) {
	const release = await acquireMutationLock(file)
	try {
		const { data, source } = await readStore(file)
		const result = mutate(data)
		await backUpStore(file, source)
		await writeStoreAtomically(file, data)
		return result
	} finally {
		await release()
	}
}

/**
 * Validate a requested expiry and return it in canonical form (always
 * `toISOString()` output, so it round-trips through the strict reader).
 *
 * Only `undefined` means "no expiry". `null`, an empty string or a malformed
 * value is an error rather than a silent "never expires": the cost of a caller
 * bug here is a credential that lives forever, so it has to fail loudly. An
 * expiry that is not strictly in the future is refused, since a client that is
 * born expired is always a mistake.
 */
function normaliseExpiry(value, now) {
	if (value === undefined) return undefined
	let at
	if (value instanceof Date) {
		at = value.getTime()
		if (Number.isNaN(at)) throw new TokenStoreError('invalid-expiry', 'Expiry is not a valid date')
	} else {
		at = parseTimestamp(value)
		if (at === null) {
			throw new TokenStoreError('invalid-expiry', 'Expiry must be a UTC ISO 8601 timestamp such as 2027-01-31T00:00:00Z')
		}
	}
	if (at <= now.getTime()) {
		throw new TokenStoreError('invalid-expiry', 'Expiry must be in the future')
	}
	return new Date(at).toISOString()
}

function normaliseDisplayName(value) {
	if (value === undefined) return undefined
	const trimmed = typeof value === 'string' ? value.trim() : ''
	if (trimmed.length < 1 || trimmed.length > DISPLAY_NAME_MAX || /[\u0000-\u001f\u007f]/.test(trimmed)) {
		throw new TokenStoreError('invalid-display-name', `Display name must be 1-${DISPLAY_NAME_MAX} printable characters`)
	}
	return trimmed
}

function normaliseCreator(value) {
	if (value === undefined) return undefined
	if (typeof value !== 'string' || !CREATOR_ID.test(value)) {
		throw new TokenStoreError('invalid-creator', 'Creator id must match [A-Za-z0-9:_.-]{1,128}')
	}
	return value
}

/**
 * Register a new client and return its one-time bearer token.
 *
 * Validation runs before the lock is taken, so bad input never blocks a
 * concurrent operation. Rotation is deliberately not a silent overwrite: a
 * duplicate name is refused so a mistyped name can never replace a live
 * registration.
 *
 * Every new client is stamped with `createdAt`. `expiresAt`, `displayName` and
 * `createdByUserId` are optional and are written only when supplied, so a client
 * created without them is byte-for-byte the shape this module has always
 * written (plus createdAt), and omitting an expiry means the client never
 * expires. `now` exists so tests can pin the clock.
 */
export async function createClient(request) {
	const { file, name } = request
	if (!isValidClientName(name)) {
		throw new TokenStoreError('invalid-name', 'Client name must match [A-Za-z0-9_-]{1,64}')
	}
	const rooms = [...request.rooms]
	if (rooms.length < 1 || rooms.length > MAX_ROOMS || !rooms.every(isValidRoomId)) {
		throw new TokenStoreError('invalid-rooms', `Between 1 and ${MAX_ROOMS} room ids matching [A-Za-z0-9_-]{1,80} are required`)
	}
	if (!isAccessMode(request.access)) {
		throw new TokenStoreError('invalid-access', `Access mode must be one of ${Object.keys(ACCESS_MODES).join(', ')}`)
	}
	const now = request.now ?? new Date()
	const createdAt = now.toISOString()
	const expiresAt = normaliseExpiry(request.expiresAt, now)
	const displayName = normaliseDisplayName(request.displayName)
	const createdByUserId = normaliseCreator(request.createdByUserId)
	const permissions = [...ACCESS_MODES[request.access]]
	const token = randomBytes(32).toString('base64url')
	const tokenHash = createHash('sha256').update(token).digest('hex')
	await mutateStore(file, (data) => {
		if (data.clients.some((client) => client.name === name)) {
			throw new TokenStoreError('duplicate-name', `Client ${name} already exists; revoke it first to rotate the token`)
		}
		if (data.clients.length >= MAX_CLIENTS) {
			throw new TokenStoreError('store-full', `The token store already holds the maximum of ${MAX_CLIENTS} clients; revoke one first`)
		}
		data.clients.push({
			name,
			tokenHash,
			rooms,
			permissions,
			createdAt,
			...(expiresAt === undefined ? {} : { expiresAt }),
			...(displayName === undefined ? {} : { displayName }),
			...(createdByUserId === undefined ? {} : { createdByUserId }),
		})
	})
	return { token, name, rooms, permissions, fingerprint: clientFingerprint(tokenHash), createdAt, ...(expiresAt === undefined ? {} : { expiresAt }) }
}

/**
 * Find the record(s) a name-addressed action applies to, INSIDE the mutation lock, and run the caller's
 * authorisation against exactly those records.
 *
 * With a `fingerprint`, only a record with that name AND that credential matches; a record that has since been
 * replaced under the same name is `stale-reference`, never a silent hit. Without one, every record with the name
 * matches, so a hand-edited store holding a duplicate cannot leave a live credential behind after a revoke.
 *
 * `authorise` runs here, in the lock, against the freshly read record, so the decision and the change are made on
 * the same record with nothing able to change it in between. It must be synchronous and signal refusal by
 * throwing; an async function would return a promise nobody awaits and its refusal would be lost, so a callback
 * that returns anything at all is rejected outright.
 */
function locateClients(data, name, options) {
	const named = data.clients.filter((client) => client.name === name)
	if (named.length === 0) throw new TokenStoreError('not-found', `Client ${name} not found`)
	let targets = named
	if (options.fingerprint !== undefined) {
		targets = named.filter((client) => clientFingerprint(client.tokenHash) === options.fingerprint)
		if (targets.length === 0) throw new TokenStoreError('stale-reference', `Client ${name} has changed since it was read`)
	}
	if (options.authorise !== undefined) {
		for (const client of targets) {
			const outcome = options.authorise(client)
			if (outcome !== undefined) throw new TypeError('authorise must be synchronous and return nothing; signal refusal by throwing')
		}
	}
	return targets
}

/**
 * Remove a client. Refuses an unknown name rather than writing a no-op.
 *
 * `options.fingerprint` pins the exact credential (see `clientFingerprint`) and `options.authorise` is the
 * caller's permission check, run inside the lock on the record about to be deleted (see `locateClients`).
 */
export async function revokeClient(file, name, options = {}) {
	if (!isValidClientName(name)) {
		throw new TokenStoreError('invalid-name', 'Client name must match [A-Za-z0-9_-]{1,64}')
	}
	await mutateStore(file, (data) => {
		const targets = locateClients(data, name, options)
		data.clients = data.clients.filter((client) => !targets.includes(client))
	})
}

/**
 * Replace a client's bearer token, keeping everything else about it: name, boards, permissions, label, creator,
 * creation time and any metadata this version does not understand. The old token stops working at once, because
 * the old hash is gone. The record is stamped with `rotatedAt`.
 *
 * Expiry carries over. Rotating a client whose expiry has passed (or is unreadable) without supplying a new
 * `expiresAt` is refused, because it would hand back a token that is already dead. Supplying `expiresAt`
 * replaces the old one. `fingerprint` and `authorise` work exactly as in `revokeClient`, in the same lock. A
 * name that appears more than once is refused (`duplicate-name`) rather than half-rotated.
 */
export async function rotateClient(request) {
	const { file, name } = request
	if (!isValidClientName(name)) {
		throw new TokenStoreError('invalid-name', 'Client name must match [A-Za-z0-9_-]{1,64}')
	}
	const now = request.now ?? new Date()
	const expiresAt = normaliseExpiry(request.expiresAt, now)
	const token = randomBytes(32).toString('base64url')
	const tokenHash = createHash('sha256').update(token).digest('hex')
	let rotated
	await mutateStore(file, (data) => {
		const targets = locateClients(data, name, request)
		if (targets.length !== 1) {
			throw new TokenStoreError('duplicate-name', `Client ${name} appears more than once; revoke the duplicates first`)
		}
		const [client] = targets
		if (expiresAt === undefined) {
			const status = evaluateExpiry(client.expiresAt, now.getTime())
			if (status === 'expired' || status === 'invalid') {
				throw new TokenStoreError('invalid-expiry', 'This client has expired; supply a new expiry to rotate it')
			}
		}
		client.tokenHash = tokenHash
		client.rotatedAt = now.toISOString()
		if (expiresAt !== undefined) client.expiresAt = expiresAt
		rotated = {
			rooms: [...client.rooms],
			permissions: [...client.permissions],
			...(typeof client.createdAt === 'string' ? { createdAt: client.createdAt } : {}),
			...(typeof client.expiresAt === 'string' ? { expiresAt: client.expiresAt } : {}),
		}
	})
	return { token, name, fingerprint: clientFingerprint(tokenHash), rotatedAt: now.toISOString(), ...rotated }
}

/** Read-only listing. Takes no lock and never returns hashes. */
export async function listClients(file) {
	const { data } = await readStore(file)
	return summariseClients(data)
}

/**
 * Read-only listing with the metadata and the live expiry status. `listClients`
 * keeps its original three-field shape because callers depend on it; this is
 * the richer view for the CLI's `list --long` and for the agent-access routes.
 * Fields that are absent, or present with the wrong type, are simply omitted,
 * and the hash is never included.
 */
export async function describeClients(file, now = Date.now()) {
	const { data } = await readStore(file)
	return data.clients.map((client) => ({
		name: client.name,
		rooms: client.rooms,
		permissions: client.permissions,
		...(typeof client.createdAt === 'string' ? { createdAt: client.createdAt } : {}),
		...(typeof client.expiresAt === 'string' ? { expiresAt: client.expiresAt } : {}),
		...(typeof client.displayName === 'string' ? { displayName: client.displayName } : {}),
		...(typeof client.createdByUserId === 'string' ? { createdByUserId: client.createdByUserId } : {}),
		...(typeof client.rotatedAt === 'string' ? { rotatedAt: client.rotatedAt } : {}),
		fingerprint: clientFingerprint(client.tokenHash),
		status: evaluateExpiry(client.expiresAt, now),
	}))
}
