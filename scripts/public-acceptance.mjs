/**
 * Public acceptance harness.
 *
 * Every request here leaves this machine, crosses the public Internet to
 * Cloudflare, passes the Access gate, and comes back down the tunnel to the
 * application. Nothing in this file talks to 127.0.0.1. That distinction is the
 * whole point: the unit suite already proves the application's logic, and it
 * proves nothing about Cloudflare, the tunnel, cookie flags over real HTTPS, or
 * WebSocket upgrades through an edge proxy.
 *
 * Two authentication layers are in play and each check records which one it is
 * exercising:
 *
 *   edge            Cloudflare Access, before the application is reached
 *   app-auth        the application's own session
 *   app-authz       board membership and RBAC
 *   ws-authz        WebSocket acceptance and per-role write enforcement
 *   app-origin      the application's origin enforcement
 *   app-validation  schema and input validation
 *
 * Credentials. The Access cookie arrives in CANVAS_ACCESS_COOKIE and is never
 * printed, stored or written to any output. Application passwords are generated
 * per run and die with the process. Invitation tokens are single-use and are
 * redacted in the evidence file. Nothing this script handles is ever committed.
 *
 * Usage:
 *   CANVAS_ACCESS_COOKIE=... ACCEPTANCE_INVITES=tok1,tok2,tok3,tok4 \
 *     node scripts/public-acceptance.mjs [--board acceptance-YYYY-MM-DD]
 */

import { randomBytes, randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { getTlsyncProtocolVersion } from '@tldraw/sync-core'
import { createTLSchema } from '@tldraw/tlschema'
import WebSocket from 'ws'

const BASE = process.env.ACCEPTANCE_BASE ?? 'https://whiteboard.example.com'
const ORIGIN = BASE
const WS_BASE = BASE.replace(/^http/, 'ws')
const ACCESS_COOKIE = process.env.CANVAS_ACCESS_COOKIE ?? ''
const INVITES = (process.env.ACCEPTANCE_INVITES ?? '').split(',').map((t) => t.trim()).filter(Boolean)
const SYNC_SCHEMA = createTLSchema().serialize()

const boardArg = process.argv.indexOf('--board')
const BOARD = boardArg >= 0 ? process.argv[boardArg + 1] : `acceptance-${new Date().toISOString().slice(0, 10)}`

if (!ACCESS_COOKIE) {
	console.error('CANVAS_ACCESS_COOKIE is required: every public request must pass Cloudflare Access.')
	process.exit(2)
}

/* ---------------------------------------------------------------- results -- */

const results = []
let current = null

function record(status, detail, extra = {}) {
	Object.assign(current, { status, detail, ...extra })
}

async function check(id, phase, layer, description, fn) {
	current = { id, phase, layer, description, status: 'FAIL', detail: '' }
	results.push(current)
	try {
		await fn()
	} catch (error) {
		if (current.status === 'FAIL' && !current.detail) {
			record('FAIL', `threw: ${redact(String(error && error.message ? error.message : error))}`)
		}
	}
	const line = `${current.status.padEnd(7)} ${id.padEnd(5)} ${description}`
	console.log(current.status === 'PASS' ? line : `${line}\n            -> ${current.detail}`)
	current = null
}

function expect(condition, detail) {
	if (condition) record('PASS', detail)
	else record('FAIL', detail)
	return condition
}

function blocked(detail) {
	record('BLOCKED', detail)
}

/** Nothing secret reaches a log or the evidence file. */
function redact(text) {
	let out = String(text)
	if (ACCESS_COOKIE) out = out.split(ACCESS_COOKIE).join('<access-cookie>')
	for (const token of INVITES) if (token) out = out.split(token).join('<invitation-token>')
	for (const user of Object.values(users)) {
		if (user.password) out = out.split(user.password).join('<password>')
		if (user.session) out = out.split(user.session).join('<session-cookie>')
	}
	return out.replace(/canvas_session=[A-Za-z0-9_-]+/g, 'canvas_session=<session-cookie>')
}

/* ------------------------------------------------------------- http client -- */

/**
 * One independent cookie jar per identity. Two users never share a jar, so
 * "user B can see it" is never an artefact of reusing user A's session.
 */
class Client {
	constructor(name, { withAccess = true } = {}) {
		this.name = name
		this.jar = new Map()
		this.withAccess = withAccess
	}

	cookieHeader() {
		const parts = []
		if (this.withAccess) parts.push(`CF_Authorization=${ACCESS_COOKIE}`)
		for (const [key, value] of this.jar) parts.push(`${key}=${value}`)
		return parts.join('; ')
	}

	absorb(response) {
		const raw = response.headers.getSetCookie ? response.headers.getSetCookie() : []
		for (const cookie of raw) {
			const [pair] = cookie.split(';')
			const index = pair.indexOf('=')
			if (index < 0) continue
			const name = pair.slice(0, index).trim()
			const value = pair.slice(index + 1).trim()
			if (value === '' || /Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(cookie)) this.jar.delete(name)
			else this.jar.set(name, value)
			if (name === 'canvas_session') this.lastSetCookie = cookie
		}
		return raw
	}

	async request(method, path, { body, origin = ORIGIN, headers = {}, raw = false } = {}) {
		const init = {
			method,
			redirect: 'manual',
			headers: { cookie: this.cookieHeader(), ...(origin ? { origin } : {}), ...headers },
		}
		if (body !== undefined) {
			if (raw) {
				init.body = body
			} else {
				init.body = JSON.stringify(body)
				init.headers['content-type'] = 'application/json'
			}
		}
		const response = await fetch(`${BASE}${path}`, init)
		this.absorb(response)
		const text = await response.text()
		let json = null
		try { json = JSON.parse(text) } catch { /* not json */ }
		return { status: response.status, headers: response.headers, text, json, location: response.headers.get('location') }
	}

	get(path, options) { return this.request('GET', path, options) }
	post(path, body, options) { return this.request('POST', path, { body, ...options }) }
	put(path, body, options) { return this.request('PUT', path, { body, ...options }) }
	del(path, options) { return this.request('DELETE', path, options) }
}

/** A WebSocket carrying this identity's cookies, exactly as a browser would. */
function openSocket(client, boardId, { origin = ORIGIN, sessionId = randomUUID().slice(0, 16) } = {}) {
	const socket = new WebSocket(`${WS_BASE}/api/connect/${boardId}?sessionId=${sessionId}`, {
		headers: { cookie: client.cookieHeader(), ...(origin ? { origin } : {}) },
	})
	const inbound = []
	socket.on('message', (data) => inbound.push(data))
	const settled = new Promise((resolve) => {
		let done = false
		const finish = (outcome) => { if (!done) { done = true; resolve(outcome) } }
		// Fastify completes the WebSocket upgrade before the route handler can
		// authorize the connection. Refused sockets therefore open briefly and
		// are then closed by the application with policy code 1008. Match the
		// server's local integration and DR probes by allowing that close to
		// arrive before treating the connection as accepted.
		socket.on('open', () => {
			// A raw WebSocket upgrade is not yet a tldraw sync session. Send the same
			// connect request as TLSyncClient so the handshake, live-diff, and
			// reconnect assertions below exercise the real collaboration protocol.
			socket.send(JSON.stringify({
				type: 'connect',
				connectRequestId: `connect-${sessionId}`,
				lastServerClock: 0,
				protocolVersion: getTlsyncProtocolVersion(),
				schema: SYNC_SCHEMA,
			}))
			setTimeout(() => finish({ outcome: 'open' }), 1_000)
		})
		socket.on('unexpected-response', (_req, res) => finish({ outcome: 'rejected', status: res.statusCode }))
		socket.on('error', (error) => finish({ outcome: 'error', detail: String(error.message ?? error) }))
		socket.on('close', (code) => finish({ outcome: 'closed', code }))
		setTimeout(() => finish({ outcome: 'timeout' }), 12_000)
	})
	return { socket, inbound, settled }
}

function closeSocket(handle) {
	try { handle.socket.terminate() } catch { /* already gone */ }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Waits for a socket to receive something, without asserting protocol shape. */
async function waitForMessage(handle, timeoutMs = 8000) {
	const before = handle.inbound.length
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (handle.inbound.length > before) return handle.inbound.length - before
		await sleep(100)
	}
	return 0
}

/** Waits for a socket to receive a message whose payload contains `substring`, not just any message. */
async function waitForMessageContaining(handle, substring, timeoutMs = 8000) {
	const before = handle.inbound.length
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		for (let i = before; i < handle.inbound.length; i++) {
			const raw = handle.inbound[i]
			const text = typeof raw === 'string' ? raw : raw.toString('utf8')
			if (text.includes(substring)) return true
		}
		await sleep(100)
	}
	return false
}

