import { createReadStream, existsSync, mkdirSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest, type FastifyServerOptions } from 'fastify'
import fastifyStatic from '@fastify/static'
import websocketPlugin from '@fastify/websocket'
import type { RawData, WebSocket } from 'ws'
import { z, ZodError } from 'zod'
import { AuthError, AuthService, type CurrentSession, type LegacyBoardInput } from './auth'
import type { BoardRole } from './auth-db'
import { applyRoomActions, CanvasApiError, readRoomCanvas, readRoomSemantics } from './canvas-api'
import { HttpError } from './http'
import {
	appendRoomEvent,
	closeAllRooms,
	closeBoardSessions,
	closeUserRoomSessions,
	closeUserSessions,
	configureRoomAuditReader,
	configureRoomDataDirectory,
	connectRoomSocket,
	createRoomCheckpoint,
	getRoomHandle,
	restoreRoomVersion,
	RoomRestoreError,
	withRoomHistory,
} from './rooms'
import {
	allowedOrigins,
	clientAddress,
	expiredSessionCookie,
	originAllowed,
	readCookie,
	requestIsSecure,
	sessionCookie,
	SlidingWindowRateLimiter,
} from './security'
import { authorizeApiToken, type ApiPermission } from './tokens'
import type { HistoryEvent, HistoryEventFilters, HistorySource, HistoryEventType } from '../shared/history'

export interface RateLimitSetting {
	limit: number
	windowMs: number
}

/** Operator and test overrides for the per-actor budgets. Production uses the module constants. */
export interface RateLimitOptions {
	login?: RateLimitSetting
	register?: RateLimitSetting
	write?: RateLimitSetting
	snapshot?: RateLimitSetting
	invitation?: RateLimitSetting
	upload?: RateLimitSetting
}

export interface BuildAppOptions {
	dataDirectory?: string
	clientDirectory?: string
	serveClient?: boolean
	logger?: FastifyServerOptions['logger']
	rateLimits?: RateLimitOptions
}

const ALL_PERMISSIONS: readonly ApiPermission[] = ['read', 'write', 'history', 'restore']
const LOGIN_LIMIT = 10
const LOGIN_WINDOW_MS = 15 * 60_000
/** Per-actor budget for authenticated canvas writes and AI lifecycle events. */
const WRITE_LIMIT = 120
const WRITE_WINDOW_MS = 60_000
/** Checkpoints and restores copy a whole board snapshot, so they carry a tighter budget. */
const SNAPSHOT_LIMIT = 20
const SNAPSHOT_WINDOW_MS = 5 * 60_000
const INVITATION_LIMIT = 30
const INVITATION_WINDOW_MS = 60 * 60_000
const UPLOAD_LIMIT = 60
const UPLOAD_WINDOW_MS = 15 * 60_000
const AI_EVENT_TYPES = [
	'ai.requested',
	'ai.suggestion_generated',
	'ai.suggestion_accepted',
	'ai.suggestion_rejected',
	'ai.request_cancelled',
	'ai.object_created',
] as const

const loginSchema = z.object({
	login: z.string().min(1).max(80),
	password: z.string().min(1).max(1_024),
}).strict()
const registerSchema = z.object({
	login: z.string().min(1).max(80),
	displayName: z.string().min(1).max(100),
	password: z.string().min(1).max(1_024),
	invitationToken: z.string().min(1).optional(),
	settings: z.record(z.string(), z.unknown()).optional(),
}).strict()
const settingsSchema = z.object({ settings: z.record(z.string(), z.unknown()) }).strict()
const createBoardSchema = z.object({
	name: z.string().min(1).max(120),
	id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/).optional(),
}).strict()
const renameBoardSchema = z.object({ name: z.string().min(1).max(120) }).strict()
const memberRoleSchema = z.object({ role: z.enum(['editor', 'viewer']).nullable() }).strict()
const createInvitationSchema = z.object({
	boardId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/).optional(),
	role: z.enum(['editor', 'viewer']).optional(),
	invitedLogin: z.string().min(1).max(80).optional(),
	expiresInMs: z.number().int().positive().optional(),
}).strict()
const invitationTokenSchema = z.object({ token: z.string().min(1).max(128) }).strict()
const checkpointCreateSchema = z.object({ label: z.string().min(1).max(120).optional() }).strict()
const historyRestoreSchema = z.object({
	eventId: z.number().int().positive(),
	expectedClock: z.number().int().nonnegative(),
}).strict()
const aiEventSchema = z.object({
	eventType: z.enum(AI_EVENT_TYPES),
	metadata: z.record(z.string(), z.unknown()).optional(),
}).strict()

