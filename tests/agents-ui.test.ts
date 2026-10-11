/**
 * The People & Agents browser experience (client/agents/) against the fixed Step 3 backend contract.
 *
 * There is no DOM test library in this project, so the page is built from pure, testable parts and checked four ways:
 *   1. the model: presets, expiry arithmetic, validation, wording, and the one-time-token reducer;
 *   2. the API client against a stubbed fetch, with tripwires on storage and the console;
 *   3. a contract test that runs the real client against the real server (buildApp), so a change on either side that
 *      breaks the other fails here;
 *   4. static renders of each component, plus source-level guards for the things that must never appear.
 * The interactive flows themselves were also driven in a real browser; see the commit message.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { matchRoutes } from 'react-router-dom'
import { StaticRouter } from 'react-router-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentList } from '../client/agents/AgentList'
import { AgentsPage } from '../client/agents/AgentsPage'
import { CreateAgentForm } from '../client/agents/CreateAgentForm'
import { SetupChecklist } from '../client/agents/SetupChecklist'
import { TokenDialog } from '../client/agents/TokenDialog'
import { createAgent, listAgents, listOwnedBoards, revokeAgent, rotateAgent } from '../client/agents/agents-api'
import {
	ACCESS_LEVELS,
	DEFAULT_EXPIRY,
	EXPIRY_CHOICES,
	INITIAL_CREATE_FORM,
	RESTORE_WARNING,
	chooseAccess,
	agentTitle,
	describeStatus,
	expiresAtFor,
	friendlyError,
	isDangerous,
	onPageHide,
	rotateExpiry,
	rotationNeedsExpiry,
	tokenReducer,
	validateCreate,
	type Agent,
	type CreateForm,
	type RevealedToken,
} from '../client/agents/agents-model'
import { ApiError, AuthContext, type AuthContextValue } from '../client/auth'
import { Dashboard } from '../client/pages/Dashboard'
import { appRoutes } from '../client/routes'
import { ACCESS_MODES } from '../server/token-store.mjs'
import { authorizeApiToken } from '../server/tokens'
import { createAcceptanceFixture, type AcceptanceFixture, type FixtureIdentity, type HttpMethod } from './helpers/acceptance-fixture'

const NOW = new Date(2026, 9, 8, 12, 0, 0).getTime()
const DAY = 86_400_000
const html = (element: ReactElement) => renderToStaticMarkup(element)
const inRouter = (element: ReactElement, location = '/agents') => html(createElement(StaticRouter, { location }, element))

const TOKEN = 'T0kenForTestsOnly_abcdefghijklmnopqrstuvwxyz0123456'
const REF = 'agent-aaaaaaaaaaaa.0123456789abcdef'

function agent(overrides: Partial<Agent> = {}): Agent {
	return {
		ref: REF, name: 'agent-aaaaaaaaaaaa', displayName: 'Claude, Chibi notes', permissions: ['read', 'write'], rooms: ['board-one'],
		sharedWithOtherBoards: false, createdAt: '2026-10-01T00:00:00.000Z', status: 'none', createdByYou: true, ...overrides,
	}
}

/* ------------------------------------------------------------------------- model -- */

describe('access levels', () => {
	it('grant exactly what the server grants for the same preset: the page and the API cannot drift apart', () => {
		expect([...ACCESS_LEVELS.map((level) => level.value)].sort()).toEqual(Object.keys(ACCESS_MODES).sort())
		for (const level of ACCESS_LEVELS) expect([...level.permissions], level.value).toEqual([...ACCESS_MODES[level.value]])
	})

	it('flag restore, and only restore, as needing an explicit acknowledgement', () => {
		const withRestore = ACCESS_LEVELS.filter((level) => level.permissions.includes('restore'))

		expect(withRestore.map((level) => level.value)).toEqual(['full'])
		expect(ACCESS_LEVELS.filter((level) => level.dangerous).map((level) => level.value)).toEqual(['full'])
		expect(isDangerous('full')).toBe(true)
		for (const level of ACCESS_LEVELS.filter((candidate) => candidate.value !== 'full')) expect(isDangerous(level.value), level.value).toBe(false)
	})

	it('lead with the safest choice', () => {
		expect(ACCESS_LEVELS[0].value).toBe('read')
		expect(INITIAL_CREATE_FORM.access).toBe('read')
	})
})

