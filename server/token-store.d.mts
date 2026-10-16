// Type declarations for server/token-store.mjs.
//
// The implementation is plain JavaScript so the operator CLI can import it with
// a bare `node` and no TypeScript loader; this file is how the server's
// TypeScript sees it. It must describe exactly the runtime exports of
// token-store.mjs -- tests/token-store.test.ts fails if an export exists in one
// file and not the other.

export type Permission = 'read' | 'write' | 'history' | 'restore'

export type AccessMode = 'read' | 'write' | 'read-write' | 'read-history' | 'read-write-history' | 'full'

/**
 * The most clients one store may hold; `createClient` refuses the one past it
 * with `store-full`. It is the request-time reader's own limit: a store over it
 * fails to parse there, which would lock out every agent.
 */
export const MAX_CLIENTS: number

/** The most boards one credential may hold: the request-time reader's own per-client cap. */
export const MAX_ROOMS_PER_CLIENT: number

/** The most board-creating credentials one store may hold (policy; they live in `accountClients`). */
export const MAX_ACCOUNT_CLIENTS: number

/** The one account-level capability: create new boards owned by the credential's `ownerUserId`. */
export const BOARD_CREATE_PERMISSION: 'board:create'

/** Access-mode shorthands shared by the CLI and the HTTP routes. */
export const ACCESS_MODES: Readonly<Record<AccessMode, readonly Permission[]>>

/**
 * A stored client. The index signature is load-bearing: metadata written by a
 * newer version (createdAt, expiresAt, displayName, ...) must survive a
 * read-modify-write performed by this version.
 */
export interface StoredClient {
	name: string
	tokenHash: string
	rooms: string[]
	permissions: Permission[]
	[key: string]: unknown
}

/** The store as it exists on disk. Unknown top-level keys are preserved. */
export interface TokenStoreData {
	clients: StoredClient[]
	/**
	 * Board-creating credentials. Separate from `clients` because they start with no boards, and a `clients`
	 * record with no rooms would make every reader reject the whole file. Older builds ignore this key.
	 */
	accountClients?: StoredClient[]
	[key: string]: unknown
}

/** A client as it is safe to show a caller: no hash, no plaintext. */
export interface ClientSummary {
	name: string
	rooms: string[]
	permissions: Permission[]
}

export type TokenStoreErrorCode =
	| 'locked'
	| 'invalid-store'
	| 'invalid-name'
	| 'invalid-rooms'
	| 'invalid-access'
	| 'invalid-expiry'
	| 'invalid-display-name'
	| 'invalid-creator'
	| 'store-full'
	| 'stale-reference'
	| 'duplicate-name'
	| 'not-found'
	| 'no-capability'
	| 'expired'
	| 'room-limit'
	| 'rollback-failed'

/**
 * Carries a stable machine-readable `code` so HTTP routes can map failures to
 * status codes without matching on message text. Messages are built only from
 * already-validated names and from paths; never from token material.
 */
export class TokenStoreError extends Error {
	readonly code: TokenStoreErrorCode
	/** Set on `rollback-failed`: the id of the board that could not be removed. */
	boardId?: string
	constructor(code: TokenStoreErrorCode, message: string)
}

export function isValidClientName(value: unknown): value is string
export function isValidRoomId(value: unknown): value is string
export function isAccessMode(value: unknown): value is AccessMode

/**
 * Whether a stored client's `expiresAt` has passed. The one definition shared
 * by the request-time reader, the HTTP routes and the CLI:
 *
 * - `'none'`: no `expiresAt` key (`undefined`); the client never expires.
 * - `'active'`: strictly in the future.
 * - `'expired'`: now or earlier. The instant of expiry is already expired.
 * - `'invalid'`: present but not a well-formed UTC timestamp. Callers must treat
 *   this as expired (fail closed).
 *
 * The argument is `unknown` on purpose: it comes straight from raw JSON.
 */
export type ExpiryStatus = 'none' | 'active' | 'expired' | 'invalid'
export function evaluateExpiry(expiresAt: unknown, now?: number): ExpiryStatus

/**
 * A short, stable fingerprint of one specific credential (16 hex characters),
 * derived from its stored hash without disclosing any of it. A client name is
 * reusable; name plus fingerprint pins the exact credential that was read.
 * Rotating a client changes its fingerprint.
 */
export function clientFingerprint(tokenHash: string): string

/** Default store location, overridable with CANVAS_API_TOKENS_FILE. */
export function resolveStorePath(env?: NodeJS.ProcessEnv): string

/**
 * Read the store as raw parsed JSON plus the exact bytes that produced it. A
 * missing file yields an empty store; anything that is not an object with an
 * array `clients` is rejected as `invalid-store`.
 */
export function readStore(file: string): Promise<{ data: TokenStoreData; source: string }>

/** The `accountClients` collection, or an empty array when the store has none. */
export function accountClientsOf(data: TokenStoreData): StoredClient[]

/** Clients as they are safe to return to a caller: never the stored hash. */
export function summariseClients(data: TokenStoreData): ClientSummary[]

/** Take the exclusive mutation lock, returning an idempotent release. */
export function acquireMutationLock(file: string): Promise<() => Promise<void>>

/** Copy the pre-mutation bytes to a unique, timestamped 0600 backup. */
export function backUpStore(file: string, source: string): Promise<string>

/** Write the store through a temp file and an atomic rename. */
export function writeStoreAtomically(file: string, data: TokenStoreData): Promise<void>

/**
 * Run `mutate` against the store under the exclusive lock, then persist it.
 * `mutate` receives the raw parsed store and edits it in place.
 */
export function mutateStore<T>(file: string, mutate: (data: TokenStoreData) => T): Promise<T>