const users = {}

/* =================================================================== phases = */

async function phaseEdge() {
	// No Access cookie at all: this is what an anonymous visitor from the
	// Internet gets, and it must never be the application.
	const anon = new Client('anonymous', { withAccess: false })

	for (const [id, path] of [['A1', '/'], ['A2', '/api/health'], ['A3', '/api/boards'], ['A4', '/api/auth/me']]) {
		await check(id, 'edge', 'edge', `anonymous GET ${path} is stopped by Cloudflare Access`, async () => {
			const response = await anon.get(path)
			const host = response.location ? new URL(response.location).host : ''
			expect(
				response.status === 302 && host.endsWith('cloudflareaccess.com'),
				`status=${response.status} redirect-host=${host || '(none)'}`
			)
		})
	}

	await check('A5', 'edge', 'edge', 'anonymous WebSocket upgrade is stopped by Cloudflare Access', async () => {
		const handle = openSocket(anon, BOARD)
		const { outcome, status, code } = await handle.settled
		closeSocket(handle)
		expect(outcome !== 'open', `outcome=${outcome} status=${status ?? ''} code=${code ?? ''}`)
	})
}

async function phaseAccessIsNotAppAuth() {
	// Past the edge, with no application session. Reaching the origin must not
	// be mistaken for being logged in.
	const gateOnly = new Client('access-only')

	await check('B1', 'access-vs-app', 'edge', 'an approved Access session reaches the application origin', async () => {
		const response = await gateOnly.get('/api/health')
		expect(
			response.status === 200 && response.json?.ok === true,
			`status=${response.status} body=${redact(response.text.slice(0, 120))}`
		)
	})

	for (const [id, path] of [
		['B2', '/api/auth/me'],
		['B3', '/api/boards'],
		['B4', `/api/rooms/${BOARD}/canvas`],
		['B5', `/api/boards/${BOARD}/history`],
	]) {
		await check(id, 'access-vs-app', 'app-auth', `Access alone does not authorize ${path}`, async () => {
			const response = await gateOnly.get(path)
			expect(response.status === 401, `status=${response.status}`)
		})
	}

	await check('B6', 'access-vs-app', 'ws-authz', 'Access alone does not authorize a board WebSocket', async () => {
		const handle = openSocket(gateOnly, BOARD)
		const { outcome, status, code } = await handle.settled
		closeSocket(handle)
		expect(outcome !== 'open', `outcome=${outcome} status=${status ?? ''} code=${code ?? ''}`)
	})
}