describe('expiry', () => {
	it('defaults a new agent to an expiry, not to none', () => {
		expect(DEFAULT_EXPIRY).toBe('90d')
		expect(INITIAL_CREATE_FORM.expiry).toBe('90d')
	})

	it('produces no expiresAt for "no expiry", and exact UTC timestamps for the relative choices', () => {
		expect(expiresAtFor('never', '', NOW)).toEqual({ ok: true })
		for (const [choice, days] of [['7d', 7], ['30d', 30], ['90d', 90], ['365d', 365]] as const) {
			expect(expiresAtFor(choice, '', NOW), choice).toEqual({ ok: true, expiresAt: new Date(NOW + days * DAY).toISOString() })
		}
	})

	it('takes a chosen date as the end of that day in the owner\'s time zone', () => {
		const result = expiresAtFor('custom', '2026-12-31', NOW)

		expect(result).toEqual({ ok: true, expiresAt: new Date(2026, 11, 31, 23, 59, 59).toISOString() })
	})

	it('refuses a missing, impossible or past date with a message a person can act on', () => {
		for (const custom of ['', 'soon', '2026-13-01', '2026-02-30', '31/12/2026']) {
			const result = expiresAtFor('custom', custom, NOW)
			expect(result.ok, custom).toBe(false)
		}
		const past = expiresAtFor('custom', '2026-10-07', NOW)
		expect(past).toEqual({ ok: false, message: 'Choose a date in the future.' })
	})

	it('offers every relative choice plus a custom date and "no expiry"', () => {
		expect(EXPIRY_CHOICES.map((choice) => choice.value)).toEqual(['7d', '30d', '90d', '365d', 'custom', 'never'])
	})

	it('lets a rotation keep or replace an expiry, but not remove one', () => {
		expect(rotateExpiry('keep', '', NOW)).toEqual({ ok: true })
		expect(rotateExpiry('30d', '', NOW)).toEqual({ ok: true, expiresAt: new Date(NOW + 30 * DAY).toISOString() })
		expect(rotateExpiry('custom', '', NOW).ok).toBe(false)
	})

	it('requires a new expiry to rotate an agent that has expired or whose expiry is unreadable', () => {
		expect(rotationNeedsExpiry({ status: 'expired' })).toBe(true)
		expect(rotationNeedsExpiry({ status: 'invalid' })).toBe(true)
		expect(rotationNeedsExpiry({ status: 'active' })).toBe(false)
		expect(rotationNeedsExpiry({ status: 'none' })).toBe(false)
	})
})

describe('the create form', () => {
	const form = (overrides: Partial<CreateForm> = {}): CreateForm => ({ ...INITIAL_CREATE_FORM, displayName: 'Claude', ...overrides })

	it('builds the exact request the API expects', () => {
		expect(validateCreate(form(), NOW)).toEqual({ ok: true, input: { displayName: 'Claude', access: 'read', expiresAt: new Date(NOW + 90 * DAY).toISOString() } })
		expect(validateCreate(form({ expiry: 'never', access: 'read-write' }), NOW)).toEqual({ ok: true, input: { displayName: 'Claude', access: 'read-write' } })
	})

	it('trims the name and bounds it to what the server accepts', () => {
		expect(validateCreate(form({ displayName: '  Claude  ' }), NOW)).toMatchObject({ ok: true, input: { displayName: 'Claude' } })
		expect(validateCreate(form({ displayName: '   ' }), NOW).ok).toBe(false)
		expect(validateCreate(form({ displayName: 'x'.repeat(81) }), NOW).ok).toBe(false)
		expect(validateCreate(form({ displayName: 'x'.repeat(80) }), NOW).ok).toBe(true)
		expect(validateCreate(form({ displayName: 'bell\u0007' }), NOW).ok).toBe(false)
	})

	it('will not create a restore-capable agent until the owner has acknowledged what that allows', () => {
		const refused = validateCreate(form({ access: 'full' }), NOW)
		const accepted = validateCreate(form({ access: 'full', restoreAcknowledged: true }), NOW)

		expect(refused).toEqual({ ok: false, message: 'Confirm that you understand what restore access allows.' })
		expect(accepted).toMatchObject({ ok: true, input: { access: 'full' } })
		expect(validateCreate(form({ access: 'read', restoreAcknowledged: true }), NOW).ok).toBe(true)
	})

	it('clears the restore acknowledgement whenever the access level is chosen, even the same one again', () => {
		const ticked = form({ access: 'full', restoreAcknowledged: true })

		expect(chooseAccess(ticked, 'read')).toMatchObject({ access: 'read', restoreAcknowledged: false })
		expect(chooseAccess(ticked, 'full')).toMatchObject({ access: 'full', restoreAcknowledged: false })
		expect(validateCreate(chooseAccess(ticked, 'full'), NOW).ok).toBe(false)
		expect(chooseAccess(form({ displayName: 'Kept' }), 'write').displayName).toBe('Kept')
	})

	it('surfaces an expiry problem rather than sending a bad request', () => {
		expect(validateCreate(form({ expiry: 'custom', customDate: '' }), NOW).ok).toBe(false)
		expect(validateCreate(form({ expiry: 'custom', customDate: '2020-01-01' }), NOW).ok).toBe(false)
	})
})

