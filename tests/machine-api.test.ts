import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import type { AccessVerifier } from '../server/access-jwt'
import { buildApp, type BuildAppOptions } from '../server/app'
import { createHostPolicy, isMachineRoute, MACHINE_ROUTES, normalizeHost } from '../server/host-policy'

const MACHINE_HOST = 'whiteboard-api.example.test'
const HUMAN_HOST = 'whiteboard.example.test'
const VALID_ASSERTION = 'valid-access-assertion'
/** One of the origins the app allows by default; browser mutations on any hostname must carry an allowed origin. */
const ALLOWED_ORIGIN = 'http://127.0.0.1:8787'

/** Stands in for the Cloudflare Access signature check (covered separately in access-jwt.test.ts). */
const accessVerifier: AccessVerifier = {
	async verify(assertion) { return assertion === VALID_ASSERTION ? { ok: true, clientId: 'test-service-token' } : { ok: false, reason: 'invalid' } },
}

const previousTokenFile = process.env.CANVAS_API_TOKENS_FILE
const cleanup: string[] = []
const apps: FastifyInstance[] = []

afterEach(async () => {
	for (const app of apps.splice(0)) { try { await app.close() } catch { /* already closed */ } }
	for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true })
	if (previousTokenFile === undefined) delete process.env.CANVAS_API_TOKENS_FILE
	else process.env.CANVAS_API_TOKENS_FILE = previousTokenFile
})

const tokens = {
	readerA: 'r'.repeat(43), writerA: 'w'.repeat(43), historyA: 'h'.repeat(43), fullA: 'f'.repeat(43), readerB: 'b'.repeat(43),
}
const digest = (token: string) => createHash('sha256').update(token).digest('hex')

function writeTokenFile(file: string, omit: string[] = []) {
	const clients = [
		{ name: 'reader-a', tokenHash: digest(tokens.readerA), rooms: ['board-a'], permissions: ['read'] },
		{ name: 'writer-a', tokenHash: digest(tokens.writerA), rooms: ['board-a'], permissions: ['read', 'write'] },
		{ name: 'history-a', tokenHash: digest(tokens.historyA), rooms: ['board-a'], permissions: ['read', 'history'] },
		{ name: 'full-a', tokenHash: digest(tokens.fullA), rooms: ['board-a'], permissions: ['read', 'write', 'history', 'restore'] },
		{ name: 'reader-b', tokenHash: digest(tokens.readerB), rooms: ['board-b'], permissions: ['read', 'write'] },
	].filter((client) => !omit.includes(client.name))
	writeFileSync(file, JSON.stringify({ clients }))
}

async function setup(options: Partial<BuildAppOptions> = {}) {
	const directory = mkdtempSync(join(tmpdir(), 'machine-api-test-'))
	cleanup.push(directory)
	const tokenFile = join(directory, 'api-tokens.json')
	writeTokenFile(tokenFile)
	process.env.CANVAS_API_TOKENS_FILE = tokenFile
	mkdirSync(join(directory, 'client'), { recursive: true })
	writeFileSync(join(directory, 'client', 'index.html'), '<!doctype html><html><body>SPA-SHELL</body></html>')
	writeFileSync(join(directory, 'client', 'app.js'), 'console.log("bundle")')
	const app = await buildApp({
		dataDirectory: directory, clientDirectory: join(directory, 'client'), logger: false,
		hostPolicy: { publicHost: HUMAN_HOST, machineHost: MACHINE_HOST, accessVerifier },
		...options,
	})
	apps.push(app)

	const register = await app.inject({ method: 'POST', url: '/api/auth/register', headers: { host: HUMAN_HOST, origin: ALLOWED_ORIGIN }, payload: { login: 'owner', displayName: 'Board Owner', password: 'correct horse battery staple' } })
	expect(register.statusCode).toBe(200)
	const cookie = `${register.cookies[0].name}=${register.cookies[0].value}`
	for (const id of ['board-a', 'board-b']) {
		const created = await app.inject({ method: 'POST', url: '/api/boards', headers: { host: HUMAN_HOST, origin: ALLOWED_ORIGIN, cookie }, payload: { name: id, id } })
		expect(created.statusCode).toBe(200)
	}
	return { app, directory, tokenFile, cookie }
}

