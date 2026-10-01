/**
 * A disposable, in-process four-role board fixture for authorization acceptance tests.
 *
 * `createAcceptanceFixture()` builds a real `buildApp()` Fastify instance against a freshly
 * created OS-temp-directory-backed SQLite data directory, registers four real application
 * accounts through the actual registration/invitation HTTP endpoints (not a shortcut around
 * them), assigns board roles through the real owner-only membership endpoint, and returns one
 * `FixtureIdentity` per role plus an `anonymous` identity with no session at all. Every request
 * goes through `app.inject()` (Fastify's in-process HTTP simulation), so there is no real
 * network traffic and no way for this to reach a live server.
 *
 * This is the shared mechanism for local/automated authorization acceptance. It intentionally
 * does not talk to `whiteboard.example.com` or any other real host: proving the real
 * public edge (Cloudflare Tunnel routing, real HTTPS cookies, the real browser) still requires
 * the one-time manual/operator-assisted run described in
 * `docs/deployments/2026-09-28-acceptance-fixture.md`.
 *
 * Production safety: this module never accepts a data directory from a caller. It always mints
 * its own with `mkdtempSync(join(tmpdir(), ...))`, validates the result with
 * `assertSafeFixtureDataDirectory` before using it, and clears every `CANVAS_*` environment
 * variable that `buildApp()` would otherwise fall back to for the duration of fixture
 * construction, restoring them in `cleanup()`. A fixture cannot silently pick up a real data
 * directory that happens to be set in the ambient environment, and there is no code path that
 * accepts an operator-supplied path at all - see `assertSafeFixtureDataDirectory`'s own tests in
 * `tests/acceptance-fixture.test.ts` for the adversarial cases this forecloses.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import WebSocket from 'ws'
import { buildApp, type BuildAppOptions } from '../../server/app'

export type FixtureRole = 'owner' | 'editor' | 'viewer' | 'nonmember' | 'anonymous'
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
export type SocketOutcome = { state: 'open' } | { state: 'closed'; code: number; reason: string }

const ENV_KEYS_TO_ISOLATE = [
	'CANVAS_DATA_DIR',
	'CANVAS_AUTH_DB_FILE',
	'CANVAS_CLIENT_DIR',
	'CANVAS_API_TOKENS_FILE',
	'CANVAS_ALLOW_OPEN_REGISTRATION',
] as const

/**
 * Markers for path shapes that must never be treated as a test fixture directory, matched
 * case-insensitively as substrings of the resolved path. This is defense-in-depth: the primary
 * guarantee is that `createAcceptanceFixture` never accepts a directory from a caller in the
 * first place, so this only matters if that invariant is ever broken by a future edit.
 */
const PRODUCTION_PATH_MARKERS = ['apps/collaborative-ai-canvas', 'apps\\collaborative-ai-canvas', 'home/app', 'your-server']

/**
 * Throws unless `directory` resolves to somewhere under the OS temp directory and does not look
 * like a production path. Exported so its own behavior - including the adversarial cases it is
 * meant to stop - has a direct regression test, independent of whether anything in this module
 * still calls it correctly.
 */
export function assertSafeFixtureDataDirectory(directory: string): void {
	const resolved = resolve(directory)
	const tempRoot = resolve(tmpdir())
	const isUnderTemp = resolved === tempRoot || resolved.startsWith(tempRoot + sep)
	if (!isUnderTemp) {
		throw new Error(
			`Refusing to use "${resolved}" as an acceptance fixture data directory: it is not under the OS temp ` +
			`directory (${tempRoot}). A fixture must run against a directory this process just created with ` +
			`mkdtempSync(), never a hand-provided, ambient, or production-shaped path.`
		)
	}
	const lower = resolved.toLowerCase()
	if (PRODUCTION_PATH_MARKERS.some((marker) => lower.includes(marker.toLowerCase()))) {
		throw new Error(`Refusing to use "${resolved}" as an acceptance fixture data directory: it looks like a production path.`)
	}
}

function randomLogin(role: string): string {
	return `${role}-${randomBytes(4).toString('hex')}`
}

function randomPassword(): string {
	return randomBytes(24).toString('hex')
}