function makeUser(key, label) {
	const user = {
		key,
		login: `${label}-${randomBytes(3).toString('hex')}@acceptance.invalid`,
		displayName: label,
		password: randomBytes(18).toString('base64url'),
		client: new Client(label),
	}
	users[key] = user
	return user
}

async function phaseAccounts() {
	if (INVITES.length < 4) {
		for (const id of ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8']) {
			await check(id, 'accounts', 'app-auth', 'application account lifecycle', async () =>
				blocked(`needs 4 account invitations in ACCEPTANCE_INVITES; got ${INVITES.length}`))
		}
		return false
	}

	const labels = [['owner', 'acc-owner'], ['editor', 'acc-editor'], ['viewer', 'acc-viewer'], ['outsider', 'acc-outsider']]
	labels.forEach(([key, label], index) => { makeUser(key, label).invite = INVITES[index] })

	await check('C1', 'accounts', 'app-auth', 'account invitations create accounts through the public path', async () => {
		const failures = []
		for (const [key] of labels) {
			const user = users[key]
			const response = await user.client.post('/api/auth/register', {
				login: user.login, displayName: user.displayName, password: user.password, invitationToken: user.invite,
			})
			if (response.status !== 200) failures.push(`${user.displayName}:${response.status}:${redact(response.text.slice(0, 90))}`)
			else user.id = response.json?.user?.id
			await sleep(250)
		}
		expect(failures.length === 0, failures.length ? failures.join(' | ') : `registered ${labels.length} disposable accounts`)
	})

	await check('C2', 'accounts', 'app-auth', 'the session cookie is HttpOnly, Secure and SameSite over public HTTPS', async () => {
		const cookie = users.owner.client.lastSetCookie ?? ''
		const flags = {
			httpOnly: /HttpOnly/i.test(cookie),
			secure: /Secure/i.test(cookie),
			sameSite: (/SameSite=(\w+)/i.exec(cookie) ?? [])[1] ?? '(none)',
			path: (/Path=([^;]+)/i.exec(cookie) ?? [])[1] ?? '(none)',
		}
		expect(
			flags.httpOnly && flags.secure && /^(Strict|Lax)$/i.test(flags.sameSite),
			`HttpOnly=${flags.httpOnly} Secure=${flags.secure} SameSite=${flags.sameSite} Path=${flags.path}`
		)
	})

	await check('C3', 'accounts', 'app-auth', 'an authenticated session identifies the right account', async () => {
		const response = await users.owner.client.get('/api/auth/me')
		expect(
			response.status === 200 && response.json?.user?.login?.toLowerCase() === users.owner.login.toLowerCase(),
			`status=${response.status} matched=${response.json?.user?.login === users.owner.login}`
		)
	})

	await check('C4', 'accounts', 'app-auth', 'a wrong password is refused with the generic failure', async () => {
		const probe = new Client('bad-password')
		const response = await probe.post('/api/auth/login', { login: users.owner.login, password: 'not the right password' })
		const noSession = !probe.jar.has('canvas_session')
		expect(response.status === 401 && noSession, `status=${response.status} sessionIssued=${!noSession} body=${redact(response.text.slice(0, 120))}`)
	})

	await check('C5', 'accounts', 'app-auth', 'an unknown login fails identically, leaking no account existence', async () => {
		const probe = new Client('unknown-login')
		const unknown = await probe.post('/api/auth/login', { login: `no-such-${randomBytes(4).toString('hex')}@acceptance.invalid`, password: 'whatever it is' })
		const wrong = await new Client('wrong-password').post('/api/auth/login', { login: users.owner.login, password: 'whatever it is' })
		expect(
			unknown.status === wrong.status && unknown.text === wrong.text,
			`unknown=${unknown.status} wrongPassword=${wrong.status} identicalBody=${unknown.text === wrong.text}`
		)
	})

	await check('C6', 'accounts', 'app-auth', 'a session survives a fresh request on a new connection', async () => {
		const first = await users.editor.client.get('/api/auth/me')
		await sleep(400)
		const second = await users.editor.client.get('/api/auth/me')
		expect(first.status === 200 && second.status === 200, `first=${first.status} second=${second.status}`)
	})

	await check('C7', 'accounts', 'app-auth', 'logout revokes the session for further requests', async () => {
		const throwaway = new Client('logout-probe')
		const login = await throwaway.post('/api/auth/login', { login: users.outsider.login, password: users.outsider.password })
		const before = await throwaway.get('/api/auth/me')
		await throwaway.post('/api/auth/logout', {})
		const after = await throwaway.get('/api/auth/me')
		expect(
			login.status === 200 && before.status === 200 && after.status === 401,
			`login=${login.status} beforeLogout=${before.status} afterLogout=${after.status}`
		)
	})

	await check('C8', 'accounts', 'app-auth', 'a forged session cookie is rejected', async () => {
		const forged = new Client('forged-session')
		forged.jar.set('canvas_session', randomBytes(32).toString('base64url'))
		const response = await forged.get('/api/auth/me')
		expect(response.status === 401, `status=${response.status}`)
	})

	return true
}

