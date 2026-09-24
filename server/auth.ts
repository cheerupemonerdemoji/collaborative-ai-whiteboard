import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto'
import {
	AuthDatabase,
	type AccountEventRecord,
	type BoardMemberRecord,
	type BoardRecord,
	type BoardRole,
	type BoardWithRoleRecord,
	type InvitationRecord,
	type SessionRecord,
	type UserRecord,
} from './auth-db'

const SESSION_TOKEN_BYTES = 32
const INVITATION_TOKEN_BYTES = 32
const MIN_PASSWORD_LENGTH = 10
const MAX_PASSWORD_LENGTH = 1_024
const MIN_SESSION_TTL_MS = 5 * 60_000
const MAX_SESSION_TTL_MS = 90 * 24 * 60 * 60_000
const MIN_INVITATION_TTL_MS = 5 * 60_000
const MAX_INVITATION_TTL_MS = 30 * 24 * 60 * 60_000
const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60_000
const DEFAULT_INVITATION_TTL_MS = 7 * 24 * 60 * 60_000
const MAX_SETTINGS_BYTES = 16 * 1_024

export const SCRYPT_PARAMETERS = Object.freeze({
	cost: 32_768,
	blockSize: 8,
	parallelization: 1,
	keyLength: 32,
	maxMemory: 64 * 1_024 * 1_024,
})

export type AuthErrorCode =
	| 'account_disabled'
	| 'board_exists'
	| 'board_not_found'
	| 'bootstrap_complete'
	| 'forbidden'
	| 'invalid_credentials'
	| 'invalid_input'
	| 'invalid_invitation'
	| 'invitation_required'
	| 'login_taken'
	| 'user_not_found'

export class AuthError extends Error {
	readonly code: AuthErrorCode
	readonly statusCode: number

	constructor(code: AuthErrorCode, message: string, statusCode: number) {
		super(message)
		this.name = 'AuthError'
		this.code = code
		this.statusCode = statusCode
	}
}

export interface AuthUser {
	id: string
	login: string
	displayName: string
	settings: Record<string, unknown>
	isAdmin: boolean
	createdAt: string
	updatedAt: string
	lastLoginAt: string | null
	disabledAt: string | null
}

export interface AuthSession {
	id: string
	createdAt: string
	expiresAt: string
	lastSeenAt: string
}

export interface CurrentSession {
	user: AuthUser
	session: AuthSession
}

export interface SessionGrant extends CurrentSession {
	/** Opaque credential returned only at creation time. Store it in an HttpOnly cookie. */
	token: string
}

export interface BoardSummary {
	id: string
	name: string
	ownerUserId: string
	role: BoardRole
	createdAt: string
	updatedAt: string
	deletedAt: string | null
}

export interface BoardMember {
	boardId: string
	userId: string
	role: BoardRole
	createdAt: string
	updatedAt: string
}

export interface InvitationSummary {
	id: string
	boardId: string | null
	role: Exclude<BoardRole, 'owner'> | null
	invitedLogin: string | null
	createdAt: string
	expiresAt: string
	consumedAt: string | null
	revokedAt: string | null
}

export interface InvitationGrant {
	invitation: InvitationSummary
	/** Opaque credential returned only at creation time. It is never stored in plaintext. */
	token: string
}

export interface RegisterInput {
	login: string
	displayName: string
	password: string
	invitationToken?: string
	settings?: Record<string, unknown>
}

export interface LoginInput {
	login: string
	password: string
}

export interface CreateInvitationInput {
	boardId?: string
	role?: BoardRole
	invitedLogin?: string
	expiresInMs?: number
}

export interface LegacyBoardInput {
	id: string
	name?: string
}

export interface AuthServiceOptions {
	database?: AuthDatabase
	databasePath?: string
	now?: () => Date
	allowOpenRegistration?: boolean
	sessionTtlMs?: number
	invitationTtlMs?: number
}

function scryptAsync(password: string, salt: Buffer, keyLength: number, options: { N: number; r: number; p: number; maxmem: number }): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		scrypt(password, salt, keyLength, options, (error, derivedKey) => {
			if (error) reject(error)
			else resolve(derivedKey)
		})
	})
}