/** Mirrors the browser: a real cookie flows unmodified, but a mutating request must also carry an allowed Origin. */
function patchInjectForOrigin(app: FastifyInstance): void {
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
}

async function openBoardSocket(app: FastifyInstance, path: string, headers: Record<string, string>): Promise<SocketOutcome> {
	if (app.server.address() === null) await app.listen({ port: 0 })
	return new Promise<SocketOutcome>((resolvePromise, reject) => {
		const address = app.server.address() as AddressInfo
		const socket = new WebSocket(`ws://127.0.0.1:${address.port}${path}`, { headers })
		const timer = setTimeout(() => { socket.terminate(); reject(new Error('acceptance fixture websocket timeout')) }, 5_000)
		const onClose = (code: number, reason: Buffer) => { clearTimeout(timer); resolvePromise({ state: 'closed', code, reason: reason.toString() }) }
		socket.once('open', () => {
			const settle = setTimeout(() => { clearTimeout(settle); resolvePromise({ state: 'open' }) }, 300)
			socket.once('close', (code, reason) => { clearTimeout(settle); onClose(code, reason) })
		})
		socket.once('close', onClose)
		socket.once('error', (error) => { clearTimeout(timer); reject(error) })
	})
}

export interface FixtureIdentity {
	role: FixtureRole
	userId: string | null
	login: string | null
	request(method: HttpMethod, url: string, payload?: unknown, extraHeaders?: Record<string, string>): Promise<LightMyRequestResponse>
	get(url: string): Promise<LightMyRequestResponse>
	post(url: string, payload?: unknown): Promise<LightMyRequestResponse>
	put(url: string, payload?: unknown): Promise<LightMyRequestResponse>
	patch(url: string, payload?: unknown): Promise<LightMyRequestResponse>
	delete(url: string): Promise<LightMyRequestResponse>
	/** Opens a real tldraw connect-handshake WebSocket as this identity. Defaults to the fixture board. */
	connectBoardSocket(boardId?: string, extraQuery?: string): Promise<SocketOutcome>
}

function makeIdentity(app: FastifyInstance, role: FixtureRole, boardId: string, identity: { userId: string; login: string; cookie: string } | null): FixtureIdentity {
	const cookie = identity?.cookie
	return {
		role,
		userId: identity?.userId ?? null,
		login: identity?.login ?? null,
		request: (method, url, payload, extraHeaders) => app.inject({
			method,
			url,
			headers: { ...(cookie ? { cookie } : {}), ...(extraHeaders ?? {}) },
			...(payload !== undefined ? { payload } : {}),
		}),
		get(url) { return this.request('GET', url) },
		post(url, payload) { return this.request('POST', url, payload ?? {}) },
		put(url, payload) { return this.request('PUT', url, payload ?? {}) },
		patch(url, payload) { return this.request('PATCH', url, payload ?? {}) },
		delete(url) { return this.request('DELETE', url) },
		connectBoardSocket(targetBoardId = boardId, extraQuery = '') {
			const sessionId = `fixture-${role}-${randomBytes(4).toString('hex')}`
			const path = `/api/connect/${targetBoardId}?sessionId=${sessionId}${extraQuery}`
			return openBoardSocket(app, path, { origin: 'http://127.0.0.1:8787', ...(cookie ? { cookie } : {}) })
		},
	}
}

export interface AcceptanceFixtureOptions {
	boardId?: string
	rateLimits?: BuildAppOptions['rateLimits']
}

export interface AcceptanceFixture {
	app: FastifyInstance
	directory: string
	boardId: string
	owner: FixtureIdentity
	editor: FixtureIdentity
	viewer: FixtureIdentity
	nonmember: FixtureIdentity
	anonymous: FixtureIdentity
	cleanup(): Promise<void>
}

/**
 * Builds one disposable board with four real, distinct authenticated identities: an owner
 * (the board creator, also the first-registered/admin account), an editor and a viewer (both
 * invited, registered, and assigned their role through the real owner-only membership
 * endpoint), and a nonmember (a real registered account with no membership on this board at
 * all - the identity that proves authentication alone does not grant board access). Each
 * identity has its own session/cookie; nothing here mutates a shared cookie between roles.
 */
