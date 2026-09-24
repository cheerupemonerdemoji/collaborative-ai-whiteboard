import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { FastifyInstance } from 'fastify'
import WebSocket from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import { buildApp, type BuildAppOptions } from '../server/app'

const previousTokenFile = process.env.CANVAS_API_TOKENS_FILE
const cleanupDirectories: string[] = []
const apps: FastifyInstance[] = []

afterEach(async () => {
	for (const app of apps.splice(0)) {
		try { await app.close() } catch { /* already closed */ }
	}
	for (const directory of cleanupDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
	if (previousTokenFile === undefined) delete process.env.CANVAS_API_TOKENS_FILE
	else process.env.CANVAS_API_TOKENS_FILE = previousTokenFile
})

async function createApp(prepare: (directory: string) => void = () => {}, rateLimits?: BuildAppOptions['rateLimits']) {
	const directory = mkdtempSync(join(tmpdir(), 'canvas-app-test-'))
	cleanupDirectories.push(directory)
	prepare(directory)
	mkdirSync(join(directory, 'client'), { recursive: true })
	writeFileSync(join(directory, 'client', 'index.html'), '<!doctype html><html><body>canvas</body></html>')
	const app = await buildApp({ dataDirectory: directory, clientDirectory: join(directory, 'client'), logger: false, rateLimits })
	const originalInject = app.inject.bind(app)
	app.inject = ((options: Parameters<FastifyInstance['inject']>[0]) => {
		if (typeof options === 'string') return originalInject(options)
		const method = String(options.method ?? 'GET').toUpperCase()
		const mutates = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE'
		return originalInject({
			...options,
			headers: { ...(mutates ? { origin: 'http://127.0.0.1:8787' } : {}), ...options.headers },
		})
	}) as FastifyInstance['inject']
	apps.push(app)
	return { directory, app }
}

function legacyRoom(directory: string, id: string) {
	mkdirSync(join(directory, 'rooms'), { recursive: true })
	writeFileSync(join(directory, 'rooms', `${id}.sqlite`), '')
}

async function registerOwner(app: FastifyInstance, login = 'Owner') {
	const response = await app.inject({
		method: 'POST',
		url: '/api/auth/register',
		payload: { login, displayName: 'Board Owner', password: 'correct horse battery staple' },
	})
	expect(response.statusCode).toBe(200)
	const cookie = response.cookies[0]
	expect(cookie?.name).toBe('canvas_session')
	return { body: response.json(), cookie: `${cookie.name}=${cookie.value}` }
}

function bearer(token: string) { return { authorization: `Bearer ${token}` } }

async function openSocket(app: FastifyInstance, path: string, headers: Record<string, string>) {
	return new Promise<{ state: 'open' } | { state: 'closed'; code: number; reason: string }>((resolve, reject) => {
		const address = app.server.address() as AddressInfo
		const socket = new WebSocket(`ws://127.0.0.1:${address.port}${path}`, { headers })
		const timer = setTimeout(() => { socket.terminate(); reject(new Error('websocket test timeout')) }, 5_000)
		const onClose = (code: number, reason: Buffer) => {
			clearTimeout(timer)
			resolve({ state: 'closed', code, reason: reason.toString() })
		}
		socket.once('open', () => {
			// A server-side refusal arrives as a close right after the upgrade.
			const settle = setTimeout(() => { clearTimeout(timer); resolve({ state: 'open' }) }, 300)
			socket.once('close', (code, reason) => {
				clearTimeout(settle)
				onClose(code, reason)
			})
		})
		socket.once('close', (code, reason) => {
			socket.off('open', () => {})
			onClose(code, reason)
		})
		socket.once('error', (error) => { clearTimeout(timer); reject(error) })
	})
}

describe('health, SPA fallback, and account lifecycle', () => {
	it('reports health and serves the SPA fallback for non-API routes', async () => {
		const { app } = await createApp()
		const health = await app.inject({ method: 'GET', url: '/api/health' })
		expect(health.statusCode).toBe(200)
		expect(health.json()).toMatchObject({ ok: true, service: 'collaborative-ai-canvas' })
		const spa = await app.inject({ method: 'GET', url: '/boards' })
		expect(spa.statusCode).toBe(200)
		expect(spa.body).toContain('canvas')
		const missingApi = await app.inject({ method: 'GET', url: '/api/nope' })
		expect(missingApi.statusCode).toBe(404)
		expect(missingApi.json()).toEqual({ error: 'Not found' })
	})

	it('requires an allowed origin for browser mutations and never falls back from an invalid bearer token to a cookie', async () => {
		const { app } = await createApp()
		const owner = await registerOwner(app)
		const missingOrigin = await app.inject({
			method: 'POST', url: '/api/boards', headers: { cookie: owner.cookie, origin: '' }, payload: { name: 'Blocked' },
		})
		expect(missingOrigin.statusCode).toBe(403)
		const board = await app.inject({ method: 'POST', url: '/api/boards', headers: { cookie: owner.cookie }, payload: { name: 'Private', id: 'private' } })
		expect(board.statusCode).toBe(200)
		const invalidBearer = await app.inject({
			method: 'POST', url: '/api/rooms/private/actions',
			headers: { cookie: owner.cookie, authorization: `Bearer ${'x'.repeat(43)}` }, payload: { actions: [] },
		})
		expect(invalidBearer.statusCode).toBe(401)
	})

	it('sets Secure session cookies and HSTS for HTTPS forwarded by the local tunnel', async () => {
		const { app } = await createApp()
		const response = await app.inject({
			method: 'POST', url: '/api/auth/register',
			headers: { 'x-forwarded-proto': 'https', 'cf-connecting-ip': '203.0.113.20' },
			payload: { login: 'secure-owner', displayName: 'Secure Owner', password: 'correct horse battery staple' },
		})
		expect(response.statusCode).toBe(200)
		expect(response.headers['set-cookie']).toContain('; Secure')
		expect(response.headers['strict-transport-security']).toBe('max-age=31536000')
	})

	it('bootstraps the first account, adopts legacy rooms, and manages settings and logout', async () => {
		const { app } = await createApp((directory) => {
			legacyRoom(directory, 'demo')
			legacyRoom(directory, 'class-room')
		})
		const owner = await registerOwner(app)
		expect(owner.body.user.isAdmin).toBe(true)
		expect(owner.body.token).toBeUndefined()
		expect(owner.body.session).toBeTruthy()

		const boards = await app.inject({ method: 'GET', url: '/api/boards', headers: { cookie: owner.cookie } })
		expect(boards.statusCode).toBe(200)
		expect(boards.json().boards.map((board: { id: string }) => board.id).sort()).toEqual(['class-room', 'demo'])
		expect(boards.json().boards.every((board: { role: string }) => board.role === 'owner')).toBe(true)

		const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: owner.cookie } })
		expect(me.statusCode).toBe(200)
		expect(me.json().user.login).toBe('Owner')
		expect(me.json().token).toBeUndefined()

		const settings = await app.inject({
			method: 'PUT',
			url: '/api/auth/settings',
			headers: { cookie: owner.cookie },
			payload: { settings: { theme: 'dark' } },
		})
		expect(settings.statusCode).toBe(200)
		expect(settings.json().user.settings).toEqual({ theme: 'dark' })

		const login = await app.inject({
			method: 'POST',
			url: '/api/auth/login',
			payload: { login: 'Owner', password: 'correct horse battery staple' },
		})
		expect(login.statusCode).toBe(200)
		expect(login.json().user.login).toBe('Owner')
		expect(login.json().token).toBeUndefined()
		expect(login.cookies[0]?.name).toBe('canvas_session')

		const logout = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: owner.cookie } })
		expect(logout.statusCode).toBe(200)
		const meAfter = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: owner.cookie } })
		expect(meAfter.statusCode).toBe(401)
	})

	it('rate limits repeated login attempts', async () => {
		const { app } = await createApp()
		await registerOwner(app)
		let last: { statusCode: number } = { statusCode: 0 }
		for (let attempt = 0; attempt < 11; attempt += 1) {
			last = await app.inject({
				method: 'POST',
				url: '/api/auth/login',
				payload: { login: 'Owner', password: 'wrong password entirely' },
			})
		}
		expect(last.statusCode).toBe(429)
		expect(last.json()).toEqual({ error: 'Too many login attempts. Try again later.' })
	})

	it('denies anonymous access across every private HTTP surface', async () => {
		const { app } = await createApp((directory) => legacyRoom(directory, 'demo'))
		await registerOwner(app)
		const probes: Array<{ method: 'GET' | 'POST' | 'PUT'; url: string; payload?: unknown; headers?: Record<string, string> }> = [
			{ method: 'GET', url: '/api/auth/me' },
			{ method: 'GET', url: '/api/boards' },
			{ method: 'GET', url: '/api/boards/demo' },
			{ method: 'GET', url: '/api/boards/demo/members' },
			{ method: 'GET', url: '/api/rooms/demo/canvas' },
			{ method: 'GET', url: '/api/boards/demo/history' },
			{ method: 'GET', url: '/api/boards/demo/history/1/snapshot' },
			{ method: 'GET', url: '/api/boards/demo/checkpoints' },
			{ method: 'GET', url: '/api/boards/demo/assets/known.png' },
			{ method: 'POST', url: '/api/rooms/demo/actions', payload: { actions: [] } },
			{ method: 'POST', url: '/api/rooms/demo/ai/events', payload: { eventType: 'ai.requested' } },
			{ method: 'POST', url: '/api/boards/demo/checkpoints', payload: { label: 'Forbidden' } },
			{ method: 'POST', url: '/api/boards/demo/restore', payload: { eventId: 1, expectedClock: 0 } },
			{ method: 'POST', url: '/api/invitations', payload: {} },
			{ method: 'POST', url: '/api/invitations/consume', payload: { token: 'x'.repeat(43) } },
		]

		for (const probe of probes) {
			const response = await app.inject(probe)
			expect(response.statusCode, `${probe.method} ${probe.url}`).toBe(401)
		}
		const legacyAsset = await app.inject({ method: 'GET', url: '/api/uploads/known.png' })
		expect(legacyAsset.statusCode).toBe(404)
	})
})

