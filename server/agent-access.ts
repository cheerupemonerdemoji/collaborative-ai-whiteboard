import { randomBytes } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import {
	ACCESS_MODES,
	BOARD_CREATE_PERMISSION,
	TokenStoreError,
	createAccountClient,
	createClient,
	describeClients,
	isValidClientName,
	isValidRoomId,
	revokeClient,
	rotateClient,
	type AccessMode,
	type ClientDetail,
	type ExpiryStatus,
	type Permission,
	type StoredClient,
} from './token-store.mjs'

/**
 * Owner-only management of machine ("agent") tokens, over the human session.
 *
 *   GET    /api/agent-access?boardId=ID      list the agents that can reach a board
 *   POST   /api/agent-access                 create one (body: boardId, displayName, access, expiresAt?)
 *   POST   /api/agent-access/:ref/rotate     replace one's bearer token (body: expiresAt?)
 *   DELETE /api/agent-access/:ref            revoke one
 *
 * Why this path, and not /api/boards/:id/agents. The server skips the Origin requirement for a request that
 * carries a valid bearer for the board named in a /api/boards/<id>/... or /api/rooms/<id>/... URL (that is how
 * agents call the board APIs without a browser). Mounting management under such a path would put these cookie
 * routes inside that exemption. Nothing here reads a bearer, so it could not be used to authorise anything, but
 * a structural guarantee beats a reasoned one: /api/agent-access matches neither prefix, so the Origin check
 * always applies, and the board is named in the body or query instead. A test pins this.
 *
 * Board-creating agents. POST with kind "board-creator" (and no board) registers a credential that can later
 * create new boards owned by the caller through POST /api/agent-boards. It is stored in the token file's separate
 * accountClients collection, starts with no boards, and gives no access to any existing board. GET
 * ?scope=creators lists the caller's own. Because such a credential can hold zero boards, "the caller owns every
 * board it can reach" is vacuously true for anyone, so the rule for these is stricter: the caller must BE the
 * credential's ownerUserId, as well as owning each board it holds.
 *
 * Every mutation goes through server/token-store.mjs, the same lock + backup + atomic-replace path the operator
 * CLI uses. There is deliberately no second writer.
 *
 * Authorization, in order, for every route:
 *   1. a signed-in human session. Only the session cookie is consulted; a machine bearer token is never read,
 *      so an agent cannot mint, list, rotate or revoke agents (including itself);
 *   2. a per-user request budget;
 *   3. ownership. For list and create, the caller owns the board named. For rotate and revoke, the caller owns
 *      EVERY board the agent can reach. A nonmember gets the same 404 as a board that does not exist.
 *
 * An agent is addressed by `ref` = `<name>.<fingerprint>`. A client name is reusable (revoke one and an
 * administrator can register another under the same name), so name alone could aim an action at the wrong
 * credential. The fingerprint pins the exact credential that was listed; if it has changed, the answer is 409 and
 * nothing is touched. Rotate and revoke make their ownership decision inside the token-store mutation lock, on the
 * freshly read record, so the record that is authorised is the record that is changed.
 *
 * Scope rules that keep one owner from affecting another:
 *   - a token created here covers exactly the one board named, with a server-generated name;
 *   - an agent is listed on a board only if its token includes that board, and the listing shows only the boards
 *     the caller owns (it says whether others exist, never which);
 *   - an agent that also reaches someone else's board is not the caller's to rotate or revoke. They get 403 when
 *     they own part of it (they can see it in their listing) and 404 when they own none of it.
 *
 * These routes are not in the machine-host allowlist (server/host-policy.ts), so on the machine hostname they are
 * a 404, and on the browser hostname a request carrying an Authorization header is refused before it gets here.
 */

const NO_STORE = 'no-store'
const AGENT_NAME_BYTES = 6
const REFERENCE = /^([A-Za-z0-9_-]{1,64})\.([0-9a-f]{16})$/

const boardIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/)
const expiresAtSchema = z.string().max(40)