type BoardAccess =
	| { kind: 'user'; userId: string; displayName: string; role: BoardRole }
	| { kind: 'token'; clientName: string; permissions: ReadonlySet<ApiPermission> }
	| { kind: 'not_member' }
	| { kind: 'anonymous' }

function parseRoomId(value: unknown): string | null {
	return typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value) ? value : null
}

function userRoleHasWrite(role: BoardRole): boolean {
	return role === 'owner' || role === 'editor'
}

async function discoverLegacyRooms(dataDirectory: string): Promise<LegacyBoardInput[]> {
	const roomsDirectory = join(dataDirectory, 'rooms')
	if (!existsSync(roomsDirectory)) return []
	const boards: LegacyBoardInput[] = []
	for (const name of await readdir(roomsDirectory)) {
		if (!name.endsWith('.sqlite')) continue
		const id = name.slice(0, -'.sqlite'.length)
		if (/^[A-Za-z0-9_-]{1,80}$/.test(id)) boards.push({ id })
	}
	return boards
}

function historyActor(access: BoardAccess): { actorUserId: string; displayName: string } {
	if (access.kind === 'token') return { actorUserId: `token:${access.clientName}`, displayName: access.clientName }
	if (access.kind === 'user') return { actorUserId: `user:${access.userId}`, displayName: access.displayName }
	throw new Error('history attribution requires a user or token access')
}

/** Budget key for an already-authorized actor. It is never derived from client-supplied identity. */
function accessRateKey(access: BoardAccess, scope: string, boardId: string): string {
	if (access.kind === 'token') return `token:${access.clientName}:${scope}:${boardId}`
	if (access.kind === 'user') return `user:${access.userId}:${scope}:${boardId}`
	throw new Error('rate limiting requires a user or token access')
}

function tooManyRequests(reply: FastifyReply, activity: string) {
	return reply.code(429).send({ error: `Too many ${activity}. Try again later.` })
}

function sanitizeAiMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
	const clean: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(metadata ?? {})) {
		if (key === 'objectIds') {
			if (Array.isArray(value) && value.length <= 50 && value.every((item) => typeof item === 'string' && item.length <= 100)) {
				clean[key] = value
			}
			continue
		}
		if (key === 'count') {
			if (
				(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000)
				|| (typeof value === 'string' && value.length <= 100)
			) {
				clean[key] = value
			}
			continue
		}
		if (!['provider', 'model', 'proposalId', 'actionType', 'status', 'summary'].includes(key)) continue
		if (typeof value === 'string' && value.length <= 100) clean[key] = value
	}
	return clean
}