describe('board management, members, invitations, and nonmember 404', () => {
	it('creates, renames, soft-deletes, and restores boards', async () => {
		const { app } = await createApp()
		const owner = await registerOwner(app)
		const created = await app.inject({
			method: 'POST',
			url: '/api/boards',
			headers: { cookie: owner.cookie },
			payload: { name: 'Project', id: 'project' },
		})
		expect(created.statusCode).toBe(200)
		expect(created.json().board).toMatchObject({ id: 'project', name: 'Project', role: 'owner' })

		const renamed = await app.inject({
			method: 'PATCH',
			url: '/api/boards/project',
			headers: { cookie: owner.cookie },
			payload: { name: 'Roadmap' },
		})
		expect(renamed.json().board.name).toBe('Roadmap')

		const deleted = await app.inject({ method: 'DELETE', url: '/api/boards/project', headers: { cookie: owner.cookie } })
		expect(deleted.json().board.deletedAt).not.toBeNull()
		const listed = await app.inject({ method: 'GET', url: '/api/boards', headers: { cookie: owner.cookie } })
		expect(listed.json().boards).toEqual([])

		const restored = await app.inject({
			method: 'POST',
			url: '/api/boards/project/restore',
			headers: { cookie: owner.cookie },
			payload: {},
		})
		expect(restored.statusCode).toBe(200)
		expect(restored.json().board.deletedAt).toBeNull()
	})

	it('grants board invitations, enforces owner-only changes, and hides nonmember boards as 404', async () => {
		const { app } = await createApp()
		const owner = await registerOwner(app)
		await app.inject({
			method: 'POST',
			url: '/api/boards',
			headers: { cookie: owner.cookie },
			payload: { name: 'Project', id: 'project' },
		})

		const accountInvite = await app.inject({ method: 'POST', url: '/api/invitations', headers: { cookie: owner.cookie }, payload: {} })
		expect(accountInvite.statusCode).toBe(200)
		const bob = await app.inject({
			method: 'POST',
			url: '/api/auth/register',
			payload: {
				login: 'bob',
				displayName: 'Bob',
				password: 'another secure password',
				invitationToken: accountInvite.json().token,
			},
		})
		expect(bob.statusCode).toBe(200)
		expect(bob.cookies[0]?.name).toBe('canvas_session')
		const bobCookie = `${bob.cookies[0].name}=${bob.cookies[0].value}`

		const boardInvite = await app.inject({
			method: 'POST',
			url: '/api/invitations',
			headers: { cookie: owner.cookie },
			payload: { boardId: 'project', role: 'editor', invitedLogin: 'bob' },
		})
		const consumed = await app.inject({
			method: 'POST',
			url: '/api/invitations/consume',
			headers: { cookie: bobCookie },
			payload: { token: boardInvite.json().token },
		})
		expect(consumed.statusCode).toBe(200)
		expect(consumed.json().invitation.boardId).toBe('project')

		const bobBoard = await app.inject({ method: 'GET', url: '/api/boards/project', headers: { cookie: bobCookie } })
		expect(bobBoard.json().board.role).toBe('editor')
		const deniedRename = await app.inject({
			method: 'PATCH',
			url: '/api/boards/project',
			headers: { cookie: bobCookie },
			payload: { name: 'Nope' },
		})
		expect(deniedRename.statusCode).toBe(403)

		const members = await app.inject({ method: 'GET', url: '/api/boards/project/members', headers: { cookie: bobCookie } })
		expect(members.json().members.map((member: { role: string }) => member.role)).toEqual(['owner', 'editor'])

		const removed = await app.inject({
			method: 'PUT',
			url: `/api/boards/project/members/${bob.json().user.id}`,
			headers: { cookie: owner.cookie },
			payload: { role: null },
		})
		expect(removed.json()).toEqual({ ok: true })

		const hiddenBoard = await app.inject({ method: 'GET', url: '/api/boards/project', headers: { cookie: bobCookie } })
		expect(hiddenBoard.statusCode).toBe(404)
		const hiddenCanvas = await app.inject({ method: 'GET', url: '/api/rooms/project/canvas', headers: { cookie: bobCookie } })
		expect(hiddenCanvas.statusCode).toBe(404)
		const anonymous = await app.inject({ method: 'GET', url: '/api/boards/project' })
		expect(anonymous.statusCode).toBe(401)
		const missing = await app.inject({ method: 'GET', url: '/api/boards/nope', headers: { cookie: owner.cookie } })
		expect(missing.statusCode).toBe(404)
	})
})