async function phaseBoardAndInvitations() {
	await check('D1', 'invitations', 'app-authz', 'a disposable board is created and owned by its creator', async () => {
		const response = await users.owner.client.post('/api/boards', { id: BOARD, name: `Acceptance ${BOARD}` })
		if (response.status === 409 || /exists/i.test(response.text)) {
			const board = await users.owner.client.get(`/api/boards/${BOARD}`)
			return expect(board.status === 200 && board.json?.board?.role === 'owner', `reused existing board, role=${board.json?.board?.role}`)
		}
		expect(response.status === 200 && response.json?.board?.role === 'owner', `status=${response.status} role=${response.json?.board?.role}`)
	})

	await check('D2', 'invitations', 'app-authz', 'invitations cannot grant owner access', async () => {
		const response = await users.owner.client.post('/api/invitations', { boardId: BOARD, role: 'owner' })
		// 'owner' is not in the role enum, so this is refused by schema validation (422), not a
		// hand-written business-rule check (400). Either is a correct refusal; accept both.
		expect(response.status === 400 || response.status === 422, `status=${response.status} body=${redact(response.text.slice(0, 120))}`)
	})

	const grants = {}
	await check('D3', 'invitations', 'app-authz', 'the board owner can mint editor and viewer invitations', async () => {
		const problems = []
		for (const role of ['editor', 'viewer']) {
			const response = await users.owner.client.post('/api/invitations', { boardId: BOARD, role })
			if (response.status !== 200 || !response.json?.token) problems.push(`${role}:${response.status}`)
			else grants[role] = response.json.token
			await sleep(400)
		}
		expect(problems.length === 0, problems.length ? problems.join(' | ') : 'editor and viewer invitations issued')
	})

	await check('D4', 'invitations', 'app-authz', 'redeeming an invitation creates membership at the invited role', async () => {
		const problems = []
		for (const [role, key] of [['editor', 'editor'], ['viewer', 'viewer']]) {
			if (!grants[role]) { problems.push(`${role}: no token`); continue }
			const response = await users[key].client.post('/api/invitations/consume', { token: grants[role] })
			if (response.status !== 200) { problems.push(`${role}:${response.status}:${redact(response.text.slice(0, 80))}`); continue }
			const board = await users[key].client.get(`/api/boards/${BOARD}`)
			if (board.json?.board?.role !== role) problems.push(`${role}: got role ${board.json?.board?.role}`)
			await sleep(250)
		}
		expect(problems.length === 0, problems.length ? problems.join(' | ') : 'editor and viewer memberships created at the invited roles')
	})

	await check('D5', 'invitations', 'app-authz', 'a single-use invitation cannot be redeemed twice', async () => {
		if (!grants.viewer) return blocked('no viewer invitation was issued')
		const response = await users.outsider.client.post('/api/invitations/consume', { token: grants.viewer })
		const stillOutsider = await users.outsider.client.get(`/api/boards/${BOARD}`)
		expect(
			response.status >= 400 && stillOutsider.status >= 400,
			`reuse=${response.status} outsiderBoardAccess=${stillOutsider.status}`
		)
	})

	await check('D6', 'invitations', 'app-authz', 'an invitation below the minimum TTL is refused at mint time', async () => {
		const response = await users.owner.client.post('/api/invitations', { boardId: BOARD, role: 'viewer', expiresInMs: 60_000 })
		expect(response.status >= 400, `status=${response.status} body=${redact(response.text.slice(0, 100))}`)
	})

	await check('D6b', 'invitations', 'app-authz', 'an invitation refuses consumption once it has actually expired', async () => {
		const ttlMs = 5 * 60_000 + 3_000 // the enforced minimum TTL plus a small safety margin
		const minted = await users.owner.client.post('/api/invitations', { boardId: BOARD, role: 'viewer', expiresInMs: ttlMs })
		if (minted.status !== 200) return blocked(`could not mint a minimum-TTL invitation: ${minted.status} ${redact(minted.text.slice(0, 100))}`)
		await sleep(ttlMs)
		const consumed = await users.outsider.client.post('/api/invitations/consume', { token: minted.json.token })
		expect(consumed.status >= 400, `consumeAfterExpiry=${consumed.status}`)
	})

	await check('D7', 'invitations', 'app-authz', 'a revoked invitation is refused', async () => {
		const minted = await users.owner.client.post('/api/invitations', { boardId: BOARD, role: 'viewer' })
		if (minted.status !== 200) return blocked(`could not mint: ${minted.status}`)
		await sleep(300)
		const revoked = await users.owner.client.post('/api/invitations/revoke', { token: minted.json.token })
		const consumed = await users.outsider.client.post('/api/invitations/consume', { token: minted.json.token })
		expect(revoked.status === 200 && consumed.status >= 400, `revoke=${revoked.status} consume=${consumed.status}`)
	})

	await check('D8', 'invitations', 'app-authz', 'an invitation pinned to one login is refused to another', async () => {
		const minted = await users.owner.client.post('/api/invitations', {
			boardId: BOARD, role: 'viewer', invitedLogin: `pinned-${randomBytes(3).toString('hex')}@acceptance.invalid`,
		})
		if (minted.status !== 200) return blocked(`could not mint a pinned invitation: ${minted.status}`)
		await sleep(300)
		const wrongAccount = await users.outsider.client.post('/api/invitations/consume', { token: minted.json.token })
		await users.owner.client.post('/api/invitations/revoke', { token: minted.json.token })
		expect(wrongAccount.status >= 400, `consumeByWrongAccount=${wrongAccount.status}`)
	})

	await check('D9', 'invitations', 'app-authz', 'a non-owner member cannot invite to the board', async () => {
		const response = await users.editor.client.post('/api/invitations', { boardId: BOARD, role: 'viewer' })
		expect(response.status === 403, `editorInvite=${response.status}`)
	})

	await check('D10', 'invitations', 'app-authz', 'a non-admin cannot mint account invitations', async () => {
		const response = await users.owner.client.post('/api/invitations', {})
		expect(response.status === 403, `accountInviteByNonAdmin=${response.status}`)
	})
}

