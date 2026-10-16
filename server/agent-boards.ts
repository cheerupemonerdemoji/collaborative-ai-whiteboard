import type { FastifyInstance, FastifyReply } from 'fastify'
import type { z } from 'zod'
import { AuthError } from './auth'
import { MAX_ROOMS_PER_CLIENT, TokenStoreError, grantNewBoard } from './token-store.mjs'
import type { BoardCreatorAuth } from './tokens'

/**
 * Machine board creation: `POST /api/agent-boards`.
 *
 * An AI agent holding a board-creating credential (a record in the token store's `accountClients`) can create a
 * new whiteboard owned by the human account the credential names, and is granted exactly that board. This is a
 * machine-only operation. It is served on the machine hostname behind Cloudflare Access (see host-policy.ts), the
 * browser hostname refuses every bearer, and the handler never looks at a session cookie, so a signed-in person's
 * cookie can never stand in for the machine credential. The human `POST /api/boards` stays cookie-only.
 *
 * Order of checks, cheapest and least revealing first: authenticate the bearer (401/403), validate the body
 * (422), refuse a credential already at its board cap before spending anything (409), spend the hourly budgets
 * (429), then the locked create-and-grant in token-store.mjs, which re-checks the cap and pins the exact
 * credential. Board first, then grant, with a soft-delete compensation if the grant cannot be persisted.
 *
 * The audit trail records the machine client as the actor (no actor user): the owner owns the board but did not
 * create it. Nothing here can see a bearer or a stored hash after authentication; only the client's name,
 * fingerprint and owner are used.
 */

export interface AgentBoardsDependencies {
	authenticate(header: string | undefined): BoardCreatorAuth
	/** The request body schema: strict, with a `name` and nothing else (the board id is never client-chosen). */
	bodySchema: z.ZodType<{ name: string }>
	/** Spends one creation from the credential's and the owner's hourly budgets, or says which refused. */
	spend(clientName: string, ownerUserId: string): 'ok' | 'credential-limit' | 'owner-limit'
	/** The same board-creation service the human API uses; the owner becomes the board's owner. */
	createBoard(ownerUserId: string, name: string, agentName: string): { id: string; name: string }
	/** Soft-deletes a board this request just created. There is no hard delete. */
	removeBoard(ownerUserId: string, boardId: string, agentName: string): void
	recordEvent(event: { type: string; actorUserId: string | null; boardId: string | null; metadata: Record<string, unknown> }): void
	storePath(): string | undefined
}

const NO_STORE = 'no-store'

function tooMany(reply: FastifyReply, message: string) {
	return reply.code(429).header('Retry-After', '3600').send({ error: message })
}

export function registerAgentBoardsRoutes(app: FastifyInstance, deps: AgentBoardsDependencies): void {
	app.post('/api/agent-boards', async (request, reply) => {
		reply.header('Cache-Control', NO_STORE)
		const creator = deps.authenticate(request.headers.authorization)
		if (creator.kind === 'unauthenticated') return reply.code(401).send({ error: 'Authentication required' })
		if (creator.kind === 'forbidden') return reply.code(403).send({ error: 'This credential cannot create boards' })

		const body = deps.bodySchema.parse(request.body)
		const file = deps.storePath()
		if (!file) return reply.code(503).send({ error: 'Board creation is not available' })

		// Refuse before spending any budget or creating anything. The authoritative check repeats inside the lock.
		if (creator.roomCount >= MAX_ROOMS_PER_CLIENT) {
			return reply.code(409).send({ error: `This credential already holds the maximum of ${MAX_ROOMS_PER_CLIENT} boards` })
		}
		const spent = deps.spend(creator.name, creator.ownerUserId)
		if (spent === 'credential-limit') return tooMany(reply, 'This credential has created too many boards recently. Try again later.')
		if (spent === 'owner-limit') return tooMany(reply, 'Too many boards have been created for this account recently. Try again later.')

		let created: { id: string; name: string } | undefined
		try {
			const granted = await grantNewBoard({
				file,
				name: creator.name,
				fingerprint: creator.fingerprint,
				// The owner comes from the freshly read, locked record, not from the earlier authentication.
				prepare: (client) => {
					created = deps.createBoard(String(client.ownerUserId), body.name, creator.name)
					return created.id
				},
				rollback: (boardId) => deps.removeBoard(creator.ownerUserId, boardId, creator.name),
			})
			if (!created || created.id !== granted.boardId) throw new Error('Board creation returned an unexpected result')
			try {
				deps.recordEvent({
					type: 'agent.board_created',
					actorUserId: null,
					boardId: created.id,
					metadata: { actorKind: 'agent', agentName: creator.name, ownerUserId: creator.ownerUserId, boardId: created.id, name: created.name },
				})
			} catch (error) {
				// The board exists and the grant is persisted, so the agent must be told. Losing the audit row is loud, not fatal.
				request.log.error({ err: error, boardId: created.id, agentName: creator.name }, 'agent.board_created audit row was not written')
			}
			return reply.code(201).send({ boardId: created.id, name: created.name, url: `/room/${created.id}` })
		} catch (error) {
			if (error instanceof AuthError && (error.code === 'account_disabled' || error.code === 'user_not_found')) {
				return reply.code(403).send({ error: 'The account that owns this credential is not available' })
			}
			if (error instanceof TokenStoreError) {
				switch (error.code) {
					case 'locked':
						return reply.code(503).header('Retry-After', '2').send({ error: 'Board creation is busy. Try again shortly.' })
					case 'room-limit':
						return reply.code(409).send({ error: `This credential already holds the maximum of ${MAX_ROOMS_PER_CLIENT} boards` })
					case 'not-found':
					case 'stale-reference':
					case 'expired':
						return reply.code(401).send({ error: 'Authentication required' })
					case 'no-capability':
						return reply.code(403).send({ error: 'This credential cannot create boards' })
					case 'rollback-failed':
						request.log.error({ boardId: error.boardId, agentName: creator.name }, 'new board could not be removed after the grant failed')
						return reply.code(500).send({ error: 'Internal server error' })
					default:
						break
				}
			}
			if (created) {
				try {
					deps.recordEvent({
						type: 'agent.board_creation_rolled_back',
						actorUserId: null,
						boardId: created.id,
						metadata: { actorKind: 'agent', agentName: creator.name, ownerUserId: creator.ownerUserId, boardId: created.id, name: created.name },
					})
				} catch (auditError) {
					request.log.error({ err: auditError, boardId: created.id }, 'rollback audit row was not written')
				}
			}
			throw error
		}
	})
}