describe('canvas, actions, AI events, history, and uploads', () => {
	it('serves canvas by cookie or bearer token, applies actions, records AI events without prompts, and supports history and uploads', async () => {
		const token = 'a'.repeat(43)
		const { app } = await createApp((directory) => {
			legacyRoom(directory, 'demo')
			writeFileSync(join(directory, 'tokens.json'), JSON.stringify({ clients: [
				{ name: 'alice-ai', tokenHash: createHash('sha256').update(token).digest('hex'), rooms: ['demo'], permissions: ['read', 'write', 'history', 'restore'] },
				{ name: 'read-only', tokenHash: createHash('sha256').update('b'.repeat(43)).digest('hex'), rooms: ['demo'], permissions: ['read'] },
			] }))
			process.env.CANVAS_API_TOKENS_FILE = join(directory, 'tokens.json')
		})
		const owner = await registerOwner(app)
		const demoBoards = await app.inject({ method: 'GET', url: '/api/boards', headers: { cookie: owner.cookie } })
		expect(demoBoards.json().boards.map((board: { id: string }) => board.id)).toContain('demo')

		const cookieCanvas = await app.inject({ method: 'GET', url: '/api/rooms/demo/canvas', headers: { cookie: owner.cookie } })
		expect(cookieCanvas.statusCode).toBe(200)
		const tokenCanvas = await app.inject({ method: 'GET', url: '/api/rooms/demo/canvas', headers: bearer(token) })
		expect(tokenCanvas.statusCode).toBe(200)

		const cookieActions = await app.inject({
			method: 'POST',
			url: '/api/rooms/demo/actions',
			headers: { cookie: owner.cookie },
			payload: {
				actions: [
					{ tool: 'create_shape', id: 'shape:left', type: 'ellipse', text: 'Left', x: 100, y: 100, width: 100, height: 100 },
					{ tool: 'create_shape', id: 'shape:right', type: 'ellipse', text: 'Right', x: 400, y: 100, width: 100, height: 100 },
					{ tool: 'connect_shapes', id: 'shape:link', fromId: 'shape:left', toId: 'shape:right' },
				],
			},
		})
		expect(cookieActions.statusCode).toBe(200)
		expect(cookieActions.json().applied).toBe(3)

		const tokenActions = await app.inject({
			method: 'POST',
			url: '/api/rooms/demo/actions',
			headers: bearer(token),
			payload: { actions: [{ tool: 'create_text', id: 'shape:note', text: 'AI note', x: 50, y: 50 }] },
		})
		expect(tokenActions.statusCode).toBe(200)
		expect(tokenActions.json().applied).toBe(1)

		const readOnlyDenied = await app.inject({
			method: 'POST',
			url: '/api/rooms/demo/actions',
			headers: bearer('b'.repeat(43)),
			payload: { actions: [{ tool: 'create_text', id: 'shape:denied', text: 'No', x: 0, y: 0 }] },
		})
		expect(readOnlyDenied.statusCode).toBe(403)

		const aiEvent = await app.inject({
			method: 'POST',
			url: '/api/rooms/demo/ai/events',
			headers: bearer(token),
			payload: { eventType: 'ai.requested', metadata: { actions: 1, prompt: 'please keep this secret' } },
		})
		expect(aiEvent.statusCode).toBe(200)
		expect(aiEvent.json().event.eventType).toBe('ai.requested')
		expect(aiEvent.json().event.metadata.prompt).toBeUndefined()

		const history = await app.inject({ method: 'GET', url: '/api/boards/demo/history', headers: { cookie: owner.cookie } })
		expect(history.statusCode).toBe(200)
		const eventTypes = history.json().events.map((event: { eventType: string }) => event.eventType)
		expect(eventTypes).toEqual(expect.arrayContaining(['object.created', 'ai.requested']))
		expect(history.json().actors.map((actor: { displayName: string }) => actor.displayName)).toContain('Board Owner')

		const snapshotEvent = history.json().events.find((event: { eventType: string }) => event.eventType === 'object.created')
		const snapshot = await app.inject({
			method: 'GET',
			url: `/api/boards/demo/history/${snapshotEvent.id}/snapshot`,
			headers: { cookie: owner.cookie },
		})
		expect(snapshot.statusCode).toBe(200)
		expect(snapshot.json().snapshot).toBeTruthy()

		const checkpoint = await app.inject({
			method: 'POST',
			url: '/api/boards/demo/checkpoints',
			headers: { cookie: owner.cookie },
			payload: { label: 'Before redesign' },
		})
		expect(checkpoint.statusCode).toBe(200)
		expect(checkpoint.json().checkpoint.reason).toBe('explicit')
		const checkpoints = await app.inject({ method: 'GET', url: '/api/boards/demo/checkpoints', headers: { cookie: owner.cookie } })
		expect(checkpoints.json().checkpoints.map((item: { label: string }) => item.label)).toContain('Before redesign')

		const clock = (await app.inject({ method: 'GET', url: '/api/rooms/demo/canvas', headers: { cookie: owner.cookie } })).json().clock
		const restored = await app.inject({
			method: 'POST',
			url: '/api/boards/demo/restore',
			headers: { cookie: owner.cookie },
			payload: { eventId: snapshotEvent.id, expectedClock: clock },
		})
		expect(restored.statusCode).toBe(200)
		expect(restored.json()).toMatchObject({ restoreId: expect.any(String), clock: expect.any(Number) })
		expect(restored.json().event.eventType).toBe('restore.completed')

		const upload = await app.inject({
			method: 'POST',
			url: '/api/boards/demo/uploads/image-1.png',
			headers: { cookie: owner.cookie, 'content-type': 'image/png' },
			payload: Buffer.from('fake-png-bytes'),
		})
		expect(upload.statusCode).toBe(200)
		expect(upload.json()).toEqual({ ok: true })
		const scopedDownload = await app.inject({ method: 'GET', url: '/api/boards/demo/assets/image-1.png', headers: { cookie: owner.cookie } })
		expect(scopedDownload.statusCode).toBe(200)
		expect(scopedDownload.rawPayload.toString()).toBe('fake-png-bytes')
		const anonymousScopedDownload = await app.inject({ method: 'GET', url: '/api/boards/demo/assets/image-1.png' })
		expect(anonymousScopedDownload.statusCode).toBe(401)
		const legacyDownload = await app.inject({ method: 'GET', url: '/api/uploads/image-1.png' })
		expect(legacyDownload.statusCode).toBe(404)
		expect(scopedDownload.headers['content-security-policy']).toBe("default-src 'none'")
		expect(scopedDownload.headers['x-content-type-options']).toBe('nosniff')
	})
})