describe('how an agent is described', () => {
	it('identifies it by display name, falling back to its stored name only when it never had one', () => {
		expect(agentTitle({ displayName: 'Claude', name: 'agent-aaaaaaaaaaaa' })).toBe('Claude')
		expect(agentTitle({ name: 'alice-ai' })).toBe('alice-ai')
		expect(agentTitle({ displayName: '   ', name: 'alice-ai' })).toBe('alice-ai')
	})

	it('words each expiry state, and warns when expiry is close', () => {
		expect(describeStatus({ status: 'none' }, NOW)).toEqual({ tone: 'neutral', label: 'No expiry' })
		expect(describeStatus({ status: 'active', expiresAt: new Date(NOW + 30 * DAY).toISOString() }, NOW)).toMatchObject({ tone: 'ok' })
		expect(describeStatus({ status: 'active', expiresAt: new Date(NOW + 2 * DAY).toISOString() }, NOW)).toMatchObject({ tone: 'warn' })
		expect(describeStatus({ status: 'expired', expiresAt: new Date(NOW - DAY).toISOString() }, NOW)).toMatchObject({ tone: 'bad' })
		expect(describeStatus({ status: 'expired', expiresAt: new Date(NOW - DAY).toISOString() }, NOW).label).toMatch(/^Expired /)
		expect(describeStatus({ status: 'invalid' }, NOW)).toMatchObject({ tone: 'bad', label: expect.stringContaining('rotate') })
	})
})

describe('error wording', () => {
	it('turns the server\'s statuses into plain language, keeping messages that were already written for people', () => {
		expect(friendlyError(new ApiError('x', 401), 'fallback')).toMatch(/sign in again/i)
		expect(friendlyError(new ApiError('x', 429), 'fallback')).toMatch(/wait a few minutes/i)
		expect(friendlyError(new ApiError('x', 404), 'fallback')).toMatch(/no longer exists/)
		expect(friendlyError(new ApiError('This agent changed after you loaded it.', 409), 'fallback')).toBe('This agent changed after you loaded it.')
		expect(friendlyError(new ApiError('Expiry must be in the future', 422), 'fallback')).toBe('Expiry must be in the future')
		expect(friendlyError(new ApiError('being changed by another operation', 503), 'fallback')).toBe('being changed by another operation')
		expect(friendlyError(new ApiError('Internal server error', 500), 'Could not rotate.')).toBe('Could not rotate.')
		expect(friendlyError('not an error', 'fallback')).toBe('fallback')
	})
})

describe('the one-time token', () => {
	const revealed: RevealedToken = { kind: 'created', agentTitle: 'Claude', boardName: 'Board', token: TOKEN }

	it('is held only between "reveal" and the dialog closing', () => {
		expect(tokenReducer(null, { type: 'reveal', revealed })).toBe(revealed)
		expect(tokenReducer(revealed, { type: 'dismiss' })).toBeNull()
	})

	it('is dropped when the page is hidden or frozen, so a back/forward-cached page keeps no live token', () => {
		expect(tokenReducer(revealed, { type: 'pagehide' })).toBeNull()
	})

	it('is dropped by the page itself: the listener hears pagehide and stops when told to', () => {
		const target = new EventTarget()
		let hidden = 0
		const stop = onPageHide(target, () => { hidden += 1 })

		target.dispatchEvent(new Event('pagehide'))
		target.dispatchEvent(new Event('visibilitychange'))
		stop()
		target.dispatchEvent(new Event('pagehide'))

		expect(hidden).toBe(1)
	})

	it('is replaced, never accumulated, by a second reveal', () => {
		const next: RevealedToken = { ...revealed, kind: 'rotated', token: 'another-token-value-0000000000000000000000' }

		const state = tokenReducer(tokenReducer(null, { type: 'reveal', revealed }), { type: 'reveal', revealed: next })

		expect(state).toBe(next)
		expect(JSON.stringify(state)).not.toContain(TOKEN)
	})

	it('leaves no trace in the state once dismissed', () => {
		const state = tokenReducer(tokenReducer(null, { type: 'reveal', revealed }), { type: 'dismiss' })

		expect(JSON.stringify(state)).toBe('null')
	})
})

