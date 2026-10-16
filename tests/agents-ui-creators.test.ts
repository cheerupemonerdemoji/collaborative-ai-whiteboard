/**
 * The Agents page's "create new whiteboards" type: the model, the create form, the list, the one-time-token dialog,
 * the setup checklist, the API client, and a contract test that runs the real client against the real server.
 * Like tests/agents-ui.test.ts there is no DOM library: pure logic, static renders, and source-level guards.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { StaticRouter } from 'react-router-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentList } from '../client/agents/AgentList'
import { CreateAgentForm } from '../client/agents/CreateAgentForm'
import { SetupChecklist } from '../client/agents/SetupChecklist'
import { TokenDialog } from '../client/agents/TokenDialog'
import { createAgent, createBoardCreator, listBoardCreators, revokeAgent, rotateAgent } from '../client/agents/agents-api'
import {
	ACCESS_LEVELS,
	CREATOR_ACCESS_NOTE,
	CREATOR_DEFAULT_ACCESS,
	CREATOR_NOTICE,
	CREATOR_RESTORE_WARNING,
	INITIAL_CREATE_FORM,
	RESTORE_WARNING,
	chooseAccess,
	chooseCreator,
	validateCreate,
	type Agent,
	type CreateForm,
	type RevealedToken,
} from '../client/agents/agents-model'
import { ACCESS_MODES } from '../server/token-store.mjs'
import { authorizeApiToken } from '../server/tokens'
import { createAcceptanceFixture, type AcceptanceFixture, type FixtureIdentity, type HttpMethod } from './helpers/acceptance-fixture'

const NOW = Date.UTC(2026, 9, 14, 12, 0, 0)
const DAY = 86_400_000
const TOKEN = 'T'.repeat(43)
const html = (element: ReactElement) => renderToStaticMarkup(element)
const inRouter = (element: ReactElement) => html(createElement(StaticRouter, { location: '/agents' }, element))

const creatorAgent = (overrides: Partial<Agent> = {}): Agent => ({
	ref: 'agent-aaaaaaaaaaaa.0123456789abcdef',
	name: 'agent-aaaaaaaaaaaa',
	displayName: 'Planner',
	canCreateBoards: true,
	permissions: ['read', 'write', 'history'],
	rooms: [],
	sharedWithOtherBoards: false,
	createdAt: new Date(NOW - DAY).toISOString(),
	status: 'none',
	createdByYou: true,
	...overrides,
})

const form = (overrides: Partial<CreateForm> = {}): CreateForm => ({ ...INITIAL_CREATE_FORM, displayName: 'Planner', ...overrides })

describe('the read-write-history level', () => {
	it('is offered, matches the server exactly, and is not restore', () => {
		const level = ACCESS_LEVELS.find((candidate) => candidate.value === 'read-write-history')!
		expect([...level.permissions]).toEqual([...ACCESS_MODES['read-write-history']])
		expect(level.permissions).not.toContain('restore')
		expect(level.dangerous).not.toBe(true)
	})

	it('keeps restore behind the same elevated confirmation as before', () => {
		expect(ACCESS_LEVELS.filter((candidate) => candidate.dangerous).map((candidate) => candidate.value)).toEqual(['full'])
	})
})

describe('the access type', () => {
	it('uses the exact notice the owner must see', () => {
		expect(CREATOR_NOTICE).toBe('This lets the agent create new boards owned by your account. It does not give the agent access to your existing boards.')
	})

	it('defaults a board-creating agent to read, edit and history, and an existing-board agent to read only', () => {
		expect(CREATOR_DEFAULT_ACCESS).toBe('read-write-history')
		expect(chooseCreator(INITIAL_CREATE_FORM, true)).toMatchObject({ creator: true, access: 'read-write-history' })
		expect(chooseCreator(chooseCreator(INITIAL_CREATE_FORM, true), false)).toMatchObject({ creator: false, access: 'read' })
		expect(INITIAL_CREATE_FORM.creator).toBe(false)
	})

	it('clears the restore acknowledgement whenever the type changes, in both directions', () => {
		const ticked = { ...chooseAccess(chooseCreator(INITIAL_CREATE_FORM, true), 'full'), restoreAcknowledged: true }
		expect(chooseCreator(ticked, false).restoreAcknowledged).toBe(false)
		expect(chooseCreator(ticked, true).restoreAcknowledged).toBe(false)
	})

	it('marks a creator submission, and leaves an existing-board submission exactly as it was', () => {
		const expires = new Date(NOW + 90 * DAY).toISOString()
		expect(validateCreate(form({ creator: true, access: 'read-write-history' }), NOW)).toEqual({ ok: true, input: { displayName: 'Planner', access: 'read-write-history', expiresAt: expires, creator: true } })
		const existing = validateCreate(form({ access: 'read' }), NOW)
		expect(existing).toEqual({ ok: true, input: { displayName: 'Planner', access: 'read', expiresAt: expires } })
		expect(JSON.stringify(existing)).not.toContain('creator')
	})

	it('still needs the explicit restore acknowledgement for a creator, and takes it from nowhere else', () => {
		const refused = validateCreate(form({ creator: true, access: 'full' }), NOW)
		expect(refused.ok).toBe(false)
		expect(validateCreate(form({ creator: true, access: 'full', restoreAcknowledged: true }), NOW)).toMatchObject({ ok: true, input: { access: 'full', creator: true } })
		// an acknowledgement given on the other type cannot be carried over by switching
		expect(validateCreate(chooseCreator({ ...form({ access: 'full' }), restoreAcknowledged: true }, true), NOW).ok).toBe(true) // reset to the safe default
		expect(validateCreate(chooseAccess(chooseCreator({ ...form({ access: 'full' }), restoreAcknowledged: true }, true), 'full'), NOW).ok).toBe(false)
	})
})

describe('the create form for a board-creating agent', () => {
	const render = (initial?: Partial<CreateForm>, boardName: string | null = 'Chibi board') => html(createElement(CreateAgentForm, { boardName, busy: false, onCreate: () => {}, initial, now: NOW }))

	it('offers both types, with the existing whiteboard first and no creator notice until it is chosen as the type', () => {
		const out = render()
		expect(out).toContain('<input type="radio" name="agent-kind" checked="" value="existing"/>')
		expect(out).toContain('name="agent-kind" value="creator"')
		expect(out).toContain('Create new whiteboards')
		expect(out).toContain('Give an agent access to “Chibi board”')
		expect(out).not.toContain('(recommended)')
		expect(out).not.toContain(CREATOR_ACCESS_NOTE)
	})

	it('shows the exact notice and the scope note for the creator type, and recommends read, edit and history', () => {
		const out = render({ creator: true, access: 'read-write-history' })
		expect(out).toContain(CREATOR_NOTICE)
		expect(out).toContain(CREATOR_ACCESS_NOTE)
		expect(out).toContain('Create an agent that makes new whiteboards')
		expect(out).toMatch(/Read, edit and view history \(recommended\)/)
		expect(out).toContain('<input type="radio" name="access" checked="" value="read-write-history"/>')
		expect(out).not.toContain('Give an agent access to “Chibi board”')
	})

	it('uses the creator wording for restore and still gates it on the tick', () => {
		const out = render({ creator: true, access: 'full' })
		expect(out).toContain(CREATOR_RESTORE_WARNING)
		expect(out).not.toContain(RESTORE_WARNING)
		expect(out).toContain('restore every whiteboard it creates')
		expect(out).toMatch(/<button class="aw-primary-button" disabled="">Create access<\/button>/)
		expect(render({ creator: true, access: 'full', restoreAcknowledged: true })).not.toMatch(/class="aw-primary-button" disabled/)
	})

	it('with no whiteboard of their own, leaves only the creator type and starts on it', () => {
		const out = render(undefined, null)
		expect(out).toContain('You do not own a whiteboard yet.')
		expect(out).toMatch(/name="agent-kind" disabled="" value="existing"|name="agent-kind" checked="" value="creator"/)
		expect(out).toContain('Create an agent that makes new whiteboards')
		expect(out).toContain('<input type="radio" name="access" checked="" value="read-write-history"/>')
		expect(out).toContain(CREATOR_NOTICE)
	})
})

describe('the list, the token dialog and the checklist', () => {
	it('labels a board-creating agent and counts what it has made', () => {
		const render = (agent: Agent) => html(createElement(AgentList, { agents: [agent], busy: false, pending: null, onStart: () => {}, onCancel: () => {}, onRotate: () => {}, onRevoke: () => {}, now: NOW }))
		expect(render(creatorAgent())).toContain('Creates whiteboards')
		expect(render(creatorAgent())).toContain('0 whiteboards created so far')
		expect(render(creatorAgent({ rooms: ['one'] }))).toContain('1 whiteboard created so far')
		expect(render(creatorAgent({ rooms: ['one', 'two', 'three'] }))).toContain('3 whiteboards created so far')
		const ordinary = render(creatorAgent({ canCreateBoards: undefined, rooms: ['b'] }))
		expect(ordinary).not.toContain('Creates whiteboards')
		expect(ordinary).not.toContain('created so far')
	})

	it('says plainly what revoking a board-creating agent also does', () => {
		const out = html(createElement(AgentList, { agents: [creatorAgent()], busy: false, pending: { kind: 'revoke', ref: creatorAgent().ref }, onStart: () => {}, onCancel: () => {}, onRotate: () => {}, onRevoke: () => {}, now: NOW }))
		expect(out).toContain('also loses access to every whiteboard it created')
		expect(out).toContain('The whiteboards stay yours.')
	})

	it('never shows the opaque reference, the stored name or any credential detail for a creator', () => {
		const out = html(createElement(AgentList, { agents: [creatorAgent()], busy: false, pending: null, onStart: () => {}, onCancel: () => {}, onRotate: () => {}, onRevoke: () => {}, now: NOW }))
		expect(out).not.toContain('0123456789abcdef')
		expect(out).not.toContain('agent-aaaaaaaaaaaa')
		expect(out).toContain('Planner')
	})

	it('shows the one-time token for a creator without naming a whiteboard', () => {
		const revealed: RevealedToken = { kind: 'created', agentTitle: 'Planner', boardName: null, token: TOKEN }
		const out = html(createElement(TokenDialog, { revealed, onDismiss: () => {} }))
		expect(out).toContain('which can create new whiteboards owned by your account')
		expect(out).not.toContain(' on <strong>')
		expect(out).toContain(TOKEN)
		expect(out).toContain('<code class="aw-token-value">')
		expect(out).not.toMatch(/<input[^>]*value="T{43}"/)
	})

	it('gives a creator a checklist with no whiteboard id, because it has none yet', () => {
		const out = inRouter(createElement(SetupChecklist, { creator: true }))
		expect(out).not.toContain('WHITEBOARD_BOARD_ID')
		expect(out).toContain('There is no whiteboard ID yet')
		expect(out).toContain('board-creation request')
		expect(out).toContain('href="/help/agent-api"')
		expect(out).not.toContain('Copy ID')
		// and the ordinary checklist is as it was
		const ordinary = inRouter(createElement(SetupChecklist, { boardId: 'chibi-board-id', boardName: 'Chibi board' }))
		expect(ordinary).toContain('WHITEBOARD_BOARD_ID')
		expect(ordinary).toContain('chibi-board-id')
	})
})

describe('the API client', () => {
	const calls: Array<{ url: string; init: RequestInit }> = []
	beforeEach(() => {
		calls.length = 0
		vi.stubGlobal('fetch', async (input: string, init: RequestInit = {}) => {
			calls.push({ url: String(input), init })
			return new Response(JSON.stringify({ agents: [], agent: creatorAgent(), token: TOKEN }), { status: 200, headers: { 'content-type': 'application/json' } })
		})
	})
	afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

	it('creates a creator with a kind and no board, and lists the caller\'s own', async () => {
		await listBoardCreators()
		await createBoardCreator({ displayName: 'Planner', access: 'read-write-history', expiresAt: '2027-01-01T00:00:00.000Z' })
		expect(calls.map((call) => `${call.init.method ?? 'GET'} ${call.url}`)).toEqual(['GET /api/agent-access?scope=creators', 'POST /api/agent-access'])
		const body = JSON.parse(String(calls[1].init.body))
		expect(body).toEqual({ kind: 'board-creator', displayName: 'Planner', access: 'read-write-history', expiresAt: '2027-01-01T00:00:00.000Z' })
		expect(body).not.toHaveProperty('boardId')
		expect(body).not.toHaveProperty('ownerUserId')
	})

	it('still authenticates with the cookie only, and never writes a token anywhere', async () => {
		const setItem = vi.fn()
		vi.stubGlobal('localStorage', { setItem, getItem: () => null })
		vi.stubGlobal('sessionStorage', { setItem, getItem: () => null })
		const log = vi.spyOn(console, 'log').mockImplementation(() => {})
		await createBoardCreator({ displayName: 'Planner', access: 'read' })
		expect(setItem).not.toHaveBeenCalled()
		expect(log).not.toHaveBeenCalled()
		for (const call of calls) expect(JSON.stringify(call.init.headers ?? {}).toLowerCase()).not.toContain('authorization')
	})
})

describe('the client and the server agree about board-creating agents (contract)', () => {
	let f: AcceptanceFixture
	let directory: string

	function actAs(identity: FixtureIdentity) {
		vi.stubGlobal('fetch', async (input: string, init: RequestInit = {}) => {
			const payload = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
			const response = await identity.request((init.method ?? 'GET') as HttpMethod, String(input), payload)
			return new Response(response.body, { status: response.statusCode, headers: { 'content-type': String(response.headers['content-type'] ?? 'application/json') } })
		})
	}

	beforeEach(async () => {
		f = await createAcceptanceFixture()
		directory = mkdtempSync(join(tmpdir(), 'agents-ui-creators-'))
		process.env.CANVAS_API_TOKENS_FILE = join(directory, 'api-tokens.json')
	})
	afterEach(async () => {
		vi.unstubAllGlobals()
		await f.cleanup()
		rmSync(directory, { recursive: true, force: true })
	})

	it('runs the whole journey: create with no board, list, let the agent make a board, rotate, revoke', async () => {
		actAs(f.owner)

		const created = await createBoardCreator({ displayName: 'Planner', access: 'read-write-history', expiresAt: new Date(Date.now() + 30 * DAY).toISOString() })
		expect(created.agent).toMatchObject({ displayName: 'Planner', canCreateBoards: true, rooms: [], permissions: ['read', 'write', 'history'], status: 'active' })
		expect(authorizeApiToken(`Bearer ${created.token}`, f.boardId, 'read')).toBeNull() // no access to the owner's existing board

		const listed = await listBoardCreators()
		expect(listed.map((agent) => agent.ref)).toEqual([created.agent.ref])

		const made = await f.app.inject({ method: 'POST', url: '/api/agent-boards', headers: { authorization: `Bearer ${created.token}` }, payload: { name: 'From the agent' } })
		expect(made.statusCode, made.body).toBe(201)
		const boardId = made.json().boardId as string
		expect(authorizeApiToken(`Bearer ${created.token}`, boardId, 'write')).toBe(created.agent.name)
		expect((await listBoardCreators())[0].rooms).toEqual([boardId])

		const rotated = await rotateAgent(listed[0].ref)
		expect(rotated.agent).toMatchObject({ canCreateBoards: true, rooms: [boardId] })
		expect(authorizeApiToken(`Bearer ${created.token}`, boardId, 'read')).toBeNull()
		expect(authorizeApiToken(`Bearer ${rotated.token}`, boardId, 'read')).toBe(created.agent.name)

		await revokeAgent(rotated.agent.ref)
		expect(await listBoardCreators()).toEqual([])
		expect(authorizeApiToken(`Bearer ${rotated.token}`, boardId, 'read')).toBeNull()
	})

	it('keeps the other type working: an existing-board agent is created exactly as before', async () => {
		actAs(f.owner)
		const created = await createAgent({ boardId: f.boardId, displayName: 'Claude', access: 'read-write-history' })
		expect(created.agent).toMatchObject({ permissions: ['read', 'write', 'history'], rooms: [f.boardId] })
		expect(created.agent.canCreateBoards).toBeUndefined()
		expect(await listBoardCreators()).toEqual([])
	})

	it('a person only ever sees their own board-creating agents', async () => {
		actAs(f.nonmember)
		await createBoardCreator({ displayName: 'Theirs', access: 'read' })
		actAs(f.owner)
		await createBoardCreator({ displayName: 'Mine', access: 'read' })
		expect((await listBoardCreators()).map((agent) => agent.displayName)).toEqual(['Mine'])
	})
})

describe('source guards for the new UI code', () => {
	const read = (file: string) => readFileSync(join(__dirname, '..', 'client', 'agents', file), 'utf8')
	const files = ['AgentsPage.tsx', 'CreateAgentForm.tsx', 'AgentList.tsx', 'TokenDialog.tsx', 'SetupChecklist.tsx', 'agents-api.ts', 'agents-model.ts']

	it('never reaches for storage, cookies, the URL, history state, the console or a beacon', () => {
		for (const file of files) {
			const source = read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
			for (const forbidden of ['localStorage', 'sessionStorage', 'document.cookie', 'indexedDB', 'console.', 'sendBeacon', 'history.pushState', 'history.replaceState', 'innerHTML', 'window.open', 'Authorization']) {
				expect(source, `${file} uses ${forbidden}`).not.toContain(forbidden)
			}
		}
	})

	it('hands a board-creating agent\'s token to the same one-time reducer as every other token', () => {
		const page = read('AgentsPage.tsx')
		expect(page).toContain("dispatchToken({ type: 'reveal'")
		expect((page.match(/dispatchToken\(\{ type: 'reveal'/g) ?? []).length).toBe(3) // create creator, create existing, rotate
		expect(page).toContain('onPageHide(window')
	})
})