describe('websocket membership and origin enforcement', () => {
	it('accepts authenticated members, rejects anonymous and cross-origin clients', async () => {
		const { app } = await createApp((directory) => legacyRoom(directory, 'demo'))
		const owner = await registerOwner(app)
		const origin = { origin: 'http://127.0.0.1:8787' }
		await app.listen({ port: 0 })

		const member = await openSocket(app, '/api/connect/demo?sessionId=member-session-123', { cookie: owner.cookie, ...origin })
		expect(member.state).toBe('open')

		const anonymous = await openSocket(app, '/api/connect/demo?sessionId=anon-session-1234', { ...origin })
		expect(anonymous.state).toBe('closed')
		expect(anonymous.code).toBe(1008)

		const crossOrigin = await openSocket(app, '/api/connect/demo?sessionId=cross-session-123', { cookie: owner.cookie, origin: 'https://evil.example' })
		expect(crossOrigin.state).toBe('closed')
		expect(crossOrigin.code).toBe(1008)
	})

	it('opens sockets only for owner, editor, and viewer board members', async () => {
		const { app } = await createApp((directory) => legacyRoom(directory, 'demo'))
		const owner = await registerOwner(app)
		const users: Array<{ login: string; role: 'editor' | 'viewer' | null; cookie?: string; id?: string }> = [
			{ login: 'editor', role: 'editor' },
			{ login: 'viewer', role: 'viewer' },
			{ login: 'nonmember', role: null },
		]
		for (const user of users) {
			const invite = await app.inject({ method: 'POST', url: '/api/invitations', headers: { cookie: owner.cookie }, payload: {} })
			const registered = await app.inject({
				method: 'POST',
				url: '/api/auth/register',
				payload: {
					login: user.login,
					displayName: user.login,
					password: 'another secure password',
					invitationToken: invite.json().token,
				},
			})
			user.id = registered.json().user.id
			user.cookie = `canvas_session=${registered.cookies[0].value}`
			if (user.role) {
				const assigned = await app.inject({
					method: 'PUT',
					url: `/api/boards/demo/members/${user.id}`,
					headers: { cookie: owner.cookie },
					payload: { role: user.role },
				})
				expect(assigned.statusCode).toBe(200)
			}
		}
		await app.listen({ port: 0 })
		const origin = { origin: 'http://127.0.0.1:8787' }
		const ownerSocket = await openSocket(app, '/api/connect/demo?sessionId=owner-role-test', { cookie: owner.cookie, ...origin })
		expect(ownerSocket.state).toBe('open')
		for (const user of users) {
			const socket = await openSocket(app, `/api/connect/demo?sessionId=${user.login}-role-test`, { cookie: user.cookie!, ...origin })
			if (user.role) expect(socket.state, user.login).toBe('open')
			else {
				expect(socket.state).toBe('closed')
				if (socket.state === 'closed') expect(socket.code).toBe(1008)
			}
		}
	})
})