function validatePassword(password: string): void {
	if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
		throw new AuthError('invalid_input', `Password must be ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} characters`, 400)
	}
}

export async function hashPassword(password: string): Promise<string> {
	validatePassword(password)
	const salt = randomBytes(16)
	const key = await scryptAsync(password, salt, SCRYPT_PARAMETERS.keyLength, {
		N: SCRYPT_PARAMETERS.cost,
		r: SCRYPT_PARAMETERS.blockSize,
		p: SCRYPT_PARAMETERS.parallelization,
		maxmem: SCRYPT_PARAMETERS.maxMemory,
	})
	return [
		'scrypt',
		'v1',
		String(SCRYPT_PARAMETERS.cost),
		String(SCRYPT_PARAMETERS.blockSize),
		String(SCRYPT_PARAMETERS.parallelization),
		salt.toString('base64url'),
		key.toString('base64url'),
	].join('$')
}

export async function verifyPassword(password: string, encodedHash: string): Promise<boolean> {
	if (typeof password !== 'string' || password.length > MAX_PASSWORD_LENGTH) return false
	const parts = encodedHash.split('$')
	if (parts.length !== 7 || parts[0] !== 'scrypt' || parts[1] !== 'v1') return false
	const cost = Number(parts[2])
	const blockSize = Number(parts[3])
	const parallelization = Number(parts[4])
	if (
		cost !== SCRYPT_PARAMETERS.cost
		|| blockSize !== SCRYPT_PARAMETERS.blockSize
		|| parallelization !== SCRYPT_PARAMETERS.parallelization
	) return false

	let salt: Buffer
	let expected: Buffer
	try {
		salt = Buffer.from(parts[5], 'base64url')
		expected = Buffer.from(parts[6], 'base64url')
	} catch {
		return false
	}
	if (salt.length < 16 || salt.length > 32 || expected.length !== SCRYPT_PARAMETERS.keyLength) return false
	try {
		const actual = await scryptAsync(password, salt, expected.length, {
			N: cost,
			r: blockSize,
			p: parallelization,
			maxmem: SCRYPT_PARAMETERS.maxMemory,
		})
		return timingSafeEqual(actual, expected)
	} catch {
		return false
	}
}

export function normalizeLogin(login: string): string {
	if (typeof login !== 'string') throw new AuthError('invalid_input', 'Login is required', 400)
	const normalized = login.normalize('NFKC').trim().toLocaleLowerCase('en-US')
	if (
		normalized.length < 3
		|| normalized.length > 80
		|| !/^[\p{L}\p{N}][\p{L}\p{N}._@+-]*$/u.test(normalized)
	) throw new AuthError('invalid_input', 'Login must be 3-80 letters, numbers, or . _ @ + - characters', 400)
	return normalized
}

function cleanLogin(login: string): string {
	if (typeof login !== 'string') throw new AuthError('invalid_input', 'Login is required', 400)
	const cleaned = login.normalize('NFKC').trim()
	normalizeLogin(cleaned)
	return cleaned
}

function cleanDisplayName(displayName: string): string {
	if (typeof displayName !== 'string') throw new AuthError('invalid_input', 'Display name is required', 400)
	const cleaned = displayName.normalize('NFKC').trim()
	if (cleaned.length < 1 || cleaned.length > 100 || /[\u0000-\u001f\u007f]/u.test(cleaned)) {
		throw new AuthError('invalid_input', 'Display name must be 1-100 printable characters', 400)
	}
	return cleaned
}

function cleanBoardName(name: string): string {
	if (typeof name !== 'string') throw new AuthError('invalid_input', 'Board name is required', 400)
	const cleaned = name.normalize('NFKC').trim()
	if (cleaned.length < 1 || cleaned.length > 120 || /[\u0000-\u001f\u007f]/u.test(cleaned)) {
		throw new AuthError('invalid_input', 'Board name must be 1-120 printable characters', 400)
	}
	return cleaned
}

export function validateBoardId(id: string): string {
	if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(id)) {
		throw new AuthError('invalid_input', 'Board ID must be 1-80 letters, numbers, underscores, or hyphens', 400)
	}
	return id
}