const createAgentSchema = z.object({
	boardId: boardIdSchema,
	displayName: z.string().trim().min(1).max(80),
	access: z.enum(Object.keys(ACCESS_MODES) as [AccessMode, ...AccessMode[]]),
	expiresAt: expiresAtSchema.optional(),
}).strict()

const createCreatorSchema = z.object({
	kind: z.literal('board-creator'),
	displayName: z.string().trim().min(1).max(80),
	access: z.enum(Object.keys(ACCESS_MODES) as [AccessMode, ...AccessMode[]]),
	expiresAt: expiresAtSchema.optional(),
}).strict()

const rotateAgentSchema = z.object({ expiresAt: expiresAtSchema.optional() }).strict()

export interface AgentAccessDependencies {
	/** The signed-in human for this request, or null. Must read the session cookie only, never a bearer. */
	currentUser(request: FastifyRequest): { id: string } | null
	/**
	 * The caller's role on a board, or null when they are not a member of it. Deleted boards read as null unless
	 * `includeDeleted` is set, which is how ownership of a board the caller has since deleted is still recognised.
	 */
	boardRole(userId: string, boardId: string, includeDeleted?: boolean): 'owner' | 'editor' | 'viewer' | null
	/** Appends to the account audit trail. Never given token material. */
	recordEvent(event: { type: string; actorUserId: string; boardId: string | null; metadata: Record<string, unknown> }): void
	/** Spends one request from the caller's budget; false means refuse with 429. */
	allow(userId: string): boolean
	/** The token file the reader uses, or undefined when machine tokens are not configured. */
	storePath(): string | undefined
}

/** What an owner is shown about an agent. Never the hash, never the token, never another owner's board ids. */
export interface AgentView {
	/** Pass this back to rotate or revoke. Changes when the token is rotated. */
	ref: string
	name: string
	displayName?: string
	permissions: Permission[]
	rooms: string[]
	sharedWithOtherBoards: boolean
	createdAt?: string
	rotatedAt?: string
	expiresAt?: string
	status: ExpiryStatus
	createdByYou: boolean
	/** Present (true) only for a board-creating credential. */
	canCreateBoards?: boolean
}

/** An authorisation outcome decided inside the store lock, carrying the HTTP answer. */
class AgentAccessError extends Error {
	constructor(readonly statusCode: 403 | 404, message: string) {
		super(message)
	}
}

const referenceFor = (name: string, fingerprint: string) => `${name}.${fingerprint}`

/** What a rotate or revoke learned, inside the lock, about the record it was authorised against. */
interface Seen {
	rooms: string[]
	displayName?: string
	creator?: boolean
}

/** A board-creating credential, as stored: it carries the account-level capability. */
function isBoardCreator(client: StoredClient): boolean {
	return Array.isArray(client.accountPermissions) && client.accountPermissions.includes(BOARD_CREATE_PERMISSION)
}