export async function createAcceptanceFixture(options: AcceptanceFixtureOptions = {}): Promise<AcceptanceFixture> {
	const savedEnv = new Map(ENV_KEYS_TO_ISOLATE.map((key) => [key, process.env[key]]))
	for (const key of ENV_KEYS_TO_ISOLATE) delete process.env[key]

	const directory = mkdtempSync(join(tmpdir(), 'canvas-acceptance-'))
	try {
		assertSafeFixtureDataDirectory(directory)

		const boardId = options.boardId ?? `acceptance-${randomBytes(4).toString('hex')}`
		const app = await buildApp({
			dataDirectory: directory,
			clientDirectory: join(directory, 'client'),
			serveClient: false,
			logger: false,
			rateLimits: options.rateLimits,
		})
		patchInjectForOrigin(app)

		async function register(login: string, invitationToken?: string) {
			const response = await app.inject({
				method: 'POST',
				url: '/api/auth/register',
				payload: { login, displayName: login, password: randomPassword(), ...(invitationToken ? { invitationToken } : {}) },
			})
			if (response.statusCode !== 200) {
				throw new Error(`acceptance fixture: registering "${login}" failed with ${response.statusCode}: ${response.body}`)
			}
			const cookie = response.cookies[0]
			return { userId: response.json().user.id as string, login, cookie: `${cookie.name}=${cookie.value}` }
		}

		// The owner is the fixture's first account, which the application makes an admin - the
		// same bootstrap path every real deployment goes through for its first account.
		const ownerLogin = randomLogin('owner')
		const ownerIdentity = await register(ownerLogin)
		const ownerCookie = { cookie: ownerIdentity.cookie }

		const board = await app.inject({ method: 'POST', url: '/api/boards', headers: ownerCookie, payload: { name: 'Acceptance board', id: boardId } })
		if (board.statusCode !== 200) throw new Error(`acceptance fixture: creating board "${boardId}" failed with ${board.statusCode}: ${board.body}`)

		async function registerViaAccountInvitation(role: 'editor' | 'viewer' | 'nonmember') {
			const invite = await app.inject({ method: 'POST', url: '/api/invitations', headers: ownerCookie, payload: {} })
			if (invite.statusCode !== 200) throw new Error(`acceptance fixture: creating account invitation for "${role}" failed with ${invite.statusCode}: ${invite.body}`)
			return register(randomLogin(role), invite.json().token as string)
		}

		const editorIdentity = await registerViaAccountInvitation('editor')
		const viewerIdentity = await registerViaAccountInvitation('viewer')
		const nonmemberIdentity = await registerViaAccountInvitation('nonmember')

		for (const [identity, role] of [[editorIdentity, 'editor'], [viewerIdentity, 'viewer']] as const) {
			const assigned = await app.inject({
				method: 'PUT',
				url: `/api/boards/${boardId}/members/${identity.userId}`,
				headers: ownerCookie,
				payload: { role },
			})
			if (assigned.statusCode !== 200) throw new Error(`acceptance fixture: assigning ${role} to "${identity.login}" failed with ${assigned.statusCode}: ${assigned.body}`)
		}
		// nonmemberIdentity deliberately never touches this board's membership.

		return {
			app,
			directory,
			boardId,
			owner: makeIdentity(app, 'owner', boardId, ownerIdentity),
			editor: makeIdentity(app, 'editor', boardId, editorIdentity),
			viewer: makeIdentity(app, 'viewer', boardId, viewerIdentity),
			nonmember: makeIdentity(app, 'nonmember', boardId, nonmemberIdentity),
			anonymous: makeIdentity(app, 'anonymous', boardId, null),
			async cleanup() {
				try { await app.close() } catch { /* already closed */ }
				rmSync(directory, { recursive: true, force: true })
				for (const [key, value] of savedEnv) {
					if (value === undefined) delete process.env[key]
					else process.env[key] = value
				}
			},
		}
	} catch (error) {
		rmSync(directory, { recursive: true, force: true })
		for (const [key, value] of savedEnv) {
			if (value === undefined) delete process.env[key]
			else process.env[key] = value
		}
		throw error
	}
}
