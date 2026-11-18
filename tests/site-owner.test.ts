import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { FastifyInstance } from 'fastify'
import WebSocket from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import { buildApp } from '../server/app'
import { AuthDatabase } from '../server/auth-db'

const cleanupDirectories: string[] = []
const apps: FastifyInstance[] = []
const ORIGIN = 'http://127.0.0.1:8787'
const PASSWORD = 'correct horse battery staple'

afterEach(async () => {
	for (const app of apps.splice(0)) {
		try { await app.close() } catch { /* already closed */ }
	}
	for (const directory of cleanupDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

interface Account { id: string; cookie: string }

/**
 * The first account to register is the installation administrator (the site owner). `alice` owns `alice-board`,
 * `bob` is a viewer on it, `carol` is an ordinary account with no membership anywhere, and the site owner holds
 * no membership on `alice-board` at all.
 */
async function fixture() {
	const directory = mkdtempSync(join(tmpdir(), 'canvas-site-owner-'))
	cleanupDirectories.push(directory)
	mkdirSync(join(directory, 'client'), { recursive: true })
	writeFileSync(join(directory, 'client', 'index.html'), '<!doctype html><html><body>canvas</body></html>')
	const app = await buildApp({ dataDirectory: directory, clientDirectory: join(directory, 'client'), logger: false })
	apps.push(app)
	const originalInject = app.inject.bind(app)
	app.inject = ((options: Parameters<FastifyInstance['inject']>[0]) => {
		if (typeof options === 'string') return originalInject(options)
		const method = String(options.method ?? 'GET').toUpperCase()
		const mutates = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE'
		return originalInject({ ...options, headers: { ...(mutates ? { origin: ORIGIN } : {}), ...options.headers } })
	}) as FastifyInstance['inject']

	const adminResponse = await app.inject({
		method: 'POST', url: '/api/auth/register',
		payload: { login: 'siteowner', displayName: 'Site Owner', password: PASSWORD },
	})
	expect(adminResponse.statusCode).toBe(200)
	expect(adminResponse.json().user.isAdmin).toBe(true)
	const admin: Account = { id: adminResponse.json().user.id, cookie: `canvas_session=${adminResponse.cookies[0].value}` }

	async function invited(login: string): Promise<Account> {
		const invite = await app.inject({ method: 'POST', url: '/api/invitations', headers: { cookie: admin.cookie }, payload: {} })
		expect(invite.statusCode).toBe(200)
		const registered = await app.inject({
			method: 'POST', url: '/api/auth/register',
			payload: { login, displayName: login, password: PASSWORD, invitationToken: invite.json().token },
		})
		expect(registered.statusCode).toBe(200)
		expect(registered.json().user.isAdmin).toBe(false)
		return { id: registered.json().user.id, cookie: `canvas_session=${registered.cookies[0].value}` }
	}
	const alice = await invited('alice')
	const bob = await invited('bob')
	const carol = await invited('carol')

	const created = await app.inject({
		method: 'POST', url: '/api/boards', headers: { cookie: alice.cookie }, payload: { name: 'Alice Board', id: 'alice-board' },
	})
	expect(created.statusCode).toBe(200)
	const share = await app.inject({
		method: 'PUT', url: `/api/boards/alice-board/members/${bob.id}`, headers: { cookie: alice.cookie }, payload: { role: 'viewer' },
	})
	expect(share.statusCode).toBe(200)

	function events(boardId: string) {
		const database = new AuthDatabase(join(directory, 'auth.sqlite'))
		try { return database.listAccountEvents({ boardId, limit: 500 }) } finally { database.close() }
	}
	return { app, directory, admin, alice, bob, carol, events }
}

async function openSocket(app: FastifyInstance, path: string, headers: Record<string, string>) {
	return new Promise<{ state: 'open' } | { state: 'closed'; code: number }>((resolve, reject) => {
		const address = app.server.address() as AddressInfo
		const socket = new WebSocket(`ws://127.0.0.1:${address.port}${path}`, { headers })
		const timer = setTimeout(() => { socket.terminate(); reject(new Error('websocket test timeout')) }, 5_000)
		socket.once('open', () => {
			const settle = setTimeout(() => { clearTimeout(timer); resolve({ state: 'open' }) }, 300)
			socket.once('close', (code) => { clearTimeout(settle); resolve({ state: 'closed', code }) })
		})
		socket.once('close', (code) => { clearTimeout(timer); resolve({ state: 'closed', code }) })
		socket.once('error', (error) => { clearTimeout(timer); reject(error) })
	})
}

describe('site owner reads and lists', () => {
	it('lets the site owner read a board they are not a member of, and no one else outside it', async () => {
		const f = await fixture()
		const asAdmin = await f.app.inject({ method: 'GET', url: '/api/boards/alice-board', headers: { cookie: f.admin.cookie } })
		expect(asAdmin.statusCode).toBe(200)
		expect(asAdmin.json().board).toMatchObject({ id: 'alice-board', ownerUserId: f.alice.id, role: 'owner', access: 'site-owner' })

		const asCarol = await f.app.inject({ method: 'GET', url: '/api/boards/alice-board', headers: { cookie: f.carol.cookie } })
		expect(asCarol.statusCode).toBe(404)
		const anonymous = await f.app.inject({ method: 'GET', url: '/api/boards/alice-board' })
		expect(anonymous.statusCode).toBe(401)
		const asOwner = await f.app.inject({ method: 'GET', url: '/api/boards/alice-board', headers: { cookie: f.alice.cookie } })
		expect(asOwner.json().board).toMatchObject({ role: 'owner', access: 'membership' })
		const asBob = await f.app.inject({ method: 'GET', url: '/api/boards/alice-board', headers: { cookie: f.bob.cookie } })
		expect(asBob.json().board).toMatchObject({ role: 'viewer', access: 'membership' })
	})

	it('keeps the default list membership-scoped and offers the all-boards view to the site owner only', async () => {
		const f = await fixture()
		const mine = await f.app.inject({ method: 'GET', url: '/api/boards', headers: { cookie: f.admin.cookie } })
		expect(mine.json().boards.map((board: { id: string }) => board.id)).not.toContain('alice-board')

		const all = await f.app.inject({ method: 'GET', url: '/api/boards?scope=all', headers: { cookie: f.admin.cookie } })
		expect(all.statusCode).toBe(200)
		expect(all.json().boards.find((board: { id: string }) => board.id === 'alice-board')).toMatchObject({ role: 'owner', access: 'site-owner' })

		for (const account of [f.alice, f.bob, f.carol]) {
			const denied = await f.app.inject({ method: 'GET', url: '/api/boards?scope=all', headers: { cookie: account.cookie } })
			expect(denied.statusCode).toBe(403)
		}
		const anonymous = await f.app.inject({ method: 'GET', url: '/api/boards?scope=all' })
		expect(anonymous.statusCode).toBe(401)
	})

	it('shows soft-deleted boards in the all view only when asked', async () => {
		const f = await fixture()
		expect((await f.app.inject({ method: 'DELETE', url: '/api/boards/alice-board', headers: { cookie: f.alice.cookie } })).statusCode).toBe(200)
		const hidden = await f.app.inject({ method: 'GET', url: '/api/boards?scope=all', headers: { cookie: f.admin.cookie } })
		expect(hidden.json().boards.map((board: { id: string }) => board.id)).not.toContain('alice-board')
		const shown = await f.app.inject({ method: 'GET', url: '/api/boards?scope=all&includeDeleted=true', headers: { cookie: f.admin.cookie } })
		expect(shown.json().boards.find((board: { id: string }) => board.id === 'alice-board')?.deletedAt).toBeTruthy()
		const direct = await f.app.inject({ method: 'GET', url: '/api/rooms/alice-board/canvas', headers: { cookie: f.admin.cookie } })
		expect(direct.statusCode).toBe(404)
	})
})

describe('site owner on the canvas, assets and history', () => {
	it('reads and writes the canvas of an unrelated board while a nonmember still gets nothing', async () => {
		const f = await fixture()
		const write = await f.app.inject({
			method: 'POST', url: '/api/rooms/alice-board/actions', headers: { cookie: f.admin.cookie },
			payload: { actions: [{ tool: 'create_shape', id: 'shape:admin', type: 'ellipse', text: 'Admin', x: 10, y: 10, width: 80, height: 80 }] },
		})
		expect(write.statusCode).toBe(200)
		const read = await f.app.inject({ method: 'GET', url: '/api/rooms/alice-board/canvas', headers: { cookie: f.admin.cookie } })
		expect(read.statusCode).toBe(200)
		expect(JSON.stringify(read.json())).toContain('shape:admin')

		const nonmemberRead = await f.app.inject({ method: 'GET', url: '/api/rooms/alice-board/canvas', headers: { cookie: f.carol.cookie } })
		expect(nonmemberRead.statusCode).toBe(404)
		const nonmemberWrite = await f.app.inject({
			method: 'POST', url: '/api/rooms/alice-board/actions', headers: { cookie: f.carol.cookie }, payload: { actions: [] },
		})
		expect(nonmemberWrite.statusCode).toBe(404)
		const viewerWrite = await f.app.inject({
			method: 'POST', url: '/api/rooms/alice-board/actions', headers: { cookie: f.bob.cookie }, payload: { actions: [] },
		})
		expect(viewerWrite.statusCode).toBe(403)
	})

	it('serves assets, history, checkpoints and restore to the site owner, and keeps them closed to nonmembers', async () => {
		const f = await fixture()
		const upload = await f.app.inject({
			method: 'POST', url: '/api/boards/alice-board/uploads/alice-image.png',
			headers: { cookie: f.alice.cookie, 'content-type': 'image/png' }, payload: Buffer.from('alice-bytes'),
		})
		expect(upload.statusCode).toBe(200)

		const adminAsset = await f.app.inject({ method: 'GET', url: '/api/boards/alice-board/assets/alice-image.png', headers: { cookie: f.admin.cookie } })
		expect(adminAsset.statusCode).toBe(200)
		expect(adminAsset.rawPayload.toString()).toBe('alice-bytes')
		const unknownAsset = await f.app.inject({ method: 'GET', url: '/api/boards/alice-board/assets/never-uploaded.png', headers: { cookie: f.admin.cookie } })
		expect(unknownAsset.statusCode).toBe(404)
		const carolAsset = await f.app.inject({ method: 'GET', url: '/api/boards/alice-board/assets/alice-image.png', headers: { cookie: f.carol.cookie } })
		expect(carolAsset.statusCode).toBe(404)

		const adminUpload = await f.app.inject({
			method: 'POST', url: '/api/boards/alice-board/uploads/admin-image.png',
			headers: { cookie: f.admin.cookie, 'content-type': 'image/png' }, payload: Buffer.from('admin-bytes'),
		})
		expect(adminUpload.statusCode).toBe(200)
		const viewerUpload = await f.app.inject({
			method: 'POST', url: '/api/boards/alice-board/uploads/bob-image.png',
			headers: { cookie: f.bob.cookie, 'content-type': 'image/png' }, payload: Buffer.from('bob-bytes'),
		})
		expect(viewerUpload.statusCode).toBe(403)

		await f.app.inject({
			method: 'POST', url: '/api/rooms/alice-board/actions', headers: { cookie: f.alice.cookie },
			payload: { actions: [{ tool: 'create_shape', id: 'shape:one', type: 'ellipse', text: 'One', x: 0, y: 0, width: 50, height: 50 }] },
		})
		const history = await f.app.inject({ method: 'GET', url: '/api/boards/alice-board/history', headers: { cookie: f.admin.cookie } })
		expect(history.statusCode).toBe(200)
		const event = history.json().events.find((item: { eventType: string }) => item.eventType === 'object.created')
		expect(event).toBeTruthy()
		const checkpoint = await f.app.inject({
			method: 'POST', url: '/api/boards/alice-board/checkpoints', headers: { cookie: f.admin.cookie }, payload: { label: 'Admin checkpoint' },
		})
		expect(checkpoint.statusCode).toBe(200)
		expect((await f.app.inject({ method: 'GET', url: '/api/boards/alice-board/checkpoints', headers: { cookie: f.admin.cookie } })).statusCode).toBe(200)
		const clock = (await f.app.inject({ method: 'GET', url: '/api/rooms/alice-board/canvas', headers: { cookie: f.admin.cookie } })).json().clock
		const restored = await f.app.inject({
			method: 'POST', url: '/api/boards/alice-board/restore', headers: { cookie: f.admin.cookie }, payload: { eventId: event.id, expectedClock: clock },
		})
		expect(restored.statusCode).toBe(200)

		for (const request of [
			{ method: 'GET' as const, url: '/api/boards/alice-board/history' },
			{ method: 'GET' as const, url: '/api/boards/alice-board/checkpoints' },
			{ method: 'POST' as const, url: '/api/boards/alice-board/checkpoints', payload: { label: 'x' } },
			{ method: 'POST' as const, url: '/api/boards/alice-board/restore', payload: { eventId: event.id, expectedClock: clock } },
		]) {
			const denied = await f.app.inject({ ...request, headers: { cookie: f.carol.cookie } })
			expect(denied.statusCode, `${request.method} ${request.url}`).toBe(404)
		}
		const viewerRestore = await f.app.inject({
			method: 'POST', url: '/api/boards/alice-board/restore', headers: { cookie: f.bob.cookie }, payload: { eventId: event.id, expectedClock: clock },
		})
		expect(viewerRestore.statusCode).toBe(403)
	})
})

describe('site owner on websockets', () => {
	it('opens a writable socket for the site owner and refuses nonmembers and anonymous clients', async () => {
		const f = await fixture()
		await f.app.listen({ port: 0 })
		const origin = { origin: ORIGIN }
		const admin = await openSocket(f.app, '/api/connect/alice-board?sessionId=site-owner-socket-1', { cookie: f.admin.cookie, ...origin })
		expect(admin.state).toBe('open')
		const carol = await openSocket(f.app, '/api/connect/alice-board?sessionId=carol-socket-1234', { cookie: f.carol.cookie, ...origin })
		expect(carol).toMatchObject({ state: 'closed', code: 1008 })
		const anonymous = await openSocket(f.app, '/api/connect/alice-board?sessionId=anonymous-sock-1', { ...origin })
		expect(anonymous).toMatchObject({ state: 'closed', code: 1008 })
		const crossOrigin = await openSocket(f.app, '/api/connect/alice-board?sessionId=cross-origin-sock', { cookie: f.admin.cookie, origin: 'https://evil.example' })
		expect(crossOrigin).toMatchObject({ state: 'closed', code: 1008 })
		const viewer = await openSocket(f.app, '/api/connect/alice-board?sessionId=bob-viewer-socket-1', { cookie: f.bob.cookie, ...origin })
		expect(viewer.state).toBe('open')
	})
})

describe('site owner administrative actions', () => {
	it('manages members, invitations, names and deletion on any board, and ordinary roles cannot', async () => {
		const f = await fixture()
		const rename = await f.app.inject({ method: 'PATCH', url: '/api/boards/alice-board', headers: { cookie: f.admin.cookie }, payload: { name: 'Renamed By Owner' } })
		expect(rename.statusCode).toBe(200)
		expect(rename.json().board).toMatchObject({ name: 'Renamed By Owner', ownerUserId: f.alice.id, access: 'site-owner' })

		const members = await f.app.inject({ method: 'GET', url: '/api/boards/alice-board/members', headers: { cookie: f.admin.cookie } })
		expect(members.statusCode).toBe(200)
		const grant = await f.app.inject({
			method: 'PUT', url: `/api/boards/alice-board/members/${f.carol.id}`, headers: { cookie: f.admin.cookie }, payload: { role: 'editor' },
		})
		expect(grant.statusCode).toBe(200)
		const nowEditor = await f.app.inject({ method: 'GET', url: '/api/boards/alice-board', headers: { cookie: f.carol.cookie } })
		expect(nowEditor.json().board).toMatchObject({ role: 'editor', access: 'membership' })
		const invite = await f.app.inject({
			method: 'POST', url: '/api/invitations', headers: { cookie: f.admin.cookie }, payload: { boardId: 'alice-board', role: 'viewer' },
		})
		expect(invite.statusCode).toBe(200)

		// The recorded owner is untouched and the site owner has gained no membership row.
		const afterMembers = (await f.app.inject({ method: 'GET', url: '/api/boards/alice-board/members', headers: { cookie: f.alice.cookie } })).json().members
		expect(afterMembers.map((member: { userId: string }) => member.userId)).not.toContain(f.admin.id)
		expect(afterMembers.find((member: { userId: string }) => member.userId === f.alice.id).role).toBe('owner')

		const ownerChange = await f.app.inject({
			method: 'PUT', url: `/api/boards/alice-board/members/${f.alice.id}`, headers: { cookie: f.admin.cookie }, payload: { role: 'viewer' },
		})
		expect(ownerChange.statusCode).toBe(403)

		// Ordinary roles gain nothing.
		expect((await f.app.inject({ method: 'PATCH', url: '/api/boards/alice-board', headers: { cookie: f.bob.cookie }, payload: { name: 'x' } })).statusCode).toBe(403)
		expect((await f.app.inject({
			method: 'PUT', url: `/api/boards/alice-board/members/${f.bob.id}`, headers: { cookie: f.carol.cookie }, payload: { role: 'editor' },
		})).statusCode).toBe(403)
		const strangerInvite = await f.app.inject({
			method: 'POST', url: '/api/invitations', headers: { cookie: f.bob.cookie }, payload: { boardId: 'alice-board', role: 'viewer' },
		})
		expect(strangerInvite.statusCode).toBe(403)

		const removed = await f.app.inject({ method: 'DELETE', url: '/api/boards/alice-board', headers: { cookie: f.admin.cookie } })
		expect(removed.statusCode).toBe(200)
		const restored = await f.app.inject({ method: 'POST', url: '/api/boards/alice-board/restore', headers: { cookie: f.admin.cookie }, payload: {} })
		expect(restored.statusCode).toBe(200)
		expect(restored.json().board.deletedAt).toBeNull()
	})

	it('overrides a lesser membership the site owner holds themselves', async () => {
		const f = await fixture()
		await f.app.inject({
			method: 'PUT', url: `/api/boards/alice-board/members/${f.admin.id}`, headers: { cookie: f.alice.cookie }, payload: { role: 'viewer' },
		})
		const board = await f.app.inject({ method: 'GET', url: '/api/boards/alice-board', headers: { cookie: f.admin.cookie } })
		expect(board.json().board).toMatchObject({ role: 'owner', access: 'site-owner' })
		const write = await f.app.inject({
			method: 'POST', url: '/api/rooms/alice-board/actions', headers: { cookie: f.admin.cookie },
			payload: { actions: [{ tool: 'create_shape', id: 'shape:over', type: 'ellipse', text: 'Over', x: 0, y: 0, width: 50, height: 50 }] },
		})
		expect(write.statusCode).toBe(200)
	})

	it('gives ordinary accounts no account-level power, and nothing to a board owner or editor on the agent routes', async () => {
		const f = await fixture()
		const accountInvite = await f.app.inject({ method: 'POST', url: '/api/invitations', headers: { cookie: f.alice.cookie }, payload: {} })
		expect(accountInvite.statusCode).toBe(403)
		// Agent management for the site owner is covered in tests/agent-access.test.ts; here only that others gain nothing.
		const carolAgents = await f.app.inject({ method: 'GET', url: '/api/agent-access?boardId=alice-board', headers: { cookie: f.carol.cookie } })
		expect(carolAgents.statusCode).toBe(404)
		const bobAgents = await f.app.inject({ method: 'GET', url: '/api/agent-access?boardId=alice-board', headers: { cookie: f.bob.cookie } })
		expect(bobAgents.statusCode).toBe(403)
	})
})

describe('site owner audit trail', () => {
	it('marks board-management rows written under the override and leaves ordinary rows unmarked', async () => {
		const f = await fixture()
		await f.app.inject({ method: 'PATCH', url: '/api/boards/alice-board', headers: { cookie: f.alice.cookie }, payload: { name: 'By Alice' } })
		await f.app.inject({ method: 'PATCH', url: '/api/boards/alice-board', headers: { cookie: f.admin.cookie }, payload: { name: 'By Site Owner' } })
		await f.app.inject({
			method: 'PUT', url: `/api/boards/alice-board/members/${f.carol.id}`, headers: { cookie: f.admin.cookie }, payload: { role: 'viewer' },
		})
		const rows = f.events('alice-board')
		const renames = rows.filter((row) => row.type === 'board.renamed')
		const byAlice = renames.find((row) => row.actorUserId === f.alice.id)!
		const byOwner = renames.find((row) => row.actorUserId === f.admin.id)!
		expect(JSON.parse(byAlice.metadataJson)).not.toHaveProperty('actorKind')
		expect(JSON.parse(byOwner.metadataJson)).toMatchObject({ actorKind: 'site-owner', accessVia: 'site-owner', name: 'By Site Owner' })
		const grant = rows.find((row) => row.type === 'board.member_role_changed' && row.actorUserId === f.admin.id)!
		expect(JSON.parse(grant.metadataJson)).toMatchObject({ actorKind: 'site-owner', role: 'viewer' })
		expect(grant.subjectUserId).toBe(f.carol.id)
	})

	it('records data-plane use under the override, collapses repeats, and never records ordinary members', async () => {
		const f = await fixture()
		const count = (action: string) => f.events('alice-board')
			.filter((row) => row.type === 'admin.board_accessed' && JSON.parse(row.metadataJson).action === action)
		for (let index = 0; index < 3; index += 1) {
			await f.app.inject({ method: 'GET', url: '/api/rooms/alice-board/canvas', headers: { cookie: f.admin.cookie } })
		}
		expect(count('http.access')).toHaveLength(1)
		expect(count('http.access')[0]).toMatchObject({ actorUserId: f.admin.id })
		expect(JSON.parse(count('http.access')[0].metadataJson)).toMatchObject({ actorKind: 'site-owner' })

		await f.app.inject({
			method: 'POST', url: '/api/boards/alice-board/uploads/audit-image.png',
			headers: { cookie: f.admin.cookie, 'content-type': 'image/png' }, payload: Buffer.from('x'),
		})
		expect(count('asset.upload')).toHaveLength(1)

		// Asset reads and member listings skip the HTTP access resolver, so the service itself records them.
		for (let index = 0; index < 2; index += 1) {
			const asset = await f.app.inject({ method: 'GET', url: '/api/boards/alice-board/assets/audit-image.png', headers: { cookie: f.admin.cookie } })
			expect(asset.statusCode).toBe(200)
			expect((await f.app.inject({ method: 'GET', url: '/api/boards/alice-board/members', headers: { cookie: f.admin.cookie } })).statusCode).toBe(200)
		}
		expect(count('asset.read')).toHaveLength(1)
		expect(count('members.list')).toHaveLength(1)
		const missing = await f.app.inject({ method: 'GET', url: '/api/boards/alice-board/assets/not-registered.png', headers: { cookie: f.admin.cookie } })
		expect(missing.statusCode).toBe(404)
		expect(count('asset.read')).toHaveLength(1)

		await f.app.inject({ method: 'GET', url: '/api/rooms/alice-board/canvas', headers: { cookie: f.alice.cookie } })
		await f.app.inject({ method: 'GET', url: '/api/rooms/alice-board/canvas', headers: { cookie: f.bob.cookie } })
		expect(f.events('alice-board').filter((row) => row.type === 'admin.board_accessed').every((row) => row.actorUserId === f.admin.id)).toBe(true)

		await f.app.listen({ port: 0 })
		await openSocket(f.app, '/api/connect/alice-board?sessionId=audit-socket-0001', { cookie: f.admin.cookie, origin: ORIGIN })
		await openSocket(f.app, '/api/connect/alice-board?sessionId=audit-socket-0002', { cookie: f.admin.cookie, origin: ORIGIN })
		expect(count('socket.connect')).toHaveLength(1)
	})

	it('records every restore individually', async () => {
		const f = await fixture()
		await f.app.inject({
			method: 'POST', url: '/api/rooms/alice-board/actions', headers: { cookie: f.alice.cookie },
			payload: { actions: [{ tool: 'create_shape', id: 'shape:r', type: 'ellipse', text: 'R', x: 0, y: 0, width: 50, height: 50 }] },
		})
		const event = (await f.app.inject({ method: 'GET', url: '/api/boards/alice-board/history', headers: { cookie: f.admin.cookie } }))
			.json().events.find((item: { eventType: string }) => item.eventType === 'object.created')
		for (let index = 0; index < 2; index += 1) {
			const clock = (await f.app.inject({ method: 'GET', url: '/api/rooms/alice-board/canvas', headers: { cookie: f.admin.cookie } })).json().clock
			const restored = await f.app.inject({
				method: 'POST', url: '/api/boards/alice-board/restore', headers: { cookie: f.admin.cookie }, payload: { eventId: event.id, expectedClock: clock },
			})
			expect(restored.statusCode).toBe(200)
		}
		const restores = f.events('alice-board').filter((row) => row.type === 'admin.board_accessed' && JSON.parse(row.metadataJson).action === 'history.restore')
		expect(restores).toHaveLength(2)
	})
})

describe('a disabled site owner', () => {
	it('loses the override with the account', async () => {
		const f = await fixture()
		// A second administrator is not creatable through the API, so exercise the service rule directly: a
		// disabled account is refused before any override applies.
		const database = new AuthDatabase(join(f.directory, 'auth.sqlite'))
		try { database.setUserDisabled(f.admin.id, new Date().toISOString(), new Date().toISOString()) } finally { database.close() }
		const board = await f.app.inject({ method: 'GET', url: '/api/boards/alice-board', headers: { cookie: f.admin.cookie } })
		expect([401, 403]).toContain(board.statusCode)
		const canvas = await f.app.inject({ method: 'GET', url: '/api/rooms/alice-board/canvas', headers: { cookie: f.admin.cookie } })
		expect([401, 403]).toContain(canvas.statusCode)
	})
})