function serializeObject(value: Record<string, unknown> | undefined, fieldName: string): string {
	if (value !== undefined && (value === null || typeof value !== 'object' || Array.isArray(value))) {
		throw new AuthError('invalid_input', `${fieldName} must be an object`, 400)
	}
	let json: string
	try {
		json = JSON.stringify(value ?? {})
	} catch {
		throw new AuthError('invalid_input', `${fieldName} must be valid JSON`, 400)
	}
	if (Buffer.byteLength(json, 'utf8') > MAX_SETTINGS_BYTES) {
		throw new AuthError('invalid_input', `${fieldName} is too large`, 400)
	}
	return json
}

function parseObject(json: string): Record<string, unknown> {
	try {
		const value: unknown = JSON.parse(json)
		return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
	} catch {
		return {}
	}
}

function hashOpaqueToken(token: string): string {
	return createHash('sha256').update(token, 'utf8').digest('hex')
}

function validOpaqueToken(token: string): boolean {
	return typeof token === 'string' && /^[A-Za-z0-9_-]{40,128}$/.test(token)
}

function checkedTtl(value: number, minimum: number, maximum: number, field: string): number {
	if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
		throw new AuthError('invalid_input', `${field} is outside the allowed range`, 400)
	}
	return value
}

function publicUser(user: UserRecord): AuthUser {
	return {
		id: user.id,
		login: user.login,
		displayName: user.displayName,
		settings: parseObject(user.settingsJson),
		isAdmin: user.isAdmin,
		createdAt: user.createdAt,
		updatedAt: user.updatedAt,
		lastLoginAt: user.lastLoginAt,
		disabledAt: user.disabledAt,
	}
}

function publicSession(session: SessionRecord): AuthSession {
	return {
		id: session.id,
		createdAt: session.createdAt,
		expiresAt: session.expiresAt,
		lastSeenAt: session.lastSeenAt,
	}
}

function publicBoard(board: BoardWithRoleRecord | BoardRecord, role: BoardRole): BoardSummary {
	return {
		id: board.id,
		name: board.name,
		ownerUserId: board.ownerUserId,
		role,
		createdAt: board.createdAt,
		updatedAt: board.updatedAt,
		deletedAt: board.deletedAt,
	}
}

function publicInvitation(invitation: InvitationRecord): InvitationSummary {
	return {
		id: invitation.id,
		boardId: invitation.boardId,
		role: invitation.role,
		invitedLogin: invitation.invitedLoginNormalized,
		createdAt: invitation.createdAt,
		expiresAt: invitation.expiresAt,
		consumedAt: invitation.consumedAt,
		revokedAt: invitation.revokedAt,
	}
}

function isLoginUniqueConstraint(error: unknown): boolean {
	return error instanceof Error
		&& 'code' in error
		&& String((error as { code?: unknown }).code).startsWith('SQLITE_CONSTRAINT')
		&& error.message.includes('users.login_normalized')
}

export class AuthService {
	readonly database: AuthDatabase
	private readonly ownsDatabase: boolean
	private readonly now: () => Date
	private readonly allowOpenRegistration: boolean
	private readonly sessionTtlMs: number
	private readonly invitationTtlMs: number

	constructor(databaseOrOptions: AuthDatabase | AuthServiceOptions = {}) {
		const options = databaseOrOptions instanceof AuthDatabase ? { database: databaseOrOptions } : databaseOrOptions
		this.database = options.database ?? new AuthDatabase(options.databasePath)
		this.ownsDatabase = !options.database
		this.now = options.now ?? (() => new Date())
		this.allowOpenRegistration = options.allowOpenRegistration ?? false
		this.sessionTtlMs = checkedTtl(options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS, MIN_SESSION_TTL_MS, MAX_SESSION_TTL_MS, 'Session lifetime')
		this.invitationTtlMs = checkedTtl(
			options.invitationTtlMs ?? DEFAULT_INVITATION_TTL_MS,
			MIN_INVITATION_TTL_MS,
			MAX_INVITATION_TTL_MS,
			'Invitation lifetime',
		)
	}

	close(): void {
		if (this.ownsDatabase) this.database.close()
	}

	async bootstrapFirstUser(input: Omit<RegisterInput, 'invitationToken'>): Promise<SessionGrant> {
		return this.registerInternal(input, true)
	}

	async register(input: RegisterInput): Promise<SessionGrant> {
		return this.registerInternal(input, false)
	}