type Ctx = Awaited<ReturnType<typeof setup>>
const machine = (token?: string, extra: Record<string, string> = {}) => ({
	host: MACHINE_HOST, 'cf-access-jwt-assertion': VALID_ASSERTION, ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra,
})
const createTask = (id: string) => ({ actions: [{ tool: 'create_entity', id: `engineering_entity:${id}`, entityType: 'task', title: `Task ${id}` }] })

describe('machine hostname: the Cloudflare Access layer', () => {
	it('refuses every request that carries no valid Access assertion, before any route runs', async () => {
		const { app } = await setup()
		for (const headers of [{ host: MACHINE_HOST }, { host: MACHINE_HOST, 'cf-access-jwt-assertion': 'forged' }, { host: MACHINE_HOST, authorization: `Bearer ${tokens.fullA}` }]) {
			for (const url of ['/api/health', '/api/rooms/board-a/semantic-context', '/', '/login', '/api/auth/me', '/nope']) {
				const response = await app.inject({ method: 'GET', url, headers })
				expect(response.statusCode, url).toBe(403)
				expect(response.headers['content-type']).toContain('application/json')
				expect(response.body).not.toContain('SPA-SHELL')
			}
		}
	})

	it('a valid Access assertion alone is not enough: the whiteboard token is still required', async () => {
		const { app } = await setup()
		expect((await app.inject({ method: 'GET', url: '/api/health', headers: machine() })).statusCode).toBe(200)
		for (const url of ['/api/rooms/board-a/semantic-context', '/api/rooms/board-a/canvas', '/api/boards/board-a/history', '/api/boards/board-a/checkpoints']) {
			expect((await app.inject({ method: 'GET', url, headers: machine() })).statusCode, url).toBe(401)
			expect((await app.inject({ method: 'GET', url, headers: machine('x'.repeat(43)) })).statusCode, url).toBe(401)
		}
		// Mutations without a valid bearer are stopped by the existing origin check (403) before authentication.
		expect((await app.inject({ method: 'POST', url: '/api/rooms/board-a/actions', headers: machine(), payload: { actions: [] } })).statusCode).toBe(403)
	})

	it('fails closed when the machine hostname is configured without an Access verifier', async () => {
		const { app } = await setup({ hostPolicy: { publicHost: HUMAN_HOST, machineHost: MACHINE_HOST } })
		const response = await app.inject({ method: 'GET', url: '/api/health', headers: machine(tokens.fullA) })
		expect(response.statusCode).toBe(503)
	})

	it('an explicitly Access-less policy (tests and local development only) skips the assertion but nothing else', async () => {
		const { app } = await setup({ hostPolicy: { publicHost: HUMAN_HOST, machineHost: MACHINE_HOST, requireAccess: false } })
		expect((await app.inject({ method: 'GET', url: '/api/rooms/board-a/semantic-context', headers: { host: MACHINE_HOST, authorization: `Bearer ${tokens.readerA}` } })).statusCode).toBe(200)
		expect((await app.inject({ method: 'GET', url: '/login', headers: { host: MACHINE_HOST } })).statusCode).toBe(404)
	})
})