describe('write-path rate limiting', () => {
	it('bounds canvas writes, AI events, checkpoints, invitations, and uploads separately', async () => {
		const { app } = await createApp(() => {}, {
			write: { limit: 2, windowMs: 60_000 },
			snapshot: { limit: 1, windowMs: 60_000 },
			invitation: { limit: 1, windowMs: 60_000 },
			upload: { limit: 1, windowMs: 60_000 },
		})
		const owner = await registerOwner(app)
		const board = await app.inject({ method: 'POST', url: '/api/boards', headers: { cookie: owner.cookie }, payload: { name: 'Bounded', id: 'bounded' } })
		expect(board.statusCode).toBe(200)

		const write = (id: string) => app.inject({
			method: 'POST',
			url: '/api/rooms/bounded/actions',
			headers: { cookie: owner.cookie },
			payload: { actions: [{ tool: 'create_text', id, text: 'note', x: 10, y: 10 }] },
		})
		expect((await write('shape:one')).statusCode).toBe(200)
		expect((await write('shape:two')).statusCode).toBe(200)
		const throttled = await write('shape:three')
		expect(throttled.statusCode).toBe(429)
		expect(throttled.json().error).toMatch(/Too many canvas writes/)

		// A spent canvas-write budget must not consume the AI lifecycle budget.
		const aiEvent = await app.inject({
			method: 'POST',
			url: '/api/rooms/bounded/ai/events',
			headers: { cookie: owner.cookie },
			payload: { eventType: 'ai.requested' },
		})
		expect(aiEvent.statusCode).toBe(200)

		const checkpoint = (label: string) => app.inject({
			method: 'POST', url: '/api/boards/bounded/checkpoints', headers: { cookie: owner.cookie }, payload: { label },
		})
		expect((await checkpoint('First')).statusCode).toBe(200)
		expect((await checkpoint('Second')).statusCode).toBe(429)

		const invite = () => app.inject({ method: 'POST', url: '/api/invitations', headers: { cookie: owner.cookie }, payload: {} })
		expect((await invite()).statusCode).toBe(200)
		expect((await invite()).statusCode).toBe(429)

		const upload = (name: string) => app.inject({
			method: 'POST',
			url: `/api/boards/bounded/uploads/${name}`,
			headers: { cookie: owner.cookie, 'content-type': 'application/octet-stream' },
			payload: Buffer.from('asset'),
		})
		expect((await upload('first.bin')).statusCode).toBe(200)
		expect((await upload('second.bin')).statusCode).toBe(429)
	})

	it('keeps a machine token budget independent of the board member budget', async () => {
		const token = 'c'.repeat(43)
		const { app } = await createApp((directory) => {
			writeFileSync(join(directory, 'tokens.json'), JSON.stringify({ clients: [
				{ name: 'bounded-ai', tokenHash: createHash('sha256').update(token).digest('hex'), rooms: ['shared'], permissions: ['read', 'write'] },
			] }))
			process.env.CANVAS_API_TOKENS_FILE = join(directory, 'tokens.json')
		}, { write: { limit: 1, windowMs: 60_000 } })
		const owner = await registerOwner(app)
		expect((await app.inject({ method: 'POST', url: '/api/boards', headers: { cookie: owner.cookie }, payload: { name: 'Shared', id: 'shared' } })).statusCode).toBe(200)

		const act = (headers: Record<string, string>, id: string) => app.inject({
			method: 'POST',
			url: '/api/rooms/shared/actions',
			headers,
			payload: { actions: [{ tool: 'create_text', id, text: 'note', x: 10, y: 10 }] },
		})
		expect((await act({ cookie: owner.cookie }, 'shape:human')).statusCode).toBe(200)
		expect((await act({ cookie: owner.cookie }, 'shape:blocked')).statusCode).toBe(429)
		expect((await act(bearer(token), 'shape:machine')).statusCode).toBe(200)
		expect((await act(bearer(token), 'shape:machine-blocked')).statusCode).toBe(429)
	})
})