	private async registerInternal(input: RegisterInput, bootstrapOnly: boolean): Promise<SessionGrant> {
		const login = cleanLogin(input.login)
		const loginNormalized = normalizeLogin(login)
		const displayName = cleanDisplayName(input.displayName)
		const settingsJson = serializeObject(input.settings, 'Settings')
		const passwordHash = await hashPassword(input.password)
		const invitationHash = input.invitationToken && validOpaqueToken(input.invitationToken)
			? hashOpaqueToken(input.invitationToken)
			: null
		const now = this.now()
		const at = now.toISOString()
		const userId = randomUUID()
		const rawSessionToken = randomBytes(SESSION_TOKEN_BYTES).toString('base64url')
		const session: SessionRecord = {
			id: randomUUID(),
			tokenHash: hashOpaqueToken(rawSessionToken),
			userId,
			createdAt: at,
			expiresAt: new Date(now.getTime() + this.sessionTtlMs).toISOString(),
			lastSeenAt: at,
			revokedAt: null,
		}

		try {
			return this.database.transaction(() => {
				const userCount = this.database.countUsers()
				if (bootstrapOnly && userCount !== 0) {
					throw new AuthError('bootstrap_complete', 'The first account has already been created', 409)
				}
				if (this.database.getUserByNormalizedLogin(loginNormalized)) {
					throw new AuthError('login_taken', 'That login is already in use', 409)
				}
				const invitation = invitationHash ? this.database.getInvitationByTokenHash(invitationHash) : null
				if (input.invitationToken && !invitation) {
					throw new AuthError('invalid_invitation', 'Invitation is invalid or unavailable', 400)
				}
				if (userCount > 0 && !this.allowOpenRegistration && !invitation) {
					throw new AuthError('invitation_required', 'A valid invitation is required', 403)
				}
				if (invitation) this.assertInvitationUsable(invitation, loginNormalized, at)

				const user: UserRecord = {
					id: userId,
					login,
					loginNormalized,
					displayName,
					passwordHash,
					settingsJson,
					isAdmin: userCount === 0,
					createdAt: at,
					updatedAt: at,
					lastLoginAt: at,
					disabledAt: null,
				}
				this.database.insertUser(user)
				if (invitation) {
					if (!this.database.consumeInvitation(invitation.id, user.id, at)) {
						throw new AuthError('invalid_invitation', 'Invitation is invalid or unavailable', 400)
					}
					this.applyInvitedMembership(invitation, user.id, at)
					this.event('invitation.consumed', user.id, user.id, invitation.boardId, { invitationId: invitation.id }, at)
				}
				this.database.insertSession(session)
				this.event(user.isAdmin ? 'account.bootstrapped' : 'account.registered', user.id, user.id, invitation?.boardId ?? null, {}, at)
				return { user: publicUser(user), session: publicSession(session), token: rawSessionToken }
			})
		} catch (error) {
			if (error instanceof AuthError) throw error
			if (isLoginUniqueConstraint(error)) throw new AuthError('login_taken', 'That login is already in use', 409)
			throw error
		}
	}

	async login(input: LoginInput): Promise<SessionGrant> {
		const loginNormalized = normalizeLogin(input.login)
		const user = this.database.getUserByNormalizedLogin(loginNormalized)
		const passwordMatches = user
			? await verifyPassword(input.password, user.passwordHash)
			: (await hashPasswordForDummyCheck(input.password), false)
		if (!user || !passwordMatches || user.disabledAt) {
			throw new AuthError('invalid_credentials', 'Login or password is incorrect', 401)
		}

		const now = this.now()
		const at = now.toISOString()
		const token = randomBytes(SESSION_TOKEN_BYTES).toString('base64url')
		const session: SessionRecord = {
			id: randomUUID(),
			tokenHash: hashOpaqueToken(token),
			userId: user.id,
			createdAt: at,
			expiresAt: new Date(now.getTime() + this.sessionTtlMs).toISOString(),
			lastSeenAt: at,
			revokedAt: null,
		}
		this.database.transaction(() => {
			this.database.setLastLogin(user.id, at)
			this.database.insertSession(session)
			this.event('session.created', user.id, user.id, null, {}, at)
		})
		const refreshedUser = this.database.getUserById(user.id) ?? user
		return { user: publicUser(refreshedUser), session: publicSession(session), token }
	}