describe('machine hostname: only the machine API is served', () => {
	it.each([
		['GET', '/'], ['GET', '/login'], ['GET', '/register'], ['GET', '/boards'], ['GET', '/help'], ['GET', '/room/board-a'],
		['GET', '/app.js'], ['GET', '/assets/index.js'],
		['GET', '/api/auth/me'], ['POST', '/api/auth/login'], ['POST', '/api/auth/register'], ['POST', '/api/auth/logout'],
		['GET', '/api/boards'], ['POST', '/api/boards'], ['GET', '/api/boards/board-a'], ['DELETE', '/api/boards/board-a'],
		['GET', '/api/boards/board-a/members'], ['PUT', '/api/boards/board-a/members/someone'],
		['POST', '/api/invitations'], ['POST', '/api/invitations/consume'], ['POST', '/api/invitations/revoke'],
		['GET', '/api/connect/board-a'], ['GET', '/api/unfurl'],
		['POST', '/api/boards/board-a/uploads/x'], ['POST', '/api/boards/board-a/evidence-tables'], ['GET', '/api/boards/board-a/assets/x'],
	])('%s %s is not found on the machine hostname, even with valid Access and a valid token', async (method, url) => {
		const { app } = await setup()
		const response = await app.inject({ method: method as 'GET', url, headers: machine(tokens.fullA), payload: method === 'GET' ? undefined : {} })
		expect(response.statusCode).toBe(404)
		expect(response.json()).toEqual({ error: 'Not found' })
		expect(response.body).not.toContain('SPA-SHELL')
	})

	it('the allowlist is exactly the set of operations that already accept a board-scoped bearer token', () => {
		expect(MACHINE_ROUTES.map((route) => `${route.method} ${route.pattern.source}`).sort()).toMatchSnapshot()
		expect(isMachineRoute('GET', '/api/rooms/board-a/semantic-context?includeArchived=true')).toBe(true)
		expect(isMachineRoute('GET', '/api/rooms/board-a/semantic-context/')).toBe(false)
		expect(isMachineRoute('GET', '/api/rooms/%62oard-a/canvas')).toBe(false)
		expect(isMachineRoute('DELETE', '/api/rooms/board-a/canvas')).toBe(false)
		expect(isMachineRoute('GET', '/api/boards/board-a/history/12/snapshot')).toBe(true)
		expect(isMachineRoute('GET', '/api/boards/board-a/history/abc/snapshot')).toBe(false)
	})
})

describe('machine hostname: a browser session is never a machine credential', () => {
	it('a valid human session cookie, with or without Access, grants nothing', async () => {
		const { app, cookie } = await setup()
		for (const url of ['/api/rooms/board-a/semantic-context', '/api/rooms/board-a/canvas', '/api/boards/board-a/history', '/api/boards/board-a/checkpoints']) {
			expect((await app.inject({ method: 'GET', url, headers: { ...machine(), cookie } })).statusCode, url).toBe(401)
			expect((await app.inject({ method: 'GET', url, headers: { host: MACHINE_HOST, cookie } })).statusCode, url).toBe(403)
		}
		const write = await app.inject({ method: 'POST', url: '/api/rooms/board-a/actions', headers: { ...machine(), cookie }, payload: createTask('cookie') })
		expect(write.statusCode).toBe(403)
		const restoreFallback = await app.inject({ method: 'POST', url: '/api/boards/board-a/restore', headers: { ...machine(), cookie }, payload: {} })
		expect(restoreFallback.statusCode).toBe(403)
	})

	it('a cookie next to a valid token is ignored, and next to an invalid token never rescues it', async () => {
		const { app, cookie } = await setup()
		const withValid = await app.inject({ method: 'GET', url: '/api/rooms/board-a/semantic-context', headers: machine(tokens.readerA, { cookie }) })
		expect(withValid.statusCode).toBe(200)
		const withInvalid = await app.inject({ method: 'GET', url: '/api/rooms/board-a/semantic-context', headers: machine('x'.repeat(43), { cookie }) })
		expect(withInvalid.statusCode).toBe(401)
	})
})

