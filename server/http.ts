import type { FastifyReply, FastifyRequest } from 'fastify'
import { z, ZodError } from 'zod'
import { CanvasApiError } from './canvas-api'

export class HttpError extends Error {
	constructor(readonly statusCode: number, message: string) { super(message) }
}

export function parseBody<T>(schema: z.ZodType<T>, value: unknown): T {
	try { return schema.parse(value) }
	catch (error) { throw new HttpError(422, error instanceof ZodError ? 'Invalid request' : 'Invalid request') }
}

export function sendHttpError(request: FastifyRequest, reply: FastifyReply, error: unknown) {
	if (error instanceof HttpError) return reply.code(error.statusCode).send({ error: error.message })
	if (error instanceof CanvasApiError) return reply.code(error.statusCode).send({ error: error.message })
	if (error instanceof ZodError) return reply.code(422).send({ error: 'Invalid request', details: error.issues.map(({ path, message }) => ({ path, message })) })
	request.log.error(error)
	return reply.code(500).send({ error: 'Internal server error' })
}