export interface CreateClientRequest {
	file: string
	name: string
	rooms: readonly string[]
	access: string
	/**
	 * Optional expiry: a UTC ISO 8601 timestamp (`2027-01-31T00:00:00Z`) or a
	 * `Date`, strictly in the future. Omit (leave `undefined`) for a client that
	 * never expires. `null`, `''` and malformed values are rejected with
	 * `invalid-expiry` rather than treated as "never".
	 */
	expiresAt?: string | Date
	/** Optional human label, 1-80 printable characters (stored trimmed). */
	displayName?: string
	/** Optional id of the person who created the client, `[A-Za-z0-9:_.-]{1,128}`. */
	createdByUserId?: string
	/** The clock, for tests. Defaults to the current time. */
	now?: Date
}

export interface CreateClientResult {
	/** Plaintext bearer. Returned exactly once; never persisted or logged. */
	token: string
	name: string
	rooms: string[]
	permissions: Permission[]
	/** Fingerprint of the new credential (see `clientFingerprint`). */
	fingerprint: string
	/** When the client was created (ISO 8601, UTC). Stamped on every new client. */
	createdAt: string
	/** Canonical form of the expiry, present only when one was set. */
	expiresAt?: string
}

/** Register a new client and return its one-time bearer token. */
export function createClient(request: CreateClientRequest): Promise<CreateClientResult>

export interface CreateAccountClientRequest {
	file: string
	name: string
	/** The account that will own every board this credential creates. Recorded once; never changes. */
	ownerUserId: string
	/** Permissions the credential holds on every board it creates. */
	access: string
	expiresAt?: string | Date
	displayName?: string
	createdByUserId?: string
	now?: Date
}

export interface CreateAccountClientResult {
	/** Plaintext bearer. Returned exactly once; never persisted or logged. */
	token: string
	name: string
	ownerUserId: string
	permissions: Permission[]
	fingerprint: string
	createdAt: string
	expiresAt?: string
}

/**
 * Register a board-creating credential in `accountClients`. It starts with no boards and grants no access to any
 * board that already exists; names are unique across `clients` and `accountClients`.
 */
export function createAccountClient(request: CreateAccountClientRequest): Promise<CreateAccountClientResult>

export interface GrantNewBoardRequest {
	file: string
	name: string
	/** Pins the exact credential that authenticated the request; a rotated or replaced one is `stale-reference`. */
	fingerprint: string
	/**
	 * Creates the board. Synchronous; runs inside the mutation lock after the capability, expiry and room-cap
	 * checks, and receives the freshly read credential record. Returns the new board's id.
	 */
	prepare: (client: StoredClient) => string
	/** Removes the board `prepare` created if the grant could not be persisted. Synchronous. */
	rollback: (boardId: string) => void
	now?: Date
}

/**
 * Create a board for a board-creating credential and add it to the credential's rooms under one lock: board
 * first, then grant, with `rollback` as compensation. See the implementation for the failure analysis.
 */
export function grantNewBoard(request: GrantNewBoardRequest): Promise<{ boardId: string; rooms: string[] }>

/**
 * Pins a name-addressed action to one exact record and lets the caller veto it
 * from inside the mutation lock.
 */
export interface ClientTarget {
	/**
	 * Only a record with this name AND this credential matches. A record that has
	 * since been replaced under the same name fails with `stale-reference`.
	 */
	fingerprint?: string
	/**
	 * The caller's permission check, run INSIDE the lock against the freshly read
	 * record, so the decision and the change are made on the same record.
	 * Synchronous; signal refusal by throwing. Returning anything (an async
	 * function returns a promise) is rejected, because that refusal would be lost.
	 */
	authorise?: (client: StoredClient) => void
}

/**
 * Remove a client. Refuses an unknown name rather than writing a no-op. Without
 * a fingerprint, every record carrying the name is removed.
 */
export function revokeClient(file: string, name: string, options?: ClientTarget): Promise<void>

export interface RotateClientRequest extends ClientTarget {
	file: string
	name: string
	/** Replaces the client's expiry. Required when the current one has passed or is unreadable. */
	expiresAt?: string | Date
	/** The clock, for tests. Defaults to the current time. */
	now?: Date
}

export interface RotateClientResult {
	/** The new plaintext bearer. Returned exactly once; never persisted or logged. */
	token: string
	name: string
	rooms: string[]
	permissions: Permission[]
	/** Fingerprint of the new credential. */
	fingerprint: string
	createdAt?: string
	rotatedAt: string
	expiresAt?: string
}

/**
 * Replace a client's bearer token, keeping name, boards, permissions, label,
 * creator, creation time, expiry and unknown metadata. The old token stops
 * working immediately. Stamped with `rotatedAt`.
 */
export function rotateClient(request: RotateClientRequest): Promise<RotateClientResult>

/** Read-only listing. Takes no lock and never returns hashes. */
export function listClients(file: string): Promise<ClientSummary[]>

/** A client with its metadata and live expiry status. Never carries the hash. */
export interface ClientDetail extends ClientSummary {
	createdAt?: string
	expiresAt?: string
	displayName?: string
	createdByUserId?: string
	rotatedAt?: string
	/** Present only on board-creating credentials. */
	accountPermissions?: string[]
	ownerUserId?: string
	/** `clientFingerprint` of the stored credential, for addressing this exact record. */
	fingerprint: string
	status: ExpiryStatus
}

/**
 * Read-only listing with metadata and expiry status. Fields that are absent or
 * of the wrong type are omitted. Takes no lock and never returns hashes.
 */
export function describeClients(file: string, now?: number): Promise<ClientDetail[]>