	getCurrentSession(token: string): CurrentSession | null {
		if (!validOpaqueToken(token)) return null
		const tokenHash = hashOpaqueToken(token)
		const session = this.database.getSessionByTokenHash(tokenHash)
		if (!session || session.revokedAt) return null
		const at = this.now().toISOString()
		if (session.expiresAt <= at) {
			this.database.revokeSessionByTokenHash(tokenHash, at)
			return null
		}
		const user = this.database.getUserById(session.userId)
		if (!user || user.disabledAt) return null
		this.database.touchSession(session.id, at)
		return { user: publicUser(user), session: publicSession({ ...session, lastSeenAt: at }) }
	}

	logout(token: string): boolean {
		if (!validOpaqueToken(token)) return false
		const at = this.now().toISOString()
		return this.database.transaction(() => {
			const revoked = this.database.revokeSessionByTokenHash(hashOpaqueToken(token), at)
			if (!revoked) return false
			this.event('session.revoked', revoked.userId, revoked.userId, null, { sessionId: revoked.id }, at)
			return true
		})
	}

	listBoards(userId: string, includeDeleted = false): BoardSummary[] {
		this.requireActiveUser(userId)
		return this.database.listBoardsForUser(userId, includeDeleted).map((board) => publicBoard(board, board.role))
	}

	createBoard(userId: string, name: string, requestedId?: string): BoardSummary {
		this.requireActiveUser(userId)
		const id = validateBoardId(requestedId ?? randomUUID())
		const cleanName = cleanBoardName(name)
		const at = this.now().toISOString()
		return this.database.transaction(() => {
			if (this.database.getBoardById(id)) throw new AuthError('board_exists', 'A board with that ID already exists', 409)
			const board: BoardRecord = { id, name: cleanName, ownerUserId: userId, createdAt: at, updatedAt: at, deletedAt: null }
			this.database.insertBoard(board)
			this.database.upsertBoardMember({ boardId: id, userId, role: 'owner', createdAt: at, updatedAt: at })
			this.event('board.created', userId, userId, id, { name: cleanName }, at)
			return publicBoard(board, 'owner')
		})
	}

	/** Adopt already-discovered legacy room IDs without reading or changing room files. */
	adoptLegacyBoards(ownerUserId: string, boards: readonly LegacyBoardInput[]): BoardSummary[] {
		const owner = this.requireActiveUser(ownerUserId)
		if (!owner.isAdmin) throw new AuthError('forbidden', 'Administrator access is required', 403)
		if (boards.length > 1_000) throw new AuthError('invalid_input', 'Too many boards in one adoption', 400)
		const cleaned = new Map<string, string>()
		for (const board of boards) {
			const id = validateBoardId(board.id)
			cleaned.set(id, cleanBoardName(board.name ?? (id === 'demo' ? 'Demo' : id)))
		}
		const at = this.now().toISOString()
		return this.database.transaction(() => {
			const adopted: BoardSummary[] = []
			for (const [id, name] of cleaned) {
				if (this.database.getBoardById(id)) continue
				const board: BoardRecord = { id, name, ownerUserId, createdAt: at, updatedAt: at, deletedAt: null }
				this.database.insertBoard(board)
				this.database.upsertBoardMember({ boardId: id, userId: ownerUserId, role: 'owner', createdAt: at, updatedAt: at })
				this.event('board.legacy_adopted', ownerUserId, ownerUserId, id, { name }, at)
				adopted.push(publicBoard(board, 'owner'))
			}
			return adopted
		})
	}

	getBoard(userId: string, boardId: string, includeDeleted = false): BoardSummary | null {
		this.requireActiveUser(userId)
		const id = validateBoardId(boardId)
		const board = this.database.getBoardById(id)
		const membership = this.database.getBoardMember(id, userId)
		if (!board || !membership || (!includeDeleted && board.deletedAt)) return null
		return publicBoard(board, membership.role)
	}

	getBoardRole(userId: string, boardId: string, includeDeleted = false): BoardRole | null {
		return this.getBoard(userId, boardId, includeDeleted)?.role ?? null
	}