describe('machine hostname: board-scoped token scopes', () => {
	it('read scope: reads the semantic context and canvas, cannot write', async () => {
		const { app } = await setup()
		const context = await app.inject({ method: 'GET', url: '/api/rooms/board-a/semantic-context', headers: machine(tokens.readerA) })
		expect(context.statusCode).toBe(200)
		expect(context.json()).toMatchObject({ roomId: 'board-a' })
		expect((await app.inject({ method: 'GET', url: '/api/rooms/board-a/canvas', headers: machine(tokens.readerA) })).statusCode).toBe(200)
		expect((await app.inject({ method: 'POST', url: '/api/rooms/board-a/actions', headers: machine(tokens.readerA), payload: createTask('denied') })).statusCode).toBe(403)
		expect((await app.inject({ method: 'POST', url: '/api/rooms/board-a/ai/events', headers: machine(tokens.readerA), payload: { eventType: 'ai.requested' } })).statusCode).toBe(403)
		expect((await app.inject({ method: 'POST', url: '/api/boards/board-a/checkpoints', headers: machine(tokens.readerA), payload: {} })).statusCode).toBe(403)
	})

	it('write scope: creates a semantic entity, attributed in history to the token, and can archive it', async () => {
		const { app } = await setup()
		const created = await app.inject({ method: 'POST', url: '/api/rooms/board-a/actions', headers: machine(tokens.writerA), payload: createTask('temp-agent-task') })
		expect(created.statusCode).toBe(200)
		const context = await app.inject({ method: 'GET', url: '/api/rooms/board-a/semantic-context', headers: machine(tokens.writerA) })
		expect(context.json().entities.map((entity: { id: string }) => entity.id)).toContain('engineering_entity:temp-agent-task')
		const archived = await app.inject({ method: 'POST', url: '/api/rooms/board-a/actions', headers: machine(tokens.writerA), payload: { actions: [{ tool: 'update_status', id: 'engineering_entity:temp-agent-task', status: 'archived' }] } })
		expect(archived.statusCode).toBe(200)
		// A write-only-history token (history scope) can see who did it.
		const history = await app.inject({ method: 'GET', url: '/api/boards/board-a/history?entityType=records', headers: machine(tokens.fullA) })
		expect(history.statusCode).toBe(200)
		const entry = history.json().events.find((event: { entityId: string }) => event.entityId === 'engineering_entity:temp-agent-task')
		expect(entry).toMatchObject({ source: 'ai', actorUserId: 'token:writer-a' })
		expect(history.json().actors).toContainEqual({ id: 'token:writer-a', displayName: 'writer-a' })
	})

	it('history scope is required for history, snapshots and checkpoint listing', async () => {
		const { app } = await setup()
		for (const url of ['/api/boards/board-a/history', '/api/boards/board-a/checkpoints', '/api/boards/board-a/history/1/snapshot']) {
			expect((await app.inject({ method: 'GET', url, headers: machine(tokens.readerA) })).statusCode, url).toBe(403)
			expect((await app.inject({ method: 'GET', url, headers: machine(tokens.writerA) })).statusCode, url).toBe(403)
		}
		expect((await app.inject({ method: 'GET', url: '/api/boards/board-a/history', headers: machine(tokens.historyA) })).statusCode).toBe(200)
		expect((await app.inject({ method: 'GET', url: '/api/boards/board-a/checkpoints', headers: machine(tokens.historyA) })).statusCode).toBe(200)
		// Creating a checkpoint needs history AND write, so a read+history token still cannot.
		expect((await app.inject({ method: 'POST', url: '/api/boards/board-a/checkpoints', headers: machine(tokens.historyA), payload: {} })).statusCode).toBe(403)
	})

	it('restore scope is required to restore, and a restore creates a new head', async () => {
		const { app } = await setup()
		const checkpoint = await app.inject({ method: 'POST', url: '/api/boards/board-a/checkpoints', headers: machine(tokens.fullA), payload: { label: 'before' } })
		expect(checkpoint.statusCode).toBe(200)
		const events = (await app.inject({ method: 'GET', url: '/api/boards/board-a/history', headers: machine(tokens.fullA) })).json().events as Array<{ id: number; eventType: string; documentClock: number }>
		const marker = events.find((event) => event.eventType === 'checkpoint.created')!
		const body = { eventId: marker.id, expectedClock: marker.documentClock }
		for (const token of [tokens.readerA, tokens.writerA, tokens.historyA]) {
			expect((await app.inject({ method: 'POST', url: '/api/boards/board-a/restore', headers: machine(token), payload: body })).statusCode).toBe(403)
		}
		const restored = await app.inject({ method: 'POST', url: '/api/boards/board-a/restore', headers: machine(tokens.fullA), payload: body })
		expect(restored.statusCode).toBe(200)
		expect(restored.json().event.eventType).toBe('restore.completed')
	})

	it('a token for board A has no access to board B, with the same answer as for a board that does not exist', async () => {
		const { app } = await setup()
		const other = await app.inject({ method: 'GET', url: '/api/rooms/board-b/semantic-context', headers: machine(tokens.fullA) })
		const missing = await app.inject({ method: 'GET', url: '/api/rooms/no-such-board/semantic-context', headers: machine(tokens.fullA) })
		expect(other.statusCode).toBe(401)
		expect(other.body).toBe(missing.body)
		expect((await app.inject({ method: 'POST', url: '/api/rooms/board-b/actions', headers: machine(tokens.fullA), payload: createTask('crossboard') })).statusCode).toBe(403)
		expect((await app.inject({ method: 'GET', url: '/api/boards/board-b/history', headers: machine(tokens.fullA) })).statusCode).toBe(401)
		expect((await app.inject({ method: 'POST', url: '/api/boards/board-b/restore', headers: machine(tokens.fullA), payload: { eventId: 1, expectedClock: 0 } })).statusCode).toBe(403)
		// ...and board B's own token works on board B only.
		expect((await app.inject({ method: 'GET', url: '/api/rooms/board-b/semantic-context', headers: machine(tokens.readerB) })).statusCode).toBe(200)
		expect((await app.inject({ method: 'GET', url: '/api/rooms/board-a/semantic-context', headers: machine(tokens.readerB) })).statusCode).toBe(401)
	})

	it('table-evidence references stay board-isolated through the machine API', async () => {
		const { app, cookie } = await setup()
		const table = await app.inject({ method: 'POST', url: '/api/boards/board-a/evidence-tables', headers: { host: HUMAN_HOST, origin: ALLOWED_ORIGIN, cookie }, payload: { version: 1, columns: [{ key: 'x', label: 'X' }], rows: [{ x: 1 }] } })
		expect(table.statusCode).toBe(201)
		const reference = table.json().uploadId
		const attach = await app.inject({ method: 'POST', url: '/api/rooms/board-b/actions', headers: machine(tokens.readerB), payload: { actions: [{ tool: 'create_entity', id: 'engineering_entity:smuggled', entityType: 'evidence', title: 'x', fields: { kind: 'table', reference } }] } })
		expect(attach.statusCode).toBe(404)
	})

	it('revoking a whiteboard token takes effect on the very next request', async () => {
		const { app, tokenFile } = await setup()
		expect((await app.inject({ method: 'GET', url: '/api/rooms/board-a/semantic-context', headers: machine(tokens.writerA) })).statusCode).toBe(200)
		writeTokenFile(tokenFile, ['writer-a'])
		expect((await app.inject({ method: 'GET', url: '/api/rooms/board-a/semantic-context', headers: machine(tokens.writerA) })).statusCode).toBe(401)
		expect((await app.inject({ method: 'POST', url: '/api/rooms/board-a/actions', headers: machine(tokens.writerA), payload: createTask('after-revoke') })).statusCode).toBe(403)
		expect((await app.inject({ method: 'GET', url: '/api/rooms/board-a/semantic-context', headers: machine(tokens.readerA) })).statusCode).toBe(200)
	})
})