export function registerAgentAccessRoutes(app: FastifyInstance, deps: AgentAccessDependencies): void {
	/** Steps 1 and 2. On failure the response has been sent and null is returned. */
	function begin(request: FastifyRequest, reply: FastifyReply): string | null {
		reply.header('Cache-Control', NO_STORE)
		const user = deps.currentUser(request)
		if (!user) {
			reply.code(401).send({ error: 'Authentication required' })
			return null
		}
		if (!deps.allow(user.id)) {
			reply.code(429).send({ error: 'Too many agent access requests. Try again later.' })
			return null
		}
		return user.id
	}

	/** Step 3 for list and create: the caller owns the board named. */
	function requireBoardOwner(reply: FastifyReply, userId: string, boardId: string): boolean {
		const role = deps.boardRole(userId, boardId)
		if (!role) {
			reply.code(404).send({ error: 'Board not found' })
			return false
		}
		if (role !== 'owner') {
			reply.code(403).send({ error: 'Only the board owner can manage agents' })
			return false
		}
		return true
	}

	function requireStore(reply: FastifyReply): string | null {
		const file = deps.storePath()
		if (!file) {
			reply.code(503).send({ error: 'Agent access is not configured on this server' })
			return null
		}
		return file
	}

	function parseReference(reply: FastifyReply, value: string): { name: string; fingerprint: string } | null {
		const match = REFERENCE.exec(value)
		if (!match || !isValidClientName(match[1])) {
			reply.code(400).send({ error: 'Invalid agent reference' })
			return null
		}
		return { name: match[1], fingerprint: match[2] }
	}

	/** Boards (from `rooms`) that the caller owns, counting ones they have since deleted: a token is inert on a deleted board. */
	function ownedRooms(userId: string, rooms: readonly string[]): Set<string> {
		const owned = new Set<string>()
		for (const room of new Set(rooms)) if (deps.boardRole(userId, room, true) === 'owner') owned.add(room)
		return owned
	}

	/**
	 * The ownership rule for rotate and revoke. It is handed to the token store and runs INSIDE its mutation lock,
	 * against the record about to change, and writes down what that record was so the audit trail and the response
	 * describe the record that was actually authorised.
	 */
	function authoriseOwnership(userId: string, seen: Seen): (client: StoredClient) => void {
		return (client) => {
			const rooms = Array.isArray(client.rooms) ? [...new Set(client.rooms.filter((room): room is string => typeof room === 'string'))] : []
			const owned = ownedRooms(userId, rooms)
			if (isBoardCreator(client)) {
				// A creator may hold no boards, so owning "all" of them proves nothing: the caller must be its owner.
				if (client.ownerUserId !== userId) throw new AgentAccessError(404, 'Agent not found')
				if (owned.size < rooms.length) throw new AgentAccessError(403, 'This agent can also reach boards you do not own. Ask an administrator.')
				seen.creator = true
			} else {
				if (rooms.length === 0 || owned.size === 0) throw new AgentAccessError(404, 'Agent not found')
				if (owned.size < rooms.length) throw new AgentAccessError(403, 'This agent can also reach boards you do not own. Ask an administrator.')
			}
			seen.rooms = rooms
			if (typeof client.displayName === 'string') seen.displayName = client.displayName
		}
	}

	/** One audit row per board the agent reached; a creator with no boards still leaves exactly one (no board). */
	function auditEach(type: string, userId: string, seen: Seen, metadata: Record<string, unknown>) {
		const boards: Array<string | null> = seen.rooms.length > 0 ? seen.rooms : [null]
		for (const boardId of boards) deps.recordEvent({ type, actorUserId: userId, boardId, metadata })
	}

	function view(client: ClientDetail, userId: string, owned: Set<string>): AgentView {
		return {
			ref: referenceFor(client.name, client.fingerprint),
			name: client.name,
			...(client.accountPermissions?.includes(BOARD_CREATE_PERMISSION) ? { canCreateBoards: true as const } : {}),
			...(client.displayName === undefined ? {} : { displayName: client.displayName }),
			permissions: client.permissions,
			rooms: client.rooms.filter((room) => owned.has(room)),
			sharedWithOtherBoards: client.rooms.some((room) => !owned.has(room)),
			...(client.createdAt === undefined ? {} : { createdAt: client.createdAt }),
			...(client.rotatedAt === undefined ? {} : { rotatedAt: client.rotatedAt }),
			...(client.expiresAt === undefined ? {} : { expiresAt: client.expiresAt }),
			status: client.status,
			createdByYou: client.createdByUserId === userId,
		}
	}

	/** Maps coded failures to HTTP. Anything else is a genuine fault and is rethrown, so the log has it and the caller does not. */
	function failure(reply: FastifyReply, error: unknown): FastifyReply {
		if (error instanceof AgentAccessError) return reply.code(error.statusCode).send({ error: error.message })
		if (!(error instanceof TokenStoreError)) throw error
		switch (error.code) {
			case 'invalid-expiry':
			case 'invalid-display-name':
				return reply.code(422).send({ error: error.message })
			case 'store-full':
			case 'duplicate-name':
				return reply.code(409).send({ error: error.message })
			case 'stale-reference':
				return reply.code(409).send({ error: 'This agent changed after you loaded it. Reload the list and try again.' })
			case 'not-found':
				return reply.code(404).send({ error: 'Agent not found' })
			case 'locked':
				return reply.code(503).send({ error: 'Agent tokens are being changed by another operation. Try again in a moment.' })
			default:
				// invalid-store and anything unexpected: the message can name a file path, so it stays in the log.
				throw error
		}
	}

	app.get('/api/agent-access', async (request, reply) => {
		const userId = begin(request, reply)
		if (!userId) return reply
		const query = request.query as { boardId?: unknown; scope?: unknown }
		if (query.scope === 'creators') {
			// The caller's own board-creating credentials, including ones that hold no boards yet.
			const file = requireStore(reply)
			if (!file) return reply
			const mine = (await describeClients(file)).filter((client) => client.accountPermissions?.includes(BOARD_CREATE_PERMISSION) && client.ownerUserId === userId)
			const owned = ownedRooms(userId, mine.flatMap((client) => client.rooms))
			return { agents: mine.map((client) => view(client, userId, owned)) }
		}
		const boardId = query.boardId
		if (typeof boardId !== 'string' || !isValidRoomId(boardId)) return reply.code(400).send({ error: 'boardId is required' })
		if (!requireBoardOwner(reply, userId, boardId)) return reply
		const file = requireStore(reply)
		if (!file) return reply
		// A board-creating credential is shown only to its own owner, even where it holds one of their boards.
		const clients = (await describeClients(file)).filter(
			(client) => client.rooms.includes(boardId) && (!client.accountPermissions?.includes(BOARD_CREATE_PERMISSION) || client.ownerUserId === userId),
		)
		const owned = ownedRooms(userId, clients.flatMap((client) => client.rooms))
		return { agents: clients.map((client) => view(client, userId, owned)) }
	})

	app.post('/api/agent-access', async (request, reply) => {
		const userId = begin(request, reply)
		if (!userId) return reply
		if ((request.body as { kind?: unknown } | null)?.kind === 'board-creator') return createCreator(request, reply, userId)
		const body = createAgentSchema.parse(request.body)
		if (!requireBoardOwner(reply, userId, body.boardId)) return reply
		const file = requireStore(reply)
		if (!file) return reply
		let created
		try {
			created = await createWithGeneratedName(file, userId, body)
		} catch (error) {
			return failure(reply, error)
		}
		deps.recordEvent({
			type: 'agent.created',
			actorUserId: userId,
			boardId: body.boardId,
			metadata: { agent: created.name, fingerprint: created.fingerprint, displayName: body.displayName, access: body.access, ...(created.expiresAt === undefined ? {} : { expiresAt: created.expiresAt }) },
		})
		return reply.code(201).send({
			agent: {
				ref: referenceFor(created.name, created.fingerprint),
				name: created.name,
				displayName: body.displayName,
				permissions: created.permissions,
				rooms: [body.boardId],
				sharedWithOtherBoards: false,
				createdAt: created.createdAt,
				...(created.expiresAt === undefined ? {} : { expiresAt: created.expiresAt }),
				status: created.expiresAt === undefined ? 'none' : 'active',
				createdByYou: true,
			} satisfies AgentView,
			// The only time the bearer exists in plaintext. It is not stored, logged or audited.
			token: created.token,
		})
	})

	app.post('/api/agent-access/:ref/rotate', async (request, reply) => {
		const userId = begin(request, reply)
		if (!userId) return reply
		const target = parseReference(reply, (request.params as { ref: string }).ref)
		if (!target) return reply
		const body = rotateAgentSchema.parse(request.body ?? {})
		const file = requireStore(reply)
		if (!file) return reply
		const seen: Seen = { rooms: [] }
		let rotated
		try {
			rotated = await rotateClient({
				file,
				name: target.name,
				fingerprint: target.fingerprint,
				authorise: authoriseOwnership(userId, seen),
				...(body.expiresAt === undefined ? {} : { expiresAt: body.expiresAt }),
			})
		} catch (error) {
			return failure(reply, error)
		}
		auditEach('agent.rotated', userId, seen, { agent: target.name, previousFingerprint: target.fingerprint, fingerprint: rotated.fingerprint, ...(seen.creator ? { kind: 'board-creator' } : {}), ...(rotated.expiresAt === undefined ? {} : { expiresAt: rotated.expiresAt }) })
		return {
			agent: {
				ref: referenceFor(rotated.name, rotated.fingerprint),
				name: rotated.name,
				...(seen.creator ? { canCreateBoards: true as const } : {}),
				...(seen.displayName === undefined ? {} : { displayName: seen.displayName }),
				permissions: rotated.permissions,
				rooms: rotated.rooms,
				sharedWithOtherBoards: false,
				...(rotated.createdAt === undefined ? {} : { createdAt: rotated.createdAt }),
				rotatedAt: rotated.rotatedAt,
				...(rotated.expiresAt === undefined ? {} : { expiresAt: rotated.expiresAt }),
				status: rotated.expiresAt === undefined ? 'none' : 'active',
				createdByYou: false,
			} satisfies AgentView,
			// The only time the new bearer exists in plaintext. The old one is already dead.
			token: rotated.token,
		}
	})

	app.delete('/api/agent-access/:ref', async (request, reply) => {
		const userId = begin(request, reply)
		if (!userId) return reply
		const target = parseReference(reply, (request.params as { ref: string }).ref)
		if (!target) return reply
		const file = requireStore(reply)
		if (!file) return reply
		const seen: Seen = { rooms: [] }
		try {
			await revokeClient(file, target.name, { fingerprint: target.fingerprint, authorise: authoriseOwnership(userId, seen) })
		} catch (error) {
			return failure(reply, error)
		}
		auditEach('agent.revoked', userId, seen, { agent: target.name, fingerprint: target.fingerprint, ...(seen.creator ? { kind: 'board-creator' } : {}) })
		return { ok: true }
	})

	async function createCreator(request: FastifyRequest, reply: FastifyReply, userId: string) {
		const body = createCreatorSchema.parse(request.body)
		const file = requireStore(reply)
		if (!file) return reply
		let created
		try {
			created = await createWithGeneratedName(file, userId, body)
		} catch (error) {
			return failure(reply, error)
		}
		deps.recordEvent({
			type: 'agent.created',
			actorUserId: userId,
			boardId: null,
			metadata: { agent: created.name, kind: 'board-creator', fingerprint: created.fingerprint, displayName: body.displayName, access: body.access, ...(created.expiresAt === undefined ? {} : { expiresAt: created.expiresAt }) },
		})
		return reply.code(201).send({
			agent: {
				ref: referenceFor(created.name, created.fingerprint),
				name: created.name,
				canCreateBoards: true,
				displayName: body.displayName,
				permissions: created.permissions,
				rooms: [],
				sharedWithOtherBoards: false,
				createdAt: created.createdAt,
				...(created.expiresAt === undefined ? {} : { expiresAt: created.expiresAt }),
				status: created.expiresAt === undefined ? 'none' : 'active',
				createdByYou: true,
			} satisfies AgentView,
			// The only time the bearer exists in plaintext. It is not stored, logged or audited.
			token: created.token,
		})
	}

	/**
	 * Client names share one namespace with the CLI. If the owner chose them, a collision would tell one owner
	 * that a name exists on someone else's board. So the stored name is generated, and what the owner types is the
	 * display name. A collision on 48 random bits is retried once and is otherwise treated as a conflict.
	 */
	async function createWithGeneratedName(file: string, userId: string, body: z.infer<typeof createAgentSchema> | z.infer<typeof createCreatorSchema>) {
		for (let attempt = 0; ; attempt += 1) {
			try {
				const name = `agent-${randomBytes(AGENT_NAME_BYTES).toString('hex')}`
				const common = { file, name, access: body.access, displayName: body.displayName, createdByUserId: userId, ...(body.expiresAt === undefined ? {} : { expiresAt: body.expiresAt }) }
				if ('kind' in body) return await createAccountClient({ ...common, ownerUserId: userId })
				return await createClient({ ...common, rooms: [body.boardId] })
			} catch (error) {
				if (error instanceof TokenStoreError && error.code === 'duplicate-name' && attempt === 0) continue
				throw error
			}
		}
	}
}