	renameBoard(userId: string, boardId: string, name: string): BoardSummary {
		const { board, membership } = this.requireBoardMember(userId, boardId, true)
		if (membership.role !== 'owner') throw new AuthError('forbidden', 'Only the board owner can rename this board', 403)
		const cleanName = cleanBoardName(name)
		const at = this.now().toISOString()
		this.database.transaction(() => {
			this.database.renameBoard(board.id, cleanName, at)
			this.event('board.renamed', userId, userId, board.id, { previousName: board.name, name: cleanName }, at)
		})
		return publicBoard({ ...board, name: cleanName, updatedAt: at }, membership.role)
	}

	deleteBoard(userId: string, boardId: string): BoardSummary {
		const { board, membership } = this.requireBoardMember(userId, boardId, true)
		if (membership.role !== 'owner') throw new AuthError('forbidden', 'Only the board owner can delete this board', 403)
		if (board.deletedAt) return publicBoard(board, membership.role)
		const at = this.now().toISOString()
		this.database.transaction(() => {
			this.database.setBoardDeleted(board.id, at, at)
			this.event('board.deleted', userId, userId, board.id, {}, at)
		})
		return publicBoard({ ...board, updatedAt: at, deletedAt: at }, membership.role)
	}

	restoreBoard(userId: string, boardId: string): BoardSummary {
		const { board, membership } = this.requireBoardMember(userId, boardId, true)
		if (membership.role !== 'owner') throw new AuthError('forbidden', 'Only the board owner can restore this board', 403)
		if (!board.deletedAt) return publicBoard(board, membership.role)
		const at = this.now().toISOString()
		this.database.transaction(() => {
			this.database.setBoardDeleted(board.id, null, at)
			this.event('board.restored', userId, userId, board.id, {}, at)
		})
		return publicBoard({ ...board, updatedAt: at, deletedAt: null }, membership.role)
	}

	listBoardMembers(userId: string, boardId: string): BoardMember[] {
		this.requireBoardMember(userId, boardId, false)
		return this.database.listBoardMembers(validateBoardId(boardId))
	}

	setBoardMemberRole(
		actorUserId: string,
		boardId: string,
		targetUserId: string,
		role: Exclude<BoardRole, 'owner'> | null,
	): BoardMember | null {
		const { board, membership } = this.requireBoardMember(actorUserId, boardId, false)
		if (membership.role !== 'owner') throw new AuthError('forbidden', 'Only the board owner can manage members', 403)
		if (targetUserId === board.ownerUserId) throw new AuthError('forbidden', 'The board owner role cannot be changed', 403)
		this.requireActiveUser(targetUserId)
		if (role !== null && role !== 'editor' && role !== 'viewer') {
			throw new AuthError('invalid_input', 'Member role must be editor or viewer', 400)
		}
		const at = this.now().toISOString()
		return this.database.transaction(() => {
			if (role === null) {
				this.database.removeBoardMember(board.id, targetUserId)
				this.event('board.member_removed', actorUserId, targetUserId, board.id, {}, at)
				return null
			}
			const existing = this.database.getBoardMember(board.id, targetUserId)
			const member: BoardMemberRecord = {
				boardId: board.id,
				userId: targetUserId,
				role,
				createdAt: existing?.createdAt ?? at,
				updatedAt: at,
			}
			this.database.upsertBoardMember(member)
			this.event('board.member_role_changed', actorUserId, targetUserId, board.id, { role }, at)
			return member
		})
	}