/* ------------------------------------------------------------- api client, stubbed -- */

describe('the API client', () => {
	const calls: Array<{ url: string; init: RequestInit }> = []

	function stub(reply: (url: string, init: RequestInit) => { status?: number; body?: unknown }) {
		vi.stubGlobal('fetch', async (input: string, init: RequestInit = {}) => {
			calls.push({ url: String(input), init })
			const { status = 200, body = {} } = reply(String(input), init)
			return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
		})
	}

	beforeEach(() => { calls.length = 0 })
	afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

	it('lists only boards the person owns and that are not deleted', async () => {
		stub(() => ({ body: { boards: [
			{ id: 'mine', name: 'Mine', role: 'owner' },
			{ id: 'deleted', name: 'Deleted', role: 'owner', deletedAt: 1 },
			{ id: 'shared', name: 'Shared', role: 'editor' },
			{ id: 'watching', name: 'Watching', role: 'viewer' },
		] } }))

		expect(await listOwnedBoards()).toEqual([{ id: 'mine', name: 'Mine' }])
		expect(calls[0].url).toBe('/api/boards')
	})

	it('speaks the Step 3 contract: paths, methods and bodies', async () => {
		stub((url) => ({ body: url.includes('?boardId=') ? { agents: [] } : { agent: agent(), token: TOKEN } }))

		await listAgents('board one/1')
		await createAgent({ boardId: 'board-one', displayName: 'Claude', access: 'read-write', expiresAt: '2027-01-01T00:00:00.000Z' })
		await rotateAgent(REF)
		await rotateAgent(REF, '2027-06-01T00:00:00.000Z')
		await revokeAgent(REF)

		expect(calls.map((call) => `${call.init.method ?? 'GET'} ${call.url}`)).toEqual([
			'GET /api/agent-access?boardId=board%20one%2F1',
			'POST /api/agent-access',
			`POST /api/agent-access/${encodeURIComponent(REF)}/rotate`,
			`POST /api/agent-access/${encodeURIComponent(REF)}/rotate`,
			`DELETE /api/agent-access/${encodeURIComponent(REF)}`,
		])
		expect(JSON.parse(String(calls[1].init.body))).toEqual({ boardId: 'board-one', displayName: 'Claude', access: 'read-write', expiresAt: '2027-01-01T00:00:00.000Z' })
		expect(JSON.parse(String(calls[2].init.body))).toEqual({})
		expect(JSON.parse(String(calls[3].init.body))).toEqual({ expiresAt: '2027-06-01T00:00:00.000Z' })
	})

	it('authenticates with the session cookie only: no Authorization header is ever set', async () => {
		stub(() => ({ body: { agents: [], agent: agent(), token: TOKEN } }))

		await listAgents('b'); await createAgent({ boardId: 'b', displayName: 'x', access: 'read' }); await rotateAgent(REF); await revokeAgent(REF)

		for (const call of calls) {
			expect(new Headers(call.init.headers).has('authorization'), call.url).toBe(false)
			expect(call.init.credentials).toBe('same-origin')
		}
	})

	it('hands the token back to the caller and leaves nothing behind: no storage, no console, nothing else', async () => {
		const trap = (name: string) => new Proxy({}, { get() { throw new Error(`${name} was touched`) }, set() { throw new Error(`${name} was written`) } })
		vi.stubGlobal('localStorage', trap('localStorage'))
		vi.stubGlobal('sessionStorage', trap('sessionStorage'))
		const spies = (['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => {}))
		stub(() => ({ body: { agent: agent(), token: TOKEN } }))

		const created = await createAgent({ boardId: 'b', displayName: 'x', access: 'read' })
		const rotated = await rotateAgent(REF)

		expect(created.token).toBe(TOKEN)
		expect(rotated.token).toBe(TOKEN)
		for (const spy of spies) expect(spy).not.toHaveBeenCalled()
	})

	it('raises the server\'s status so the page can react to it', async () => {
		stub(() => ({ status: 409, body: { error: 'This agent changed after you loaded it. Reload the list and try again.' } }))

		const failure = await rotateAgent(REF).catch((error) => error)

		expect(failure).toBeInstanceOf(ApiError)
		expect(failure.status).toBe(409)
		expect(friendlyError(failure, 'x')).toMatch(/changed after you loaded it/)
	})
})

/* ------------------------------------------- the real client against the real server -- */

describe('the client and the server agree (contract)', () => {
	let f: AcceptanceFixture
	let directory: string

	function actAs(identity: FixtureIdentity) {
		vi.stubGlobal('fetch', async (input: string, init: RequestInit = {}) => {
			const payload = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
			const response = await identity.request((init.method ?? 'GET') as HttpMethod, String(input), payload)
			return new Response(response.statusCode === 204 ? null : response.body, { status: response.statusCode, headers: { 'content-type': String(response.headers['content-type'] ?? 'application/json') } })
		})
	}

	beforeEach(async () => {
		f = await createAcceptanceFixture()
		directory = mkdtempSync(join(tmpdir(), 'agents-ui-contract-'))
		process.env.CANVAS_API_TOKENS_FILE = join(directory, 'api-tokens.json')
	})
	afterEach(async () => {
		vi.unstubAllGlobals()
		await f.cleanup()
		rmSync(directory, { recursive: true, force: true })
	})

	it('runs the whole owner journey: boards, create, list, rotate, revoke', async () => {
		actAs(f.owner)

		const boards = await listOwnedBoards()
		expect(boards).toEqual([{ id: f.boardId, name: 'Acceptance board' }])

		const created = await createAgent({ boardId: f.boardId, displayName: 'Claude, Chibi notes', access: 'read-write', expiresAt: new Date(Date.now() + 30 * DAY).toISOString() })
		expect(created.agent).toMatchObject({ displayName: 'Claude, Chibi notes', permissions: ['read', 'write'], rooms: [f.boardId], status: 'active', createdByYou: true })
		expect(authorizeApiToken(`Bearer ${created.token}`, f.boardId, 'write')).toBe(created.agent.name)

		const listed = await listAgents(f.boardId)
		expect(listed).toHaveLength(1)
		expect(listed[0].ref).toBe(created.agent.ref)

		const rotated = await rotateAgent(listed[0].ref)
		expect(rotated.token).not.toBe(created.token)
		expect(authorizeApiToken(`Bearer ${created.token}`, f.boardId, 'write')).toBeNull()
		expect(authorizeApiToken(`Bearer ${rotated.token}`, f.boardId, 'write')).toBe(created.agent.name)
		expect(rotated.agent.ref).not.toBe(created.agent.ref)
		expect((await listAgents(f.boardId))[0].ref).toBe(rotated.agent.ref)

		await revokeAgent(rotated.agent.ref)
		expect(authorizeApiToken(`Bearer ${rotated.token}`, f.boardId, 'write')).toBeNull()
		expect(await listAgents(f.boardId)).toEqual([])
	})

	it('shows the people-facing fields the page relies on, and never a hash or a token', async () => {
		actAs(f.owner)
		const created = await createAgent({ boardId: f.boardId, displayName: 'Claude', access: 'read' })

		const [entry] = await listAgents(f.boardId)

		expect(Object.keys(entry).sort()).toEqual(['createdAt', 'createdByYou', 'name', 'displayName', 'permissions', 'ref', 'rooms', 'sharedWithOtherBoards', 'status'].sort())
		expect(JSON.stringify(entry)).not.toContain(created.token)
		expect(JSON.stringify(entry)).not.toMatch(/tokenHash|hash/i)
	})

	it('reports a stale reference the way the page expects: 409 with a message worth showing', async () => {
		actAs(f.owner)
		const created = await createAgent({ boardId: f.boardId, displayName: 'Claude', access: 'read' })
		await rotateAgent(created.agent.ref)

		const failure = await rotateAgent(created.agent.ref).catch((error) => error)

		expect(failure).toBeInstanceOf(ApiError)
		expect(failure.status).toBe(409)
		expect(friendlyError(failure, 'x')).toMatch(/changed after you loaded/)
	})

	it('treats a revoked or unknown agent as 404, and gives people who own no whiteboard an empty list', async () => {
		actAs(f.owner)
		const created = await createAgent({ boardId: f.boardId, displayName: 'Claude', access: 'read' })
		await revokeAgent(created.agent.ref)

		const gone = await revokeAgent(created.agent.ref).catch((error) => error)
		expect(gone.status).toBe(404)

		for (const member of [f.editor, f.viewer]) {
			actAs(member)
			expect(await listOwnedBoards(), member.role).toEqual([])
		}
	})

	it('lets only the owner in: members who are not owners are refused with the statuses the page words', async () => {
		for (const [identity, status] of [[f.editor, 403], [f.viewer, 403], [f.nonmember, 404]] as const) {
			actAs(identity)
			const failure = await listAgents(f.boardId).catch((error) => error)
			expect(failure.status, identity.role).toBe(status)
		}
	})

	it('surfaces the restore preset, and the server accepts exactly the values the page can send', async () => {
		actAs(f.owner)

		for (const level of ACCESS_LEVELS) {
			const result = await createAgent({ boardId: f.boardId, displayName: level.label, access: level.value })
			expect(result.agent.permissions, level.value).toEqual([...level.permissions])
		}
	})
})

/* ---------------------------------------------------------------- static renders -- */

describe('the token dialog', () => {
	const revealed: RevealedToken = { kind: 'created', agentTitle: 'Claude', boardName: 'Chibi board', token: TOKEN }

	it('shows the token once, as plain text, with the instructions that matter', () => {
		const out = html(createElement(TokenDialog, { revealed, onDismiss: () => {} }))

		expect(out.split(TOKEN).length - 1).toBe(1)
		expect(out).toContain(`<code class="aw-token-value">${TOKEN}</code>`)
		expect(out).toMatch(/shown only once/)
		expect(out).toContain('role="dialog"')
		expect(out).toContain('aria-modal="true"')
		expect(out).toContain('WHITEBOARD_TOKEN')
		expect(out).toContain('Claude')
		expect(out).toContain('Chibi board')
	})

	it('is not an input, so password managers and autofill never capture it, and never an attribute or a link', () => {
		const out = html(createElement(TokenDialog, { revealed, onDismiss: () => {} }))

		expect(out).not.toMatch(/<input|<textarea/)
		expect(out).not.toMatch(new RegExp(`(value|href|src|data-[a-z-]+|aria-[a-z]+|title|placeholder)="[^"]*${TOKEN}`))
	})

	it('says that a rotated token replaces one that has already stopped working', () => {
		const out = html(createElement(TokenDialog, { revealed: { ...revealed, kind: 'rotated' }, onDismiss: () => {} }))

		expect(out).toContain('New token issued')
		expect(out).toMatch(/previous token has already stopped working/)
	})
})

describe('the create form, as first shown', () => {
	const render = (initial?: Partial<CreateForm>, busy = false) => html(createElement(CreateAgentForm, { boardName: 'Chibi board', busy, onCreate: () => {}, initial, now: NOW }))

	it('offers every access level with plain-language wording, starting on the safest', () => {
		const out = render()

		for (const level of ACCESS_LEVELS) { expect(out).toContain(level.label); expect(out).toContain(level.summary) }
		expect((out.match(/type="radio"/g) ?? []).length).toBe(ACCESS_LEVELS.length)
		expect(out).toContain('<input type="radio" name="access" checked="" value="read"/>')
		expect(out).not.toContain(RESTORE_WARNING)
	})

	it('defaults the expiry to 90 days and explains what no expiry means when it is chosen', () => {
		expect(render()).toMatch(/<option value="90d" selected="">90 days<\/option>/)
		expect(render({ expiry: 'never' })).toContain('stays valid until you revoke it')
		expect(render({ expiry: 'custom' })).toContain('type="date"')
	})

	it('puts the explicit restore warning in front of anyone choosing full access, and blocks creating until it is acknowledged', () => {
		const blocked = render({ access: 'full' })
		const allowed = render({ access: 'full', restoreAcknowledged: true })

		expect(blocked).toContain(RESTORE_WARNING)
		expect(blocked).toContain('role="alert"')
		expect(blocked).toMatch(/<input type="checkbox"(?![^>]*checked)/)
		expect(blocked).toMatch(/<button class="aw-primary-button" disabled="">Create access<\/button>/)
		expect(allowed).toMatch(/<input type="checkbox"[^>]*checked=""/)
		expect(allowed).toMatch(/<button class="aw-primary-button">Create access<\/button>/)
	})

	it('shows progress while creating', () => {
		expect(render(undefined, true)).toMatch(/disabled="">Creating…<\/button>/)
	})
})

describe('the agent list', () => {
	const noop = () => {}
	const list = (agents: Agent[], pending: Parameters<typeof AgentList>[0]['pending'] = null) =>
		html(createElement(AgentList, { agents, busy: false, pending, onStart: noop, onCancel: noop, onRotate: noop, onRevoke: noop, now: NOW }))

	it('identifies an agent by its display name, with its scopes and expiry in words', () => {
		const out = list([agent({ permissions: ['read', 'write', 'history', 'restore'], status: 'active', expiresAt: new Date(NOW + 30 * DAY).toISOString() })])

		expect(out).toContain('Claude, Chibi notes')
		for (const label of ['Read', 'Edit', 'History', 'Restore']) expect(out).toContain(`>${label}</span>`)
		expect(out).toMatch(/Expires /)
		expect(out).toContain('Created ')
		expect(out).toContain(' by you')
	})

	it('never puts the opaque reference, the fingerprint, the stored name or any hash on the page', () => {
		const out = list([agent()])

		expect(out).not.toContain(REF)
		expect(out).not.toContain('0123456789abcdef')
		expect(out).not.toContain('agent-aaaaaaaaaaaa')
		expect(out).not.toMatch(/fingerprint|tokenHash|hash|data-ref/i)
	})

	it('falls back to the stored name only for an agent that never had a display name', () => {
		const out = list([agent({ displayName: undefined, name: 'alice-ai', ref: 'alice-ai.0123456789abcdef' })])

		expect(out).toContain('alice-ai')
		expect(out).not.toContain('0123456789abcdef')
	})

	it('disables rotate and revoke, and says why, for an agent that also reaches boards the viewer does not own', () => {
		const out = list([agent({ sharedWithOtherBoards: true })])

		expect(out).toContain('only an administrator can rotate or revoke it')
		expect((out.match(/disabled=""/g) ?? []).length).toBe(2)
	})

	it('asks before revoking, in words that say what happens', () => {
		const out = list([agent()], { kind: 'revoke', ref: REF })

		expect(out).toContain('role="alertdialog"')
		expect(out).toMatch(/stops working immediately and cannot be switched back on/)
		expect(out).toContain('Revoke access')
	})

	it('explains rotation before doing it, and offers to keep the current expiry', () => {
		const out = list([agent({ status: 'active', expiresAt: new Date(NOW + 30 * DAY).toISOString() })], { kind: 'rotate', ref: REF })

		expect(out).toMatch(/current token stops working immediately/)
		expect(out).toContain('Keep the current expiry')
	})

	it('insists on a new expiry when rotating an agent that has expired', () => {
		const out = list([agent({ status: 'expired', expiresAt: new Date(NOW - DAY).toISOString() })], { kind: 'rotate', ref: REF })

		expect(out).toContain('choose a new expiry')
		expect(out).not.toContain('Keep the current expiry')
		expect(out).not.toContain('Keep it with no expiry')
	})
})

describe('the Cloudflare setup checklist', () => {
	const out = inRouter(createElement(SetupChecklist, { boardId: 'chibi-board-id', boardName: 'Chibi board' }))

	it('names every value the agent needs, and where each comes from, without holding any secret', () => {
		for (const name of ['CF_ACCESS_CLIENT_ID', 'CF_ACCESS_CLIENT_SECRET', 'WHITEBOARD_TOKEN', 'WHITEBOARD_API_BASE', 'WHITEBOARD_BOARD_ID']) expect(out).toContain(name)
		expect(out).toContain('chibi-board-id')
		expect(out).toMatch(/administrator/)
		expect(out).toMatch(/Never paste them into a chat, a document or Git/)
	})

	it('links to the Agent API guide, and does not manage Cloudflare itself', () => {
		expect(out).toContain('href="/help/agent-api"')
		expect(out).toMatch(/only manages the whiteboard token/)
		expect(out).not.toMatch(/<input|<form/)
	})
})

describe('the page', () => {
	const user = { id: 'u1', login: 'sam', displayName: 'Sam Example', createdAt: 0, updatedAt: 0, lastLoginAt: null }
	const auth: AuthContextValue = { user, session: null, isLoading: false, startupError: null, login: async () => {}, register: async () => {}, logout: async () => {}, refresh: async () => {} }
	const page = (element: ReactElement, location = '/agents') => html(createElement(AuthContext.Provider, { value: auth }, createElement(StaticRouter, { location }, element)))

	it('opens in a loading state with the explanation, the way back, and Help', () => {
		const out = page(createElement(AgentsPage))

		expect(out).toContain('<h1>Agent access</h1>')
		expect(out).toContain('Loading your whiteboards…')
		expect(out).toContain('href="/boards"')
		expect(out).toContain('href="/help"')
		expect(out).toMatch(/Only a whiteboard(?:'|&#x27;)s owner can do this/)
		expect(out).not.toContain('aw-token-dialog')
	})

	it('is linked from the dashboard header', () => {
		const out = page(createElement(Dashboard), '/boards')

		expect(out).toContain('<a class="aw-help-link" href="/agents">Agents</a>')
		expect(out).toContain('<a class="aw-help-link" href="/help">Help</a>')
	})
})

/* ---------------------------------------------------------------------- routing -- */

describe('routing', () => {
	const route = (path: string) => matchRoutes(appRoutes, path)

	it('serves /agents behind sign-in, and never mistakes it for a whiteboard', () => {
		const matches = route('/agents')!

		expect(matches[matches.length - 1].route.path).toBe('/agents')
		expect(matches.some((match) => match.route.children !== undefined)).toBe(true)
		expect(route('/room/agents')!.at(-1)!.route.path).toBe('/room/:roomId')
		expect(route('/boards')!.at(-1)!.route.path).toBe('/boards')
	})
})

/* ------------------------------------------------------------------ source guards -- */

describe('what the agent pages must never contain (source guards)', () => {
	const directory = join(__dirname, '..', 'client', 'agents')
	const files = readdirSync(directory).filter((name) => /\.(ts|tsx)$/.test(name))
	/** Code with comments removed, so a comment that explains the rule is not mistaken for breaking it. */
	function code(name: string): string {
		return readFileSync(join(directory, name), 'utf8')
			.replace(/\/\*[\s\S]*?\*\//g, '')
			.split('\n')
			.map((line) => line.replace(/(^|[^:'"`])\/\/.*$/, '$1'))
			.join('\n')
	}

	it('covers every file in the folder', () => {
		expect(files.sort()).toEqual(['AgentList.tsx', 'AgentsPage.tsx', 'CreateAgentForm.tsx', 'SetupChecklist.tsx', 'TokenDialog.tsx', 'agents-api.ts', 'agents-model.ts'])
	})

	it('never persists, logs or leaks anything: no storage, cookies, URL or history writes, console, beacons or popups', () => {
		const forbidden = /\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b|\bcaches\b|document\.cookie|\bconsole\b|history\.(push|replace)State|window\.history|\blocation\s*[.[]|setSearchParams|sendBeacon|postMessage|BroadcastChannel|XMLHttpRequest|window\.open|dangerouslySetInnerHTML|innerHTML|\beval\b/
		for (const name of files) expect(code(name), name).not.toMatch(forbidden)
	})

	it('navigates only to the sign-in page, never anywhere a token could ride along', () => {
		for (const name of files) {
			for (const call of code(name).matchAll(/\bnavigate\(([^)]*)\)/g)) expect(call[1], name).toMatch(/^'\/login'/)
		}
	})

	it('hands pagehide on the real window to the token reducer, so a frozen page never keeps a live token', () => {
		expect(code('AgentsPage.tsx')).toMatch(/onPageHide\(window,\s*\(\) => dispatchToken\(\{ type: 'pagehide' \}\)\)/)
	})

	it('never sets an Authorization header or reaches for the machine API', () => {
		for (const name of files) expect(code(name), name).not.toMatch(/Authorization|Bearer |\/api\/rooms|\/api\/boards\/[^'`]*\/(agents|checkpoints|restore)/i)
	})

	it('keeps Cloudflare credentials out of the product: nothing here reads or stores a service-token secret', () => {
		for (const name of files) expect(code(name), name).not.toMatch(/cf-access-client|CF_ACCESS_CLIENT_SECRET\s*[:=]/i)
	})
})