async function phaseRbac() {
	const write = (id, text) => ({ actions: [{ tool: 'create_text', id: `shape:${id}`, text, x: 40, y: 40 }] })

	await check('E1', 'rbac', 'app-authz', 'an editor can write to the board', async () => {
		const response = await users.editor.client.post(`/api/rooms/${BOARD}/actions`, write(`editor-${randomBytes(3).toString('hex')}`, 'editor write'))
		expect(response.status === 200, `status=${response.status} body=${redact(response.text.slice(0, 120))}`)
	})

	await check('E2', 'rbac', 'app-authz', 'a viewer can read the board', async () => {
		const response = await users.viewer.client.get(`/api/rooms/${BOARD}/canvas`)
		expect(response.status === 200 && Array.isArray(response.json?.objects), `status=${response.status} objects=${response.json?.objects?.length}`)
	})

	await check('E3', 'rbac', 'app-authz', 'a viewer cannot write through the API, bypassing the read-only UI', async () => {
		const response = await users.viewer.client.post(`/api/rooms/${BOARD}/actions`, write('viewer-attempt', 'viewer should not write'))
		expect(response.status === 403, `status=${response.status}`)
	})

	await check('E4', 'rbac', 'app-authz', 'a viewer cannot create checkpoints', async () => {
		const response = await users.viewer.client.post(`/api/boards/${BOARD}/checkpoints`, { label: 'viewer attempt' })
		expect(response.status === 403, `status=${response.status}`)
	})

	await check('E5', 'rbac', 'app-authz', 'a viewer cannot restore history', async () => {
		const response = await users.viewer.client.post(`/api/boards/${BOARD}/restore`, { eventId: 1, expectedClock: 0 })
		expect(response.status === 403, `status=${response.status}`)
	})

	await check('E6', 'rbac', 'app-authz', 'a viewer cannot upload assets', async () => {
		const response = await users.viewer.client.post(
			`/api/boards/${BOARD}/uploads/viewer-${randomBytes(3).toString('hex')}.txt`,
			Buffer.from('nope'), { raw: true, headers: { 'content-type': 'application/octet-stream' } }
		)
		expect(response.status === 403, `status=${response.status}`)
	})

	await check('E7', 'rbac', 'app-authz', 'an editor cannot perform owner-only board management', async () => {
		const rename = await users.editor.client.request('PATCH', `/api/boards/${BOARD}`, { body: { name: 'editor rename attempt' } })
		const members = await users.editor.client.put(`/api/boards/${BOARD}/members/${users.viewer.id}`, { role: 'editor' })
		const remove = await users.editor.client.del(`/api/boards/${BOARD}`)
		expect(
			rename.status === 403 && members.status === 403 && remove.status === 403,
			`rename=${rename.status} setMemberRole=${members.status} delete=${remove.status}`
		)
	})

	await check('E8', 'rbac', 'app-authz', 'the owner can manage membership', async () => {
		const promote = await users.owner.client.put(`/api/boards/${BOARD}/members/${users.viewer.id}`, { role: 'editor' })
		const demote = await users.owner.client.put(`/api/boards/${BOARD}/members/${users.viewer.id}`, { role: 'viewer' })
		const role = await users.viewer.client.get(`/api/boards/${BOARD}`)
		expect(
			promote.status === 200 && demote.status === 200 && role.json?.board?.role === 'viewer',
			`promote=${promote.status} demote=${demote.status} finalRole=${role.json?.board?.role}`
		)
	})

	const outsiderPaths = [
		['E9', `/api/boards/${BOARD}`, 'board metadata'],
		['E10', `/api/rooms/${BOARD}/canvas`, 'canvas contents'],
		['E11', `/api/boards/${BOARD}/history`, 'history'],
		['E12', `/api/boards/${BOARD}/checkpoints`, 'checkpoints'],
		['E13', `/api/boards/${BOARD}/members`, 'member list'],
	]
	for (const [id, path, what] of outsiderPaths) {
		await check(id, 'rbac', 'app-authz', `a logged-in non-member cannot read ${what}`, async () => {
			const response = await users.outsider.client.get(path)
			expect(response.status === 403 || response.status === 404, `status=${response.status}`)
		})
	}

	await check('E14', 'rbac', 'app-authz', 'a logged-in non-member cannot write to the board', async () => {
		const response = await users.outsider.client.post(`/api/rooms/${BOARD}/actions`, write('outsider', 'outsider write'))
		expect(response.status === 403 || response.status === 404, `status=${response.status}`)
	})

	await check('E15', 'rbac', 'app-authz', 'a logged-in non-member cannot restore board history', async () => {
		const response = await users.outsider.client.post(`/api/boards/${BOARD}/restore`, { eventId: 1, expectedClock: 0 })
		expect(response.status === 403 || response.status === 404, `status=${response.status}`)
	})
}