	createInvitation(actorUserId: string, input: CreateInvitationInput = {}): InvitationGrant {
		const actor = this.requireActiveUser(actorUserId)
		const boardId = input.boardId === undefined ? null : validateBoardId(input.boardId)
		if (input.role !== undefined && input.role !== 'owner' && input.role !== 'editor' && input.role !== 'viewer') {
			throw new AuthError('invalid_input', 'Invitation role must be editor or viewer', 400)
		}
		if (input.role === 'owner') throw new AuthError('invalid_input', 'Invitations cannot grant owner access', 400)
		if (!boardId && input.role) throw new AuthError('invalid_input', 'Account invitations cannot specify a board role', 400)
		const role: Exclude<BoardRole, 'owner'> | null = boardId ? (input.role ?? 'viewer') : null
		if (boardId) {
			const { membership } = this.requireBoardMember(actorUserId, boardId, false)
			if (membership.role !== 'owner') throw new AuthError('forbidden', 'Only the board owner can invite members', 403)
		} else if (!actor.isAdmin) {
			throw new AuthError('forbidden', 'Only an administrator can create account invitations', 403)
		}
		const invitedLoginNormalized = input.invitedLogin ? normalizeLogin(input.invitedLogin) : null
		const ttl = checkedTtl(
			input.expiresInMs ?? this.invitationTtlMs,
			MIN_INVITATION_TTL_MS,
			MAX_INVITATION_TTL_MS,
			'Invitation lifetime',
		)
		const now = this.now()
		const at = now.toISOString()
		const token = randomBytes(INVITATION_TOKEN_BYTES).toString('base64url')
		const invitation: InvitationRecord = {
			id: randomUUID(),
			tokenHash: hashOpaqueToken(token),
			createdByUserId: actorUserId,
			boardId,
			role,
			invitedLoginNormalized,
			createdAt: at,
			expiresAt: new Date(now.getTime() + ttl).toISOString(),
			consumedAt: null,
			consumedByUserId: null,
			revokedAt: null,
		}
		this.database.transaction(() => {
			this.database.insertInvitation(invitation)
			this.event('invitation.created', actorUserId, null, boardId, {
				invitationId: invitation.id,
				role,
				invitedLogin: invitedLoginNormalized,
				expiresAt: invitation.expiresAt,
			}, at)
		})
		return { invitation: publicInvitation(invitation), token }
	}

	consumeInvitation(userId: string, token: string): InvitationSummary {
		const user = this.requireActiveUser(userId)
		if (!validOpaqueToken(token)) throw new AuthError('invalid_invitation', 'Invitation is invalid or unavailable', 400)
		const at = this.now().toISOString()
		return this.database.transaction(() => {
			const invitation = this.database.getInvitationByTokenHash(hashOpaqueToken(token))
			if (!invitation) throw new AuthError('invalid_invitation', 'Invitation is invalid or unavailable', 400)
			this.assertInvitationUsable(invitation, user.loginNormalized, at)
			if (!this.database.consumeInvitation(invitation.id, user.id, at)) {
				throw new AuthError('invalid_invitation', 'Invitation is invalid or unavailable', 400)
			}
			this.applyInvitedMembership(invitation, user.id, at)
			this.event('invitation.consumed', user.id, user.id, invitation.boardId, { invitationId: invitation.id }, at)
			return publicInvitation({ ...invitation, consumedAt: at })
		})
	}

	revokeInvitation(actorUserId: string, token: string): boolean {
		const actor = this.requireActiveUser(actorUserId)
		if (!validOpaqueToken(token)) return false
		const at = this.now().toISOString()
		return this.database.transaction(() => {
			const invitation = this.database.getInvitationByTokenHash(hashOpaqueToken(token))
			if (!invitation || invitation.consumedAt || invitation.revokedAt) return false
			if (invitation.createdByUserId !== actorUserId && !actor.isAdmin) {
				throw new AuthError('forbidden', 'Only the invitation creator can revoke it', 403)
			}
			const revoked = this.database.revokeInvitation(invitation.id, at)
			if (revoked) this.event('invitation.revoked', actorUserId, null, invitation.boardId, { invitationId: invitation.id }, at)
			return revoked
		})
	}

	updateSettings(userId: string, settings: Record<string, unknown>): AuthUser {
		const user = this.requireActiveUser(userId)
		const settingsJson = serializeObject(settings, 'Settings')
		const at = this.now().toISOString()
		this.database.transaction(() => {
			this.database.setUserSettings(userId, settingsJson, at)
			this.event('account.settings_updated', userId, userId, null, {}, at)
		})
		return publicUser({ ...user, settingsJson, updatedAt: at })
	}