describe('machine hostname: rate limits', () => {
	it('token reads are budgeted per token, route class and board; humans are not affected', async () => {
		const { app, cookie } = await setup({ rateLimits: { machineRead: { limit: 3, windowMs: 60_000 } } })
		const read = (token: string, url = '/api/rooms/board-a/semantic-context') => app.inject({ method: 'GET', url, headers: machine(token) })
		for (let i = 0; i < 3; i++) expect((await read(tokens.writerA)).statusCode).toBe(200)
		expect((await read(tokens.writerA)).statusCode).toBe(429)
		expect((await read(tokens.readerA)).statusCode).toBe(200)
		const history = (token: string) => app.inject({ method: 'GET', url: '/api/boards/board-a/history', headers: machine(token) })
		for (let i = 0; i < 3; i++) expect((await history(tokens.historyA)).statusCode).toBe(200)
		expect((await history(tokens.historyA)).statusCode).toBe(429)
		for (let i = 0; i < 6; i++) {
			expect((await app.inject({ method: 'GET', url: '/api/rooms/board-a/semantic-context', headers: { host: HUMAN_HOST, cookie } })).statusCode).toBe(200)
		}
	})

	it('snapshot reads share the tight snapshot budget, and writes keep their own limit', async () => {
		const { app } = await setup({ rateLimits: { snapshot: { limit: 2, windowMs: 60_000 }, write: { limit: 2, windowMs: 60_000 } } })
		const events = (await app.inject({ method: 'GET', url: '/api/boards/board-a/history', headers: machine(tokens.historyA) })).json().events as Array<{ id: number }>
		const snapshot = () => app.inject({ method: 'GET', url: `/api/boards/board-a/history/${events[0].id}/snapshot`, headers: machine(tokens.historyA) })
		expect((await snapshot()).statusCode).toBe(200)
		expect((await snapshot()).statusCode).toBe(200)
		expect((await snapshot()).statusCode).toBe(429)
		const write = (id: string) => app.inject({ method: 'POST', url: '/api/rooms/board-a/actions', headers: machine(tokens.writerA), payload: createTask(id) })
		expect((await write('one')).statusCode).toBe(200)
		expect((await write('two')).statusCode).toBe(200)
		expect((await write('three')).statusCode).toBe(429)
	})
})