async function phaseCollaboration() {
	const shapeId = `shape:collab-${randomBytes(4).toString('hex')}`
	let ownerSocket = null
	let editorSocket = null

	await check('F1', 'collaboration', 'ws-authz', 'two independent members hold simultaneous WebSockets through Cloudflare', async () => {
		ownerSocket = openSocket(users.owner.client, BOARD)
		editorSocket = openSocket(users.editor.client, BOARD)
		const [a, b] = await Promise.all([ownerSocket.settled, editorSocket.settled])
		expect(a.outcome === 'open' && b.outcome === 'open', `owner=${a.outcome}${a.status ? '/' + a.status : ''} editor=${b.outcome}${b.status ? '/' + b.status : ''}`)
	})

	await check('F2', 'collaboration', 'ws-authz', 'each socket receives the room handshake', async () => {
		if (!ownerSocket || !editorSocket) return blocked('sockets were not established')
		await sleep(1500)
		expect(
			ownerSocket.inbound.length > 0 && editorSocket.inbound.length > 0,
			`ownerMessages=${ownerSocket.inbound.length} editorMessages=${editorSocket.inbound.length}`
		)
	})

	await check('F3', 'collaboration', 'ws-authz', "one member's edit is pushed live to the other's socket", async () => {
		if (!ownerSocket || !editorSocket) return blocked('sockets were not established')
		// Must observe the specific shape arrive, not just any message (a heartbeat or presence
		// update would otherwise make this pass without proving the edit was actually delivered).
		const waiting = waitForMessageContaining(editorSocket, shapeId, 8000)
		const write = await users.owner.client.post(`/api/rooms/${BOARD}/actions`, {
			actions: [{ tool: 'create_text', id: shapeId, text: 'pushed to the other client', x: 120, y: 120 }],
		})
		const receivedShape = await waiting
		expect(write.status === 200 && receivedShape, `write=${write.status} editorReceivedShape=${receivedShape}`)
	})

	await check('F4', 'collaboration', 'app-authz', "the other member reads the same shape back through the public API", async () => {
		const canvas = await users.editor.client.get(`/api/rooms/${BOARD}/canvas`)
		const found = (canvas.json?.objects ?? []).some((object) => object.id === shapeId)
		expect(canvas.status === 200 && found, `status=${canvas.status} shapeVisibleToOtherUser=${found}`)
	})

	await check('F5', 'collaboration', 'ws-authz', 'a viewer socket is accepted but the server refuses its writes', async () => {
		const viewerSocket = openSocket(users.viewer.client, BOARD)
		const settled = await viewerSocket.settled
		const attempt = await users.viewer.client.post(`/api/rooms/${BOARD}/actions`, {
			actions: [{ tool: 'create_text', id: 'shape:viewer-ws', text: 'no', x: 1, y: 1 }],
		})
		closeSocket(viewerSocket)
		expect(
			settled.outcome === 'open' && attempt.status === 403,
			`socket=${settled.outcome} viewerWrite=${attempt.status} (read-only is enforced server-side, not only in the UI)`
		)
	})

	await check('F6', 'collaboration', 'ws-authz', 'a non-member socket is refused', async () => {
		const handle = openSocket(users.outsider.client, BOARD)
		const settled = await handle.settled
		closeSocket(handle)
		expect(settled.outcome !== 'open', `outcome=${settled.outcome} status=${settled.status ?? ''} code=${settled.code ?? ''}`)
	})

	// Phase 7: interrupt one client, keep editing from the other, reconnect.
	let reconnectShapes = []
	await check('F7', 'reconnect', 'ws-authz', 'a client disconnected mid-session misses nothing on reconnect', async () => {
		if (!editorSocket) return blocked('no editor socket to interrupt')
		closeSocket(editorSocket)
		await sleep(800)

		reconnectShapes = [`shape:offline-${randomBytes(3).toString('hex')}`, `shape:offline-${randomBytes(3).toString('hex')}`]
		for (const id of reconnectShapes) {
			const response = await users.owner.client.post(`/api/rooms/${BOARD}/actions`, {
				actions: [{ tool: 'create_text', id, text: 'written while the other client was away', x: 200, y: 200 }],
			})
			if (response.status !== 200) return expect(false, `write while disconnected failed: ${response.status}`)
			await sleep(200)
		}

		const rejoined = openSocket(users.editor.client, BOARD)
		const settled = await rejoined.settled
		await sleep(1500)
		const messages = rejoined.inbound.length
		closeSocket(rejoined)

		const canvas = await users.editor.client.get(`/api/rooms/${BOARD}/canvas`)
		const ids = new Set((canvas.json?.objects ?? []).map((object) => object.id))
		const converged = reconnectShapes.every((id) => ids.has(id))
		expect(
			settled.outcome === 'open' && messages > 0 && converged,
			`reconnect=${settled.outcome} handshakeMessages=${messages} missedEditsPresentAfterReconnect=${converged}`
		)
	})

	await check('F8', 'reconnect', 'ws-authz', 'editing continues normally after the reconnect', async () => {
		const id = `shape:after-reconnect-${randomBytes(3).toString('hex')}`
		const socket = openSocket(users.editor.client, BOARD)
		await socket.settled
		const response = await users.editor.client.post(`/api/rooms/${BOARD}/actions`, {
			actions: [{ tool: 'create_text', id, text: 'after reconnect', x: 260, y: 260 }],
		})
		const canvas = await users.owner.client.get(`/api/rooms/${BOARD}/canvas`)
		closeSocket(socket)
		const visible = (canvas.json?.objects ?? []).some((object) => object.id === id)
		expect(response.status === 200 && visible, `write=${response.status} visibleToOwner=${visible}`)
	})

	if (ownerSocket) closeSocket(ownerSocket)
}