	setUserDisabled(actorUserId: string, targetUserId: string, disabled: boolean): AuthUser {
		const actor = this.requireActiveUser(actorUserId)
		if (!actor.isAdmin) throw new AuthError('forbidden', 'Administrator access is required', 403)
		if (actorUserId === targetUserId && disabled) throw new AuthError('forbidden', 'You cannot disable your own account', 403)
		const target = this.database.getUserById(targetUserId)
		if (!target) throw new AuthError('user_not_found', 'User was not found', 404)
		const at = this.now().toISOString()
		const disabledAt = disabled ? at : null
		this.database.transaction(() => {
			this.database.setUserDisabled(targetUserId, disabledAt, at)
			if (disabled) this.database.revokeSessionsForUser(targetUserId, at)
			this.event(disabled ? 'account.disabled' : 'account.enabled', actorUserId, targetUserId, null, {}, at)
		})
		return publicUser({ ...target, disabledAt, updatedAt: at })
	}

	listAuditEvents(actorUserId: string, options: { userId?: string; boardId?: string; limit?: number } = {}): AccountEventRecord[] {
		const actor = this.requireActiveUser(actorUserId)
		if (options.boardId && !actor.isAdmin) {
			const { membership } = this.requireBoardMember(actorUserId, options.boardId, true)
			if (membership.role !== 'owner') throw new AuthError('forbidden', 'Board owner access is required', 403)
		} else if (!actor.isAdmin && options.userId !== actorUserId) {
			throw new AuthError('forbidden', 'Administrator access is required', 403)
		}
		return this.database.listAccountEvents(options)
	}

	private requireActiveUser(userId: string): UserRecord {
		const user = this.database.getUserById(userId)
		if (!user) throw new AuthError('user_not_found', 'User was not found', 404)
		if (user.disabledAt) throw new AuthError('account_disabled', 'Account is disabled', 403)
		return user
	}

	private requireBoardMember(userId: string, boardId: string, includeDeleted: boolean): { board: BoardRecord; membership: BoardMemberRecord } {
		this.requireActiveUser(userId)
		const id = validateBoardId(boardId)
		const board = this.database.getBoardById(id)
		const membership = this.database.getBoardMember(id, userId)
		if (!board || !membership || (!includeDeleted && board.deletedAt)) {
			throw new AuthError('board_not_found', 'Board was not found', 404)
		}
		return { board, membership }
	}

	private assertInvitationUsable(invitation: InvitationRecord, loginNormalized: string, at: string): void {
		if (
			invitation.consumedAt
			|| invitation.revokedAt
			|| invitation.expiresAt <= at
			|| (invitation.invitedLoginNormalized && invitation.invitedLoginNormalized !== loginNormalized)
		) throw new AuthError('invalid_invitation', 'Invitation is invalid or unavailable', 400)
		if (invitation.boardId) {
			const board = this.database.getBoardById(invitation.boardId)
			if (!board || board.deletedAt) throw new AuthError('invalid_invitation', 'Invitation is invalid or unavailable', 400)
		}
	}

	private applyInvitedMembership(invitation: InvitationRecord, userId: string, at: string): void {
		if (!invitation.boardId || !invitation.role) return
		const existing = this.database.getBoardMember(invitation.boardId, userId)
		const rank: Record<BoardRole, number> = { viewer: 1, editor: 2, owner: 3 }
		if (existing && rank[existing.role] >= rank[invitation.role]) return
		this.database.upsertBoardMember({
			boardId: invitation.boardId,
			userId,
			role: invitation.role,
			createdAt: existing?.createdAt ?? at,
			updatedAt: at,
		})
	}

	private event(
		type: string,
		actorUserId: string | null,
		subjectUserId: string | null,
		boardId: string | null,
		metadata: Record<string, unknown>,
		at: string,
	): void {
		this.database.insertAccountEvent({
			eventId: randomUUID(),
			type,
			actorUserId,
			subjectUserId,
			boardId,
			metadataJson: JSON.stringify(metadata),
			createdAt: at,
		})
	}
}

async function hashPasswordForDummyCheck(password: string): Promise<void> {
	const bounded = typeof password === 'string' && password.length <= MAX_PASSWORD_LENGTH ? password : ''
	const salt = randomBytes(16)
	await scryptAsync(bounded, salt, SCRYPT_PARAMETERS.keyLength, {
		N: SCRYPT_PARAMETERS.cost,
		r: SCRYPT_PARAMETERS.blockSize,
		p: SCRYPT_PARAMETERS.parallelization,
		maxmem: SCRYPT_PARAMETERS.maxMemory,
	})
}