describe('human hostname', () => {
	it('is unchanged for people: the app shell, sign-in, boards and the semantic context work with a session', async () => {
		const { app, cookie } = await setup()
		const shell = await app.inject({ method: 'GET', url: '/boards', headers: { host: HUMAN_HOST } })
		expect(shell.statusCode).toBe(200)
		expect(shell.body).toContain('SPA-SHELL')
		expect((await app.inject({ method: 'GET', url: '/app.js', headers: { host: HUMAN_HOST } })).statusCode).toBe(200)
		expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { host: HUMAN_HOST, cookie } })).statusCode).toBe(200)
		expect((await app.inject({ method: 'GET', url: '/api/boards', headers: { host: HUMAN_HOST, cookie } })).statusCode).toBe(200)
		expect((await app.inject({ method: 'GET', url: '/api/rooms/board-a/semantic-context', headers: { host: HUMAN_HOST, cookie } })).statusCode).toBe(200)
		expect((await app.inject({ method: 'GET', url: '/api/health', headers: { host: HUMAN_HOST } })).statusCode).toBe(200)
	})

	it('refuses machine bearer tokens outright, so there is no public path around the machine hostname', async () => {
		const { app, cookie } = await setup()
		for (const [method, url] of [['GET', '/api/rooms/board-a/semantic-context'], ['GET', '/api/boards/board-a/history'], ['POST', '/api/rooms/board-a/actions'], ['POST', '/api/boards/board-a/restore']] as const) {
			const response = await app.inject({ method, url, headers: { host: HUMAN_HOST, authorization: `Bearer ${tokens.fullA}`, origin: ALLOWED_ORIGIN }, payload: method === 'POST' ? createTask('human-host') : undefined })
			expect(response.statusCode, url).toBe(401)
			expect(response.json().error).toContain('not accepted')
		}
		// The same ban applies when a session cookie is sent alongside (no mixed credentials).
		const mixed = await app.inject({ method: 'GET', url: '/api/rooms/board-a/semantic-context', headers: { host: HUMAN_HOST, cookie, authorization: `Bearer ${tokens.fullA}` } })
		expect(mixed.statusCode).toBe(401)
	})

	it('does not treat a spoofed forwarded host, a suffixed host, or a case/port variant as the machine hostname', async () => {
		const { app } = await setup()
		const spoof = await app.inject({ method: 'GET', url: '/login', headers: { host: HUMAN_HOST, 'x-forwarded-host': MACHINE_HOST } })
		expect(spoof.body).toContain('SPA-SHELL')
		const suffixed = await app.inject({ method: 'GET', url: '/login', headers: { host: `${MACHINE_HOST}.attacker.example` } })
		expect(suffixed.body).toContain('SPA-SHELL')
		const privateWithForwarded = await app.inject({ method: 'GET', url: '/api/rooms/board-a/semantic-context', headers: { host: 'localhost', 'x-forwarded-host': MACHINE_HOST, authorization: `Bearer ${tokens.readerA}` } })
		expect(privateWithForwarded.statusCode).toBe(200)
		const variant = await app.inject({ method: 'GET', url: '/login', headers: { host: `${MACHINE_HOST.toUpperCase()}:443` } })
		expect(variant.statusCode).toBe(403)
	})
})