async function phaseHistory() {
	let checkpointClock = null
	let preCheckpointShape = null
	let postCheckpointShape = null

	await check('G1', 'history', 'app-authz', 'edits accumulate history events readable by a member', async () => {
		preCheckpointShape = `shape:hist-${randomBytes(3).toString('hex')}`
		await users.owner.client.post(`/api/rooms/${BOARD}/actions`, {
			actions: [{ tool: 'create_text', id: preCheckpointShape, text: 'before the checkpoint', x: 300, y: 60 }],
		})
		const history = await users.editor.client.get(`/api/boards/${BOARD}/history`)
		expect(
			history.status === 200 && (history.json?.events?.length ?? 0) > 0,
			`status=${history.status} events=${history.json?.events?.length ?? 0}`
		)
	})

	await check('G2', 'history', 'app-authz', 'a checkpoint can be created through the public path', async () => {
		const response = await users.owner.client.post(`/api/boards/${BOARD}/checkpoints`, { label: 'acceptance checkpoint' })
		checkpointClock = response.json?.checkpoint?.baseEventId ?? response.json?.checkpoint?.eventId ?? null
		expect(response.status === 200 && response.json?.checkpoint, `status=${response.status} checkpoint=${JSON.stringify(response.json?.checkpoint ?? null).slice(0, 160)}`)
	})

	await check('G3', 'history', 'app-authz', 'further edits move the board past the checkpoint', async () => {
		postCheckpointShape = `shape:post-${randomBytes(3).toString('hex')}`
		const response = await users.owner.client.post(`/api/rooms/${BOARD}/actions`, {
			actions: [{ tool: 'create_text', id: postCheckpointShape, text: 'after the checkpoint', x: 340, y: 100 }],
		})
		const canvas = await users.owner.client.get(`/api/rooms/${BOARD}/canvas`)
		const ids = new Set((canvas.json?.objects ?? []).map((object) => object.id))
		expect(
			response.status === 200 && ids.has(postCheckpointShape) && ids.has(preCheckpointShape),
			`write=${response.status} bothShapesPresent=${ids.has(postCheckpointShape) && ids.has(preCheckpointShape)}`
		)
	})

	await check('G4', 'history', 'app-authz', 'restoring the checkpoint rolls the board back', async () => {
		const history = await users.owner.client.get(`/api/boards/${BOARD}/history`)
		const events = history.json?.events ?? []
		const target = events.find((event) => event.type === 'board.checkpoint' || event.label === 'acceptance checkpoint')
			?? events.find((event) => event.id === checkpointClock)
		if (!target) return blocked(`no checkpoint event found among ${events.length} history events`)
		const canvas = await users.owner.client.get(`/api/rooms/${BOARD}/canvas`)
		const clock = canvas.json?.clock ?? canvas.json?.documentClock
		if (clock === undefined) return blocked(`the canvas response exposes no clock; keys=${Object.keys(canvas.json ?? {}).join(',')}`)
		const response = await users.owner.client.post(`/api/boards/${BOARD}/restore`, { eventId: target.id, expectedClock: clock })
		if (response.status !== 200) return expect(false, `restore=${response.status} body=${redact(response.text.slice(0, 160))}`)
		const after = await users.owner.client.get(`/api/rooms/${BOARD}/canvas`)
		const ids = new Set((after.json?.objects ?? []).map((object) => object.id))
		expect(
			ids.has(preCheckpointShape) && !ids.has(postCheckpointShape),
			`preCheckpointShapeKept=${ids.has(preCheckpointShape)} postCheckpointShapeRemoved=${!ids.has(postCheckpointShape)}`
		)
	})

	await check('G5', 'history', 'app-authz', 'a stale clock is refused, so concurrent restores cannot race', async () => {
		const history = await users.owner.client.get(`/api/boards/${BOARD}/history`)
		const target = (history.json?.events ?? [])[0]
		if (!target) return blocked('no history events available')
		const response = await users.owner.client.post(`/api/boards/${BOARD}/restore`, { eventId: target.id, expectedClock: 0 })
		expect(response.status === 409 || response.status === 400, `status=${response.status} body=${redact(response.text.slice(0, 120))}`)
	})

	await check('G6', 'history', 'ws-authz', 'connected clients converge after the restore and editing continues', async () => {
		const socket = openSocket(users.editor.client, BOARD)
		const settled = await socket.settled
		await sleep(1200)
		const id = `shape:post-restore-${randomBytes(3).toString('hex')}`
		const write = await users.editor.client.post(`/api/rooms/${BOARD}/actions`, {
			actions: [{ tool: 'create_text', id, text: 'editing after restore', x: 380, y: 140 }],
		})
		const canvas = await users.owner.client.get(`/api/rooms/${BOARD}/canvas`)
		closeSocket(socket)
		const visible = (canvas.json?.objects ?? []).some((object) => object.id === id)
		expect(
			settled.outcome === 'open' && write.status === 200 && visible,
			`socketAfterRestore=${settled.outcome} write=${write.status} visibleToOtherUser=${visible}`
		)
	})
}

