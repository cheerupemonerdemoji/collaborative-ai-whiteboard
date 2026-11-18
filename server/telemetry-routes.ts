import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { TELEMETRY_SOURCE_ID } from '../shared/telemetry'
import type { CurrentSession } from './auth'
import type { BoardRole } from './auth-db'
import type { SlidingWindowRateLimiter } from './security'
import type { TelemetryRegistry } from './telemetry'

export interface TelemetryRouteDeps {
	/** Browser session cookie only. A machine bearer token never reaches these routes, and they are not on the machine hostname's allowlist. */
	currentSession(request: FastifyRequest): CurrentSession | null
	boardRole(userId: string, boardId: string): BoardRole | null
	registry: TelemetryRegistry
	readLimiter: SlidingWindowRateLimiter
}

/**
 * Read-only telemetry for people on a board. Any member may read, a viewer included, because nothing here can change a
 * machine or the board. A source answers only on the boards it is bound to: an unknown source and a source bound to a
 * different board produce the identical 404, so the route cannot be used to discover which sources exist.
 */
export function registerTelemetryRoutes(app: FastifyInstance, deps: TelemetryRouteDeps): void {
	function authorize(request: FastifyRequest, reply: FastifyReply): { boardId: string; userId: string } | null {
		const session = deps.currentSession(request)
		if (!session) { void reply.code(401).send({ error: 'Authentication required' }); return null }
		const boardId = (request.params as { boardId: string }).boardId
		if (!/^[A-Za-z0-9_-]{1,80}$/.test(boardId)) { void reply.code(400).send({ error: 'Invalid board ID' }); return null }
		if (!deps.boardRole(session.user.id, boardId)) { void reply.code(404).send({ error: 'Board not found' }); return null }
		if (!deps.readLimiter.allow(`user:${session.user.id}:telemetry:${boardId}`)) { void reply.code(429).send({ error: 'Too many telemetry requests. Try again later.' }); return null }
		return { boardId, userId: session.user.id }
	}

	app.get('/api/boards/:boardId/telemetry', async (request, reply) => {
		const auth = authorize(request, reply)
		if (!auth) return reply
		reply.header('Cache-Control', 'no-store')
		return { sources: deps.registry.listForBoard(auth.boardId) }
	})

	app.get('/api/boards/:boardId/telemetry/:sourceId', async (request, reply) => {
		const auth = authorize(request, reply)
		if (!auth) return reply
		const { sourceId } = request.params as { sourceId: string }
		const reader = TELEMETRY_SOURCE_ID.test(sourceId) ? deps.registry.forBoard(auth.boardId, sourceId) : null
		if (!reader) return reply.code(404).send({ error: 'Telemetry source not found' })
		await reader.ensureCurrent()
		reply.header('Cache-Control', 'no-store')
		return reader.view()
	})
}