describe('malformed Host headers', () => {
	it('are refused once any hostname is configured, never downgraded to the permissive private class', async () => {
		const { app } = await setup()
		for (const host of ['a.example.test, b.example.test', 'bad host', 'evil.example.test/../x']) {
			for (const [method, url] of [['GET', '/api/health'], ['GET', '/login'], ['GET', '/api/rooms/board-a/semantic-context']] as const) {
				const response = await app.inject({ method, url, headers: { host, authorization: `Bearer ${tokens.fullA}`, 'cf-access-jwt-assertion': VALID_ASSERTION } })
				expect(response.statusCode, `${JSON.stringify(host)} ${url}`).toBe(400)
				expect(response.body).not.toContain('SPA-SHELL')
			}
		}
	})

	it('are left alone when no hostname is configured (previous behaviour)', async () => {
		const { app } = await setup({ hostPolicy: {} })
		expect((await app.inject({ method: 'GET', url: '/api/health', headers: { host: 'bad host' } })).statusCode).toBe(200)
	})
})

describe('private hostnames', () => {
	it('keep the existing local/recovery behaviour: bearer tokens and the browser app both work', async () => {
		const { app } = await setup()
		for (const host of ['localhost', '127.0.0.1:8787', 'your-server']) {
			expect((await app.inject({ method: 'GET', url: '/api/rooms/board-a/semantic-context', headers: { host, authorization: `Bearer ${tokens.readerA}` } })).statusCode, host).toBe(200)
			expect((await app.inject({ method: 'GET', url: '/login', headers: { host } })).body, host).toContain('SPA-SHELL')
		}
	})

	it('with no hostnames configured at all the behaviour is exactly the previous behaviour', async () => {
		const { app } = await setup({ hostPolicy: {} })
		expect((await app.inject({ method: 'GET', url: '/api/rooms/board-a/semantic-context', headers: { host: HUMAN_HOST, authorization: `Bearer ${tokens.readerA}` } })).statusCode).toBe(200)
	})
})

describe('host policy', () => {
	it('normalizes hosts strictly and rejects ambiguous values', () => {
		expect(normalizeHost('Whiteboard-API.Example.Test:8443')).toBe('whiteboard-api.example.test')
		expect(normalizeHost('whiteboard-api.example.test.')).toBe('whiteboard-api.example.test')
		expect(normalizeHost('a.example.test, b.example.test')).toBeNull()
		expect(normalizeHost('evil.example.test/../x')).toBeNull()
		expect(normalizeHost('a b')).toBeNull()
		expect(normalizeHost(['a.example.test'])).toBeNull()
		expect(normalizeHost(undefined)).toBeNull()
	})

	it('refuses an invalid or self-overlapping configuration', () => {
		expect(() => createHostPolicy({ publicHost: 'same.example.test', machineHost: 'SAME.example.test' })).toThrow(/differ/)
		expect(() => createHostPolicy({ machineHost: 'not a host' })).toThrow()
		expect(createHostPolicy({ publicHost: HUMAN_HOST, machineHost: MACHINE_HOST }).classify(undefined)).toBe('invalid')
		expect(createHostPolicy({ publicHost: HUMAN_HOST }).classify('')).toBe('invalid')
		expect(createHostPolicy({}).classify(undefined)).toBe('private')
	})
})