async function phaseUploads() {
	const uploadId = `acceptance-${randomBytes(4).toString('hex')}.txt`
	const payload = Buffer.from(`acceptance upload ${new Date().toISOString()}\n`)
	const octet = { raw: true, headers: { 'content-type': 'application/octet-stream' } }

	await check('H1', 'uploads', 'app-authz', 'a member with write access can upload an asset', async () => {
		const response = await users.editor.client.post(`/api/boards/${BOARD}/uploads/${uploadId}`, payload, octet)
		expect(response.status === 200, `status=${response.status} body=${redact(response.text.slice(0, 120))}`)
	})

	await check('H2', 'uploads', 'app-authz', 'a member can retrieve the asset and gets the same bytes back', async () => {
		const response = await users.viewer.client.get(`/api/boards/${BOARD}/assets/${uploadId}`)
		expect(
			response.status === 200 && response.text === payload.toString('utf8'),
			`status=${response.status} bytesMatch=${response.text === payload.toString('utf8')}`
		)
	})

	await check('H3', 'uploads', 'app-authz', 'a non-member cannot retrieve a board asset', async () => {
		const response = await users.outsider.client.get(`/api/boards/${BOARD}/assets/${uploadId}`)
		expect(response.status === 403 || response.status === 404, `status=${response.status}`)
	})

	await check('H4', 'uploads', 'app-authz', 'an asset is scoped to its board and is not readable through another', async () => {
		const response = await users.owner.client.get(`/api/boards/demo/assets/${uploadId}`)
		expect(response.status >= 400, `statusThroughUnrelatedBoard=${response.status}`)
	})

	await check('H5', 'uploads', 'app-validation', 'a traversal-shaped upload id is rejected', async () => {
		const response = await users.editor.client.post(`/api/boards/${BOARD}/uploads/..%2F..%2Fescape.txt`, payload, octet)
		expect(response.status >= 400, `status=${response.status}`)
	})

	await check('H6', 'uploads', 'app-validation', 'an existing upload id cannot be overwritten', async () => {
		const response = await users.editor.client.post(`/api/boards/${BOARD}/uploads/${uploadId}`, Buffer.from('different'), octet)
		expect(response.status === 409, `status=${response.status}`)
	})
}

async function phaseOrigin() {
	await check('I1', 'origin', 'app-origin', 'a cross-origin mutation is refused in production', async () => {
		const response = await users.owner.client.post(
			`/api/rooms/${BOARD}/actions`,
			{ actions: [{ tool: 'create_text', id: 'shape:cross-origin', text: 'no', x: 0, y: 0 }] },
			{ origin: 'https://evil.example' }
		)
		expect(response.status === 403, `status=${response.status}`)
	})

	await check('I2', 'origin', 'app-origin', 'a cross-origin login attempt is refused', async () => {
		const probe = new Client('cross-origin-login')
		const response = await probe.post('/api/auth/login',
			{ login: users.owner.login, password: users.owner.password },
			{ origin: 'https://evil.example' })
		expect(response.status === 403 && !probe.jar.has('canvas_session'), `status=${response.status} sessionIssued=${probe.jar.has('canvas_session')}`)
	})

	await check('I3', 'origin', 'ws-authz', 'a WebSocket upgrade from a foreign origin is refused', async () => {
		const handle = openSocket(users.owner.client, BOARD, { origin: 'https://evil.example' })
		const settled = await handle.settled
		closeSocket(handle)
		expect(settled.outcome !== 'open', `outcome=${settled.outcome} status=${settled.status ?? ''} code=${settled.code ?? ''}`)
	})

	await check('I4', 'origin', 'app-validation', 'a malformed action payload is refused by schema validation', async () => {
		const response = await users.owner.client.post(`/api/rooms/${BOARD}/actions`, { actions: [{ tool: 'not_a_real_tool', id: 'shape:x' }] })
		// Zod validation errors use 422; a route-level validator may use 400.
		expect(response.status === 400 || response.status === 422, `status=${response.status}`)
	})

	await check('I5', 'origin', 'app-auth', 'a machine Bearer token is not accepted in place of a user session', async () => {
		const probe = new Client('fake-bearer')
		const response = await probe.get('/api/boards', { headers: { authorization: `Bearer ${randomBytes(32).toString('base64url')}` } })
		expect(response.status === 401 || response.status === 403, `status=${response.status}`)
	})
}

/* ====================================================================== run = */

async function main() {
	console.log(`public acceptance against ${BASE}`)
	console.log(`board: ${BOARD}`)
	console.log(`started: ${new Date().toISOString()}\n`)

	await phaseEdge()
	await phaseAccessIsNotAppAuth()
	const haveAccounts = await phaseAccounts()

	if (haveAccounts) {
		await phaseBoardAndInvitations()
		await phaseRbac()
		await phaseCollaboration()
		await phaseHistory()
		await phaseUploads()
		await phaseOrigin()
	} else {
		console.log('\nAccount-dependent phases were skipped: no account invitations were supplied.')
	}

	const tally = results.reduce((counts, row) => {
		counts[row.status] = (counts[row.status] ?? 0) + 1
		return counts
	}, {})

	console.log(`\n${'='.repeat(70)}`)
	console.log(`attempted: ${results.length}`)
	for (const status of ['PASS', 'FAIL', 'BLOCKED', 'SKIP']) {
		if (tally[status]) console.log(`${status}: ${tally[status]}`)
	}

	const evidence = {
		runAt: new Date().toISOString(),
		base: BASE,
		board: BOARD,
		note: 'Every request in this run crossed the public Internet and Cloudflare Access. No credential values are recorded.',
		identities: Object.values(users).map((user) => ({ role: user.key, displayName: user.displayName, loginShape: '<label>-<random>@acceptance.invalid' })),
		tally,
		checks: results.map((row) => ({ ...row, detail: redact(row.detail) })),
	}
	const out = process.env.ACCEPTANCE_OUT ?? `/tmp/public-acceptance-${new Date().toISOString().slice(0, 10)}.json`
	writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`)
	console.log(`evidence: ${out}`)

	process.exit(tally.FAIL ? 1 : 0)
}

await main()