describe('asset read rate limiting', () => {
	async function galleryApp(rateLimits?: BuildAppOptions['rateLimits']) {
		const { app } = await createApp(() => {}, rateLimits)
		const owner = await registerOwner(app)
		expect((await app.inject({ method: 'POST', url: '/api/boards', headers: { cookie: owner.cookie }, payload: { name: 'Gallery', id: 'gallery' } })).statusCode).toBe(200)
		const upload = await app.inject({
			method: 'POST',
			url: '/api/boards/gallery/uploads/photo.bin',
			headers: { cookie: owner.cookie, 'content-type': 'application/octet-stream' },
			payload: Buffer.from('asset-bytes'),
		})
		expect(upload.statusCode).toBe(200)
		const join = async (login: string, role: 'viewer' | 'editor' | null) => {
			const invite = await app.inject({ method: 'POST', url: '/api/invitations', headers: { cookie: owner.cookie }, payload: {} })
			const registered = await app.inject({
				method: 'POST',
				url: '/api/auth/register',
				payload: { login, displayName: login, password: 'another secure password', invitationToken: invite.json().token },
			})
			expect(registered.statusCode).toBe(200)
			if (role) {
				const assigned = await app.inject({
					method: 'PUT',
					url: `/api/boards/gallery/members/${registered.json().user.id}`,
					headers: { cookie: owner.cookie },
					payload: { role },
				})
				expect(assigned.statusCode).toBe(200)
			}
			return `canvas_session=${registered.cookies[0].value}`
		}
		const read = (cookie: string | null, id = 'photo.bin', extra: { headers?: Record<string, string>; query?: string } = {}) => app.inject({
			method: 'GET',
			url: `/api/boards/gallery/assets/${id}${extra.query ?? ''}`,
			headers: { ...(cookie ? { cookie } : {}), ...(extra.headers ?? {}) },
		})
		return { app, owner, join, read }
	}

	it('serves authorized reads normally under the default budget', async () => {
		const { owner, join, read } = await galleryApp()
		const viewer = await join('viewer-user', 'viewer')
		for (let index = 0; index < 5; index++) {
			const ownerRead = await read(owner.cookie)
			expect(ownerRead.statusCode).toBe(200)
			expect(ownerRead.body).toBe('asset-bytes')
		}
		expect((await read(viewer)).statusCode).toBe(200)
	})

	it('throttles repeated reads per user and board, with the same 429 style as other paths', async () => {
		const { app, owner, join, read } = await galleryApp({ assetRead: { limit: 3, windowMs: 60_000 } })
		const viewer = await join('viewer-user', 'viewer')
		for (let index = 0; index < 3; index++) expect((await read(owner.cookie)).statusCode).toBe(200)
		const throttled = await read(owner.cookie)
		expect(throttled.statusCode).toBe(429)
		expect(throttled.json().error).toMatch(/Too many asset reads/)

		// The budget is per user: another member is unaffected by the owner's spent budget.
		expect((await read(viewer)).statusCode).toBe(200)
		// Probing an asset id that does not exist spends the same budget and is throttled too,
		// so the limit cannot be sidestepped by asking for something the server will 404.
		expect((await read(owner.cookie, 'missing.bin')).statusCode).toBe(429)
		// A spent read budget does not consume the canvas-write budget.
		const write = await app.inject({
			method: 'POST',
			url: '/api/rooms/gallery/actions',
			headers: { cookie: owner.cookie },
			payload: { actions: [{ tool: 'create_text', id: 'shape:still-writable', text: 'note', x: 1, y: 1 }] },
		})
		expect(write.statusCode).toBe(200)
	})

	it('keeps denying anonymous and nonmember callers, and never lets them spend or see a budget', async () => {
		const { owner, join, read } = await galleryApp({ assetRead: { limit: 2, windowMs: 60_000 } })
		const outsider = await join('outsider-user', null)
		expect((await read(null)).statusCode).toBe(401)
		for (let index = 0; index < 6; index++) {
			const denied = await read(outsider)
			expect(denied.statusCode).toBe(404)
		}
		// Malformed ids are rejected before any budget is consulted.
		expect((await read(owner.cookie, 'a..b')).statusCode).toBe(400)
		// Those denied attempts did not touch the member's budget.
		expect((await read(owner.cookie)).statusCode).toBe(200)
		expect((await read(owner.cookie)).statusCode).toBe(200)
		expect((await read(owner.cookie)).statusCode).toBe(429)
	})

	it('is enforced server-side: request headers, query strings and cache hints do not reset it', async () => {
		const { owner, read } = await galleryApp({ assetRead: { limit: 1, windowMs: 60_000 } })
		expect((await read(owner.cookie)).statusCode).toBe(200)
		const attempts = [
			{ headers: { 'x-forwarded-for': '198.51.100.7' } },
			{ headers: { 'x-forwarded-for': '203.0.113.9', 'x-real-ip': '203.0.113.9' } },
			{ headers: { 'cache-control': 'no-cache', pragma: 'no-cache' } },
			{ headers: { origin: 'http://127.0.0.1:8787', 'user-agent': 'different-client/1.0' } },
			{ query: '?bust=1' },
			{ query: '?bust=2&limit=0' },
		]
		for (const attempt of attempts) expect((await read(owner.cookie, 'photo.bin', attempt)).statusCode).toBe(429)
	})
})