function parseHistoryFilterNumber(value: string | undefined): number | null | undefined {
	if (value === undefined) return undefined
	const parsed = Number(value)
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

function boardIdFromPath(url: string): string | null {
	const match = /^\/api\/(?:rooms|boards)\/([^/]+)/.exec(url.split('?')[0])
	return match ? parseRoomId(match[1]) : null
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
	const dataDirectory = resolve(options.dataDirectory ?? process.env.CANVAS_DATA_DIR ?? './data')
	const clientDirectory = resolve(options.clientDirectory ?? process.env.CANVAS_CLIENT_DIR ?? './dist/client')
	const serveClient = options.serveClient ?? true
	const logger = options.logger ?? true

	configureRoomDataDirectory(dataDirectory)
	const assetDirectory = join(dataDirectory, 'assets')
	mkdirSync(assetDirectory, { recursive: true })

	const authDatabasePath = process.env.CANVAS_AUTH_DB_FILE ?? join(dataDirectory, 'auth.sqlite')
	const authService = new AuthService({
		databasePath: authDatabasePath,
		allowOpenRegistration: process.env.CANVAS_ALLOW_OPEN_REGISTRATION === 'true',
	})
	const limiterFor = (setting: RateLimitSetting | undefined, limit: number, windowMs: number) =>
		new SlidingWindowRateLimiter(setting?.limit ?? limit, setting?.windowMs ?? windowMs)
	const loginLimiter = limiterFor(options.rateLimits?.login, LOGIN_LIMIT, LOGIN_WINDOW_MS)
	const registerLimiter = limiterFor(options.rateLimits?.register, LOGIN_LIMIT, LOGIN_WINDOW_MS)
	const writeLimiter = limiterFor(options.rateLimits?.write, WRITE_LIMIT, WRITE_WINDOW_MS)
	const snapshotLimiter = limiterFor(options.rateLimits?.snapshot, SNAPSHOT_LIMIT, SNAPSHOT_WINDOW_MS)
	const invitationLimiter = limiterFor(options.rateLimits?.invitation, INVITATION_LIMIT, INVITATION_WINDOW_MS)
	const uploadLimiter = limiterFor(options.rateLimits?.upload, UPLOAD_LIMIT, UPLOAD_WINDOW_MS)
	const allowed = allowedOrigins(process.env.CANVAS_ALLOWED_ORIGINS)
	configureRoomAuditReader((boardId, after) => authService.database.listBoardEventsSince(boardId, after).map((event) => ({
		...event,
		actorDisplayName: authService.database.getUserById(event.actorUserId ?? '')?.displayName,
	})))

	const app = fastify({ logger, bodyLimit: 150_000 })
	await app.register(websocketPlugin, { options: { maxPayload: 150_000 } })
	app.addContentTypeParser(/^image\/.+|^video\/.+/, { parseAs: 'buffer', bodyLimit: 20_000_000 }, (_request, body, done) => done(null, body))
	app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: 20_000_000 }, (_request, body, done) => done(null, body))

	function currentSession(request: FastifyRequest): CurrentSession | null {
		const token = readCookie(request.headers.cookie)
		if (!token) return null
		return authService.getCurrentSession(token)
	}

	function bearerPermissions(request: FastifyRequest, boardId: string): { clientName: string; permissions: Set<ApiPermission> } | null {
		const header = request.headers.authorization
		if (!header) return null
		let clientName: string | null = null
		const permissions = new Set<ApiPermission>()
		for (const permission of ALL_PERMISSIONS) {
			const matched = authorizeApiToken(header, boardId, permission)
			if (matched) {
				clientName ??= matched
				permissions.add(permission)
			}
		}
		return clientName ? { clientName, permissions } : null
	}

	function resolveBoardAccess(request: FastifyRequest, boardId: string): BoardAccess {
		const bearer = bearerPermissions(request, boardId)
		if (bearer) {
			const board = authService.database.getBoardById(boardId)
			if (!board || board.deletedAt) return { kind: 'not_member' }
			return { kind: 'token', clientName: bearer.clientName, permissions: bearer.permissions }
		}
		if (typeof request.headers.authorization === 'string' && request.headers.authorization.length > 0) {
			return { kind: 'anonymous' }
		}
		const session = currentSession(request)
		if (!session) return { kind: 'anonymous' }
		const role = authService.getBoardRole(session.user.id, boardId, false)
		if (!role) return { kind: 'not_member' }
		return { kind: 'user', userId: session.user.id, displayName: session.user.displayName, role }
	}

	function denyAccess(reply: FastifyReply, access: BoardAccess) {
		if (access.kind === 'anonymous') return reply.code(401).send({ error: 'Authentication required' })
		if (access.kind === 'not_member') return reply.code(404).send({ error: 'Board not found' })
		return reply.code(403).send({ error: 'You do not have permission to access this board' })
	}

	function setSessionCookie(reply: FastifyReply, request: FastifyRequest, token: string, expiresAt: string) {
		const maxAge = Math.max(1, Math.round((new Date(expiresAt).getTime() - Date.now()) / 1_000))
		reply.header('Set-Cookie', sessionCookie(token, requestIsSecure(request), maxAge))
	}

	function requireHistoryView(access: BoardAccess): boolean {
		if (access.kind === 'token') return access.permissions.has('history')
		return access.kind === 'user'
	}

	function resolveActors(events: readonly HistoryEvent[]): Array<{ id: string; displayName: string }> {
		const actorIds = new Set<string>()
		for (const event of events) {
			if (event.actorUserId) actorIds.add(event.actorUserId)
		}
		const actors: Array<{ id: string; displayName: string }> = []
		for (const actorId of actorIds) {
			if (actorId.startsWith('user:')) {
				const user = authService.database.getUserById(actorId.slice('user:'.length))
				actors.push({ id: actorId, displayName: user?.displayName ?? `User ${actorId.slice(5, 13)}` })
			} else if (actorId.startsWith('token:')) {
				actors.push({ id: actorId, displayName: actorId.slice('token:'.length) })
			}
		}
		actors.sort((a, b) => a.displayName.localeCompare(b.displayName))
		return actors
	}

	async function adoptLegacyBoardsForAdmin(adminUserId: string): Promise<string | undefined> {
		try {
			const legacy = await discoverLegacyRooms(dataDirectory)
			if (!legacy.length) return undefined
			authService.adoptLegacyBoards(adminUserId, legacy)
			return undefined
		} catch (error) {
			return error instanceof Error ? error.message : String(error)
		}
	}

	app.addHook('onRequest', async (request, reply) => {
		if (request.method !== 'POST' && request.method !== 'PUT' && request.method !== 'PATCH' && request.method !== 'DELETE') return
		if (originAllowed(request.headers.origin, allowed)) return
		const authorization = request.headers.authorization
		if (typeof authorization === 'string' && /^Bearer [A-Za-z0-9_-]{32,128}$/.test(authorization)) {
			const boardId = boardIdFromPath(request.url)
			if (boardId && bearerPermissions(request, boardId)) return
		}
		return reply.code(403).send({ error: 'Origin not allowed' })
	})

	app.addHook('preHandler', (request, reply, done) => {
		if (request.url.split('?')[0].startsWith('/api/')) reply.header('Cache-Control', 'no-store')
		reply
			.header('Content-Security-Policy', "frame-ancestors 'none'")
			.header('Referrer-Policy', 'no-referrer')
			.header('X-Content-Type-Options', 'nosniff')
			.header('X-Frame-Options', 'DENY')
		if (requestIsSecure(request)) reply.header('Strict-Transport-Security', 'max-age=31536000')
		done()
	})

	app.get('/api/health', async () => ({ ok: true, service: 'collaborative-ai-canvas' }))

	app.get('/api/auth/me', async (request, reply) => {
		const session = currentSession(request)
		if (!session) return reply.code(401).send({ error: 'Authentication required' })
		return { user: session.user, session: session.session }
	})

	app.post('/api/auth/register', async (request, reply) => {
		if (!registerLimiter.allow(clientAddress(request))) return reply.code(429).send({ error: 'Too many registration attempts. Try again later.' })
		const input = registerSchema.parse(request.body)
		const grant = await authService.register(input)
		setSessionCookie(reply, request, grant.token, grant.session.expiresAt)
		let legacyAdoptionError: string | undefined
		if (grant.user.isAdmin) legacyAdoptionError = await adoptLegacyBoardsForAdmin(grant.user.id)
		return {
			user: grant.user,
			session: grant.session,
			...(legacyAdoptionError ? { legacyAdoptionError } : {}),
		}
	})

	app.post('/api/auth/login', async (request, reply) => {
		const input = loginSchema.parse(request.body)
		const key = `${input.login.normalize('NFKC').trim().toLocaleLowerCase('en-US')}:${clientAddress(request)}`
		if (!loginLimiter.allow(key)) return reply.code(429).send({ error: 'Too many login attempts. Try again later.' })
		const grant = await authService.login(input)
		if (grant.user.isAdmin) {
			const legacyAdoptionError = await adoptLegacyBoardsForAdmin(grant.user.id)
			if (legacyAdoptionError) request.log.warn({ error: legacyAdoptionError }, 'failed to adopt legacy rooms on login')
		}
		setSessionCookie(reply, request, grant.token, grant.session.expiresAt)
		return { user: grant.user, session: grant.session }
	})

	app.post('/api/auth/logout', async (request, reply) => {
		const token = readCookie(request.headers.cookie)
		const session = token ? authService.getCurrentSession(token) : null
		if (token) authService.logout(token)
		if (session) closeUserSessions(session.user.id)
		reply.header('Set-Cookie', expiredSessionCookie(requestIsSecure(request)))
		return { ok: true }
	})

	app.put('/api/auth/settings', async (request, reply) => {
		const session = currentSession(request)
		if (!session) return reply.code(401).send({ error: 'Authentication required' })
		const body = settingsSchema.parse(request.body)
		const user = authService.updateSettings(session.user.id, body.settings)
		return { user }
	})

	app.get('/api/boards', async (request, reply) => {
		const session = currentSession(request)
		if (!session) return reply.code(401).send({ error: 'Authentication required' })
		const includeDeleted = (request.query as { includeDeleted?: string }).includeDeleted === 'true'
		return { boards: authService.listBoards(session.user.id, includeDeleted) }
	})

	app.post('/api/boards', async (request, reply) => {
		const session = currentSession(request)
		if (!session) return reply.code(401).send({ error: 'Authentication required' })
		const body = createBoardSchema.parse(request.body)
		const board = authService.createBoard(session.user.id, body.name, body.id)
		return { board }
	})

	app.get('/api/boards/:boardId', async (request, reply) => {
		const session = currentSession(request)
		if (!session) return reply.code(401).send({ error: 'Authentication required' })
		const board = authService.getBoard(session.user.id, (request.params as { boardId: string }).boardId)
		if (!board) return reply.code(404).send({ error: 'Board not found' })
		return { board }
	})

	app.patch('/api/boards/:boardId', async (request, reply) => {
		const session = currentSession(request)
		if (!session) return reply.code(401).send({ error: 'Authentication required' })
		const body = renameBoardSchema.parse(request.body)
		const board = authService.renameBoard(session.user.id, (request.params as { boardId: string }).boardId, body.name)
		return { board }
	})

	app.delete('/api/boards/:boardId', async (request, reply) => {
		const session = currentSession(request)
		if (!session) return reply.code(401).send({ error: 'Authentication required' })
		const boardId = (request.params as { boardId: string }).boardId
		const board = authService.deleteBoard(session.user.id, boardId)
		closeBoardSessions(boardId)
		return { board }
	})

	app.post('/api/boards/:boardId/restore', async (request, reply) => {
		const boardId = parseRoomId((request.params as { boardId: string }).boardId)
		if (!boardId) return reply.code(400).send({ error: 'Invalid board ID' })
		const body = request.body as Record<string, unknown> | undefined
		if (body && typeof body === 'object' && ('eventId' in body || 'checkpointId' in body || 'timestamp' in body)) {
			const parsed = historyRestoreSchema.parse(body)
			const access = resolveBoardAccess(request, boardId)
			const allowed = access.kind === 'token'
				? access.permissions.has('restore')
				: access.kind === 'user' && userRoleHasWrite(access.role)
			if (!allowed) return denyAccess(reply, access)
			if (!snapshotLimiter.allow(accessRateKey(access, 'restore', boardId))) return tooManyRequests(reply, 'restore requests')
			const actor = historyActor(access)
			const handle = getRoomHandle(boardId)
			return restoreRoomVersion(handle, {
				eventId: parsed.eventId,
				expectedClock: parsed.expectedClock,
				userId: access.kind === 'user' ? access.userId : '',
				displayName: actor.displayName,
				actorUserId: actor.actorUserId,
				source: access.kind === 'token' ? 'ai' : 'human',
				sessionId: null,
			})
		}
		const session = currentSession(request)
		if (!session) return reply.code(401).send({ error: 'Authentication required' })
		const board = authService.restoreBoard(session.user.id, boardId)
		return { board }
	})

	app.get('/api/boards/:boardId/members', async (request, reply) => {
		const session = currentSession(request)
		if (!session) return reply.code(401).send({ error: 'Authentication required' })
		const members = authService.listBoardMembers(session.user.id, (request.params as { boardId: string }).boardId).map((member) => ({
			...member,
			displayName: authService.database.getUserById(member.userId)?.displayName ?? null,
		}))
		return { members }
	})

	app.put('/api/boards/:boardId/members/:userId', async (request, reply) => {
		const session = currentSession(request)
		if (!session) return reply.code(401).send({ error: 'Authentication required' })
		const params = request.params as { boardId: string; userId: string }
		const body = memberRoleSchema.parse(request.body)
		const member = authService.setBoardMemberRole(session.user.id, params.boardId, params.userId, body.role)
		closeUserRoomSessions(params.boardId, params.userId)
		return member ? { member } : { ok: true }
	})

	app.post('/api/invitations', async (request, reply) => {
		const session = currentSession(request)
		if (!session) return reply.code(401).send({ error: 'Authentication required' })
		if (!invitationLimiter.allow(`user:${session.user.id}`)) return tooManyRequests(reply, 'invitation requests')
		const body = createInvitationSchema.parse(request.body)
		const grant = authService.createInvitation(session.user.id, {
			boardId: body.boardId,
			role: body.role,
			invitedLogin: body.invitedLogin,
			expiresInMs: body.expiresInMs,
		})
		return { invitation: grant.invitation, token: grant.token }
	})

	app.post('/api/invitations/consume', async (request, reply) => {
		const session = currentSession(request)
		if (!session) return reply.code(401).send({ error: 'Authentication required' })
		const body = invitationTokenSchema.parse(request.body)
		const invitation = authService.consumeInvitation(session.user.id, body.token)
		if (invitation.boardId) closeUserRoomSessions(invitation.boardId, session.user.id)
		return { invitation }
	})

	app.post('/api/invitations/revoke', async (request, reply) => {
		const session = currentSession(request)
		if (!session) return reply.code(401).send({ error: 'Authentication required' })
		const body = invitationTokenSchema.parse(request.body)
		const revoked = authService.revokeInvitation(session.user.id, body.token)
		return { revoked }
	})

	app.get('/api/connect/:roomId', { websocket: true }, (socket: WebSocket, request: FastifyRequest) => {
		const refuse = (code: number, reason: string) => {
			try { socket.close(code, reason) } catch { socket.terminate?.() }
		}
		try {
			const roomId = parseRoomId((request.params as { roomId: string }).roomId)
			if (!roomId) return refuse(1008, 'Invalid room ID')
			const sessionId = (request.query as { sessionId?: string }).sessionId
			if (!sessionId) return refuse(1008, 'Missing sessionId')
			const token = readCookie(request.headers.cookie)
			if (!token) return refuse(1008, 'Authentication required')
			const current = authService.getCurrentSession(token)
			if (!current) return refuse(1008, 'Authentication required')
			if (!originAllowed(request.headers.origin, allowed)) {
				return refuse(1008, 'Origin not allowed')
			}
			const role = authService.getBoardRole(current.user.id, roomId, false)
			if (!role) return refuse(1008, 'Not found')
			const handle = getRoomHandle(roomId)
			const caughtMessages: RawData[] = []
			const collect = (message: RawData) => caughtMessages.push(message)
			socket.on('message', collect)
			connectRoomSocket(handle, {
				sessionId,
				socket,
				userId: current.user.id,
				displayName: current.user.displayName,
				role,
				expiresAt: Date.parse(current.session.expiresAt),
			})
			socket.off('message', collect)
			for (const message of caughtMessages) socket.emit('message', message)
		} catch (error) {
			request.log.warn({ error }, 'websocket connection rejected')
			refuse(1008, 'Connection refused')
		}
	})

	app.get('/api/rooms/:roomId/canvas', async (request, reply) => {
		const roomId = parseRoomId((request.params as { roomId: string }).roomId)
		if (!roomId) return reply.code(400).send({ error: 'Invalid room ID' })
		const access = resolveBoardAccess(request, roomId)
		if (access.kind === 'token') {
			if (!access.permissions.has('read')) return denyAccess(reply, access)
		} else if (access.kind !== 'user') {
			return denyAccess(reply, access)
		}
		const pageId = (request.query as { pageId?: string }).pageId
		reply.header('Cache-Control', 'no-store')
		return { roomId, ...readRoomCanvas(getRoomHandle(roomId).room, pageId) }
	})

	app.post('/api/rooms/:roomId/actions', async (request, reply) => {
		const roomId = parseRoomId((request.params as { roomId: string }).roomId)
		if (!roomId) return reply.code(400).send({ error: 'Invalid room ID' })
		const access = resolveBoardAccess(request, roomId)
		const allowed = access.kind === 'token'
			? access.permissions.has('write')
			: access.kind === 'user' && userRoleHasWrite(access.role)
		if (!allowed) return denyAccess(reply, access)
		if (!writeLimiter.allow(accessRateKey(access, 'actions', roomId))) return tooManyRequests(reply, 'canvas writes')
		const actor = historyActor(access)
		const handle = getRoomHandle(roomId)
		const result = withRoomHistory(handle, {
			actorUserId: actor.actorUserId,
			actorDisplayName: actor.displayName,
			sessionId: null,
			source: access.kind === 'token' ? 'ai' : 'human',
			immediate: true,
		}, () => applyRoomActions(handle.room, request.body, actor))
		reply.header('Cache-Control', 'no-store')
		return { roomId, ...result }
	})

	app.get('/api/rooms/:roomId/semantic-context', async (request, reply) => {
		const roomId = parseRoomId((request.params as { roomId: string }).roomId)
		if (!roomId) return reply.code(400).send({ error: 'Invalid room ID' })
		const access = resolveBoardAccess(request, roomId)
		if (access.kind === 'token') {
			if (!access.permissions.has('read')) return denyAccess(reply, access)
		} else if (access.kind !== 'user') {
			return denyAccess(reply, access)
		}
		const query = request.query as Record<string, string | undefined>
		const filters = {
			entityTypes: query.entityTypes ? query.entityTypes.split(',').filter(Boolean) : undefined,
			status: query.status ? query.status.split(',').filter(Boolean) : undefined,
			ids: query.ids ? query.ids.split(',').filter(Boolean) : undefined,
			relationsFor: query.relationsFor || undefined,
			includeArchived: query.includeArchived === 'true' ? true : undefined,
		}
		reply.header('Cache-Control', 'no-store')
		return { roomId, ...readRoomSemantics(getRoomHandle(roomId).room, filters) }
	})

	app.post('/api/rooms/:roomId/ai/events', async (request, reply) => {
		const roomId = parseRoomId((request.params as { roomId: string }).roomId)
		if (!roomId) return reply.code(400).send({ error: 'Invalid room ID' })
		const access = resolveBoardAccess(request, roomId)
		const allowed = access.kind === 'token'
			? access.permissions.has('write')
			: access.kind === 'user' && userRoleHasWrite(access.role)
		if (!allowed) return denyAccess(reply, access)
		if (!writeLimiter.allow(accessRateKey(access, 'ai-events', roomId))) return tooManyRequests(reply, 'AI events')
		const body = aiEventSchema.parse(request.body)
		const metadata = sanitizeAiMetadata(body.metadata)
		if (Buffer.byteLength(JSON.stringify(metadata), 'utf8') > 4_096) {
			throw new HttpError(422, 'AI event metadata is too large')
		}
		const actor = historyActor(access)
		const handle = getRoomHandle(roomId)
		const event = appendRoomEvent(handle, {
			actorUserId: actor.actorUserId,
			eventType: body.eventType,
			entityType: 'board',
			entityId: roomId,
			source: 'ai',
			metadata: { actorDisplayName: actor.displayName, ...metadata },
		})
		return { event }
	})

	app.get('/api/boards/:boardId/history', async (request, reply) => {
		const boardId = parseRoomId((request.params as { boardId: string }).boardId)
		if (!boardId) return reply.code(400).send({ error: 'Invalid board ID' })
		const access = resolveBoardAccess(request, boardId)
		if (!requireHistoryView(access)) return denyAccess(reply, access)
		const query = request.query as Record<string, string | undefined>
		const filters: HistoryEventFilters = {}
		if (query.userId) filters.userId = query.userId
		if (query.source) filters.source = query.source.split(',').filter((value): value is HistorySource =>
			value === 'human' || value === 'ai' || value === 'system')
		if (query.eventType) filters.eventType = query.eventType.split(',').filter(Boolean) as HistoryEventType[]
		if (query.entityType) filters.entityType = query.entityType
		if (query.entityId) filters.entityId = query.entityId
		const from = parseHistoryFilterNumber(query.from)
		if (from === null) return reply.code(400).send({ error: 'Invalid history filter' })
		if (from !== undefined) filters.from = from
		const to = parseHistoryFilterNumber(query.to)
		if (to === null) return reply.code(400).send({ error: 'Invalid history filter' })
		if (to !== undefined) filters.to = to
		const after = parseHistoryFilterNumber(query.after)
		if (after === null) return reply.code(400).send({ error: 'Invalid history filter' })
		if (after !== undefined) filters.after = after
		const before = parseHistoryFilterNumber(query.before)
		if (before === null) return reply.code(400).send({ error: 'Invalid history filter' })
		if (before !== undefined) filters.before = before
		if (query.order === 'asc' || query.order === 'desc') filters.order = query.order
		const limit = parseHistoryFilterNumber(query.limit)
		if (limit === null) return reply.code(400).send({ error: 'Invalid history filter' })
		if (limit !== undefined) filters.limit = limit
		const handle = getRoomHandle(boardId)
		const page = handle.history.listEvents(filters)
		return { events: page.events, nextCursor: page.nextCursor, actors: resolveActors(page.events) }
	})

	app.get('/api/boards/:boardId/history/:eventId/snapshot', async (request, reply) => {
		const boardId = parseRoomId((request.params as { boardId: string }).boardId)
		if (!boardId) return reply.code(400).send({ error: 'Invalid board ID' })
		const access = resolveBoardAccess(request, boardId)
		if (!requireHistoryView(access)) return denyAccess(reply, access)
		const eventId = Number((request.params as { eventId: string }).eventId)
		if (!Number.isSafeInteger(eventId) || eventId < 1) return reply.code(400).send({ error: 'Invalid event ID' })
		const handle = getRoomHandle(boardId)
		const event = handle.history.getEvent(eventId)
		if (!event) return reply.code(404).send({ error: 'History event not found' })
		const reconstructed = handle.history.reconstruct({ eventId })
		return { event, snapshot: reconstructed.snapshot }
	})

	app.get('/api/boards/:boardId/checkpoints', async (request, reply) => {
		const boardId = parseRoomId((request.params as { boardId: string }).boardId)
		if (!boardId) return reply.code(400).send({ error: 'Invalid board ID' })
		const access = resolveBoardAccess(request, boardId)
		if (!requireHistoryView(access)) return denyAccess(reply, access)
		const rawLimit = (request.query as { limit?: string }).limit
		const limit = rawLimit === undefined ? undefined : Number(rawLimit)
		if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) return reply.code(400).send({ error: 'Invalid limit' })
		const handle = getRoomHandle(boardId)
		return { checkpoints: handle.history.listCheckpoints(limit) }
	})

	app.post('/api/boards/:boardId/checkpoints', async (request, reply) => {
		const boardId = parseRoomId((request.params as { boardId: string }).boardId)
		if (!boardId) return reply.code(400).send({ error: 'Invalid board ID' })
		const access = resolveBoardAccess(request, boardId)
		const allowed = access.kind === 'token'
			? access.permissions.has('history') && access.permissions.has('write')
			: access.kind === 'user' && userRoleHasWrite(access.role)
		if (!allowed) return denyAccess(reply, access)
		if (!snapshotLimiter.allow(accessRateKey(access, 'checkpoints', boardId))) return tooManyRequests(reply, 'checkpoint requests')
		const body = checkpointCreateSchema.parse(request.body)
		const actor = historyActor(access)
		const handle = getRoomHandle(boardId)
		const checkpoint = createRoomCheckpoint(handle, {
			userId: access.kind === 'user' ? access.userId : '',
			displayName: actor.displayName,
			actorUserId: actor.actorUserId,
			source: access.kind === 'token' ? 'ai' : 'human',
		}, body.label)
		return { checkpoint }
	})

	app.post('/api/boards/:boardId/uploads/:uploadId', async (request, reply) => {
		const session = currentSession(request)
		if (!session) return reply.code(401).send({ error: 'Authentication required' })
		const params = request.params as { boardId: string; uploadId: string }
		if (!/^[A-Za-z0-9._-]{1,180}$/.test(params.uploadId) || params.uploadId.includes('..') || !Buffer.isBuffer(request.body)) {
			return reply.code(400).send({ error: 'Invalid upload' })
		}
		const role = authService.getBoardRole(session.user.id, params.boardId, false)
		if (!role) return reply.code(404).send({ error: 'Board not found' })
		if (!userRoleHasWrite(role)) return reply.code(403).send({ error: 'You do not have permission to upload to this board' })
		if (!uploadLimiter.allow(`user:${session.user.id}:${params.boardId}`)) return tooManyRequests(reply, 'uploads')
		const path = join(assetDirectory, params.uploadId)
		if (existsSync(path)) return reply.code(409).send({ error: 'Upload already exists' })
		await import('node:fs/promises').then(({ writeFile }) => writeFile(path, request.body as Buffer, { flag: 'wx' }))
		authService.database.registerBoardAsset(params.boardId, params.uploadId)
		return { ok: true }
	})

	app.get('/api/boards/:boardId/assets/:uploadId', async (request, reply) => {
		const session = currentSession(request)
		if (!session) return reply.code(401).send({ error: 'Authentication required' })
		const params = request.params as { boardId: string; uploadId: string }
		if (!parseRoomId(params.boardId) || !/^[A-Za-z0-9._-]{1,180}$/.test(params.uploadId) || params.uploadId.includes('..')) {
			return reply.code(400).send({ error: 'Invalid asset ID' })
		}
		if (!authService.getBoardRole(session.user.id, params.boardId, false)) return reply.code(404).send({ error: 'Not found' })
		if (!authService.database.canReadAsset(session.user.id, params.uploadId)) return reply.code(404).send({ error: 'Not found' })
		const path = join(assetDirectory, params.uploadId)
		if (!existsSync(path)) return reply.code(404).send({ error: 'Not found' })
		reply.header('Content-Security-Policy', "default-src 'none'").header('X-Content-Type-Options', 'nosniff')
		return reply.send(createReadStream(path))
	})

	app.get('/api/unfurl', async () => ({ title: '', description: '', image: '', favicon: '' }))

	app.setErrorHandler((error, request, reply) => {
		if (error instanceof AuthError) return reply.code(error.statusCode).send({ error: error.message, code: error.code })
		if (error instanceof RoomRestoreError) return reply.code(error.statusCode).send({ error: error.message })
		if (error instanceof CanvasApiError) return reply.code(error.statusCode).send({ error: error.message })
		if (error instanceof HttpError) return reply.code(error.statusCode).send({ error: error.message })
		if (error instanceof ZodError) return reply.code(422).send({
			error: 'Invalid request',
			details: error.issues.map(({ path, message }) => ({ path, message })),
		})
		request.log.error(error)
		return reply.code(500).send({ error: 'Internal server error' })
	})

	const staticActive = serveClient && existsSync(clientDirectory)
	if (staticActive) {
		await app.register(fastifyStatic, { root: clientDirectory, wildcard: false })
	} else if (serveClient) {
		app.log.warn({ clientDirectory }, 'clientDirectory does not exist; SPA static serving disabled')
	}

	app.setNotFoundHandler((request, reply) => {
		if (request.url.split('?')[0].startsWith('/api/')) {
			reply.header('Cache-Control', 'no-store')
			return reply.code(404).send({ error: 'Not found' })
		}
		if (staticActive) return reply.sendFile('index.html')
		return reply.code(404).send({ error: 'Not found' })
	})

	let closed = false
	app.addHook('onClose', async () => {
		if (closed) return
		closed = true
		closeAllRooms()
		configureRoomAuditReader(null)
		authService.close()
	})

	return app
}
