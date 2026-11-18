import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentList } from '../client/agents/AgentList'
import {
	CAD_UPLOAD_MAX_DAYS,
	defaultRotateChoice,
	latestCadUploadDate,
	rotateChoicesFor,
	rotateExpiryFor,
	type Agent,
} from '../client/agents/agents-model'
import { CAD_UPLOAD_MAX_LIFETIME_DAYS, createClient } from '../server/token-store.mjs'
import { authorizeApiCapability } from '../server/tokens'
import { createAcceptanceFixture, type AcceptanceFixture } from './helpers/acceptance-fixture'

/**
 * Who can see that an agent can upload CAD files (ADR 013): the board owner on the Agents page and API, and the operator in
 * `list` (tests/manage-api-tokens.test.ts). Also the page's part of the expiry rule, so an owner is never offered a
 * choice the server would refuse. The server's rule itself is tested in tests/cad-machine-upload.test.ts.
 */
const DAY = 86_400_000
const BASE = '/api/agent-access'

let f: AcceptanceFixture
let storeDirectory: string
let storeFile: string

beforeEach(async () => {
	f = await createAcceptanceFixture()
	storeDirectory = mkdtempSync(join(tmpdir(), 'cad-visibility-store-'))
	storeFile = join(storeDirectory, 'api-tokens.json')
	process.env.CANVAS_API_TOKENS_FILE = storeFile
})
afterEach(async () => {
	await f.cleanup()
	rmSync(storeDirectory, { recursive: true, force: true })
})

async function cadAgent(extra: Record<string, unknown> = {}) {
	return createClient({
		file: storeFile, name: 'cad-loader', rooms: [f.boardId], access: 'read-write', capabilities: ['cad-upload'],
		expiresAt: new Date(Date.now() + 7 * DAY), displayName: 'CAD loader', createdByUserId: f.owner.userId ?? undefined, ...extra,
	} as Parameters<typeof createClient>[0])
}
const listed = async () => (await f.owner.get(`${BASE}?boardId=${f.boardId}`)).json().agents as Array<{ name: string; ref: string; canUploadCad?: boolean }>
const refOf = async (name: string) => (await listed()).find((agent) => agent.name === name)!.ref

async function rotateEvents(): Promise<Array<{ metadata_json: string }>> {
	const database = new Database(join(f.directory, 'auth.sqlite'), { readonly: true })
	try { return database.prepare("SELECT metadata_json FROM account_events WHERE type = 'agent.rotated' ORDER BY id").all() as never }
	finally { database.close() }
}

describe('the Agents API tells the board owner which agent can upload CAD files', () => {
	it('marks a cad-upload credential, and only that one', async () => {
		await cadAgent()
		const plain = await f.owner.post(BASE, { boardId: f.boardId, displayName: 'plain', access: 'read-write' })
		expect(plain.statusCode).toBe(201)
		expect(plain.json().agent.canUploadCad).toBeUndefined()
		const agents = await listed()
		expect(agents.find((agent) => agent.name === 'cad-loader')?.canUploadCad).toBe(true)
		expect(agents.filter((agent) => agent.name !== 'cad-loader').every((agent) => agent.canUploadCad === undefined)).toBe(true)
	})

	it('keeps the mark through a rotation, refuses an expiry beyond the maximum with a plain reason, and records the capability', async () => {
		await cadAgent()
		const ref = await refOf('cad-loader')
		const tooLong = await f.owner.post(`${BASE}/${ref}/rotate`, { expiresAt: new Date(Date.now() + (CAD_UPLOAD_MAX_LIFETIME_DAYS + 35) * DAY).toISOString() })
		expect(tooLong.statusCode).toBe(422)
		expect(tooLong.json().error).toContain(`${CAD_UPLOAD_MAX_LIFETIME_DAYS} days`)
		expect((await listed())[0].ref).toBe(ref)
		const rotated = await f.owner.post(`${BASE}/${ref}/rotate`, { expiresAt: new Date(Date.now() + 10 * DAY).toISOString() })
		expect(rotated.statusCode, rotated.body).toBe(200)
		expect(rotated.json().agent.canUploadCad).toBe(true)
		expect(authorizeApiCapability(`Bearer ${rotated.json().token}`, f.boardId, 'cad-upload')).toBe('cad-loader')
		expect((await listed())[0].canUploadCad).toBe(true)
		const events = await rotateEvents()
		expect(JSON.parse(events.at(-1)!.metadata_json).capabilities).toEqual(['cad-upload'])
		// A year-long expiry (the Otto agent token's) is accepted by the owner API for such an agent, and keeps the capability.
		const year = await f.owner.post(`${BASE}/${rotated.json().agent.ref}/rotate`, { expiresAt: new Date(Date.now() + 355 * DAY).toISOString() })
		expect(year.statusCode, year.body).toBe(200)
		expect(year.json().agent.canUploadCad).toBe(true)
		expect(authorizeApiCapability(`Bearer ${year.json().token}`, f.boardId, 'cad-upload')).toBe('cad-loader')
	})

	it('stops showing the mark when a rotation takes write access away, because the capability can no longer be used', async () => {
		await cadAgent()
		const ref = await refOf('cad-loader')
		const rotated = await f.owner.post(`${BASE}/${ref}/rotate`, { access: 'read' })
		expect(rotated.statusCode, rotated.body).toBe(200)
		expect(rotated.json().agent.canUploadCad).toBeUndefined()
		expect((await listed())[0].canUploadCad).toBeUndefined()
		expect(authorizeApiCapability(`Bearer ${rotated.json().token}`, f.boardId, 'cad-upload')).toBeNull()
		expect(JSON.parse((await rotateEvents()).at(-1)!.metadata_json).droppedCapabilities).toEqual(['cad-upload'])
	})

	it('does not bring the capability back when write access is given again later', async () => {
		await cadAgent()
		const demoted = (await f.owner.post(`${BASE}/${await refOf('cad-loader')}/rotate`, { access: 'read' })).json()
		const restored = await f.owner.post(`${BASE}/${demoted.agent.ref}/rotate`, { access: 'read-write' })
		expect(restored.statusCode, restored.body).toBe(200)
		expect(restored.json().agent.permissions).toEqual(['read', 'write'])
		expect(restored.json().agent.canUploadCad).toBeUndefined()
		expect((await listed())[0].canUploadCad).toBeUndefined()
		expect(authorizeApiCapability(`Bearer ${restored.json().token}`, f.boardId, 'cad-upload')).toBeNull()
	})

	it('does not show it to someone who is not the board owner', async () => {
		await cadAgent()
		for (const identity of [f.editor, f.viewer, f.nonmember]) expect([403, 404], identity.role).toContain((await identity.get(`${BASE}?boardId=${f.boardId}`)).statusCode)
	})
})

const NOW = new Date(2026, 9, 8, 12, 0, 0).getTime()
const REF = 'agent-aaaaaaaaaaaa.0123456789abcdef'
function agent(overrides: Partial<Agent> = {}): Agent {
	return {
		ref: REF, name: 'agent-aaaaaaaaaaaa', displayName: 'CAD loader', permissions: ['read', 'write'], rooms: ['board-one'],
		sharedWithOtherBoards: false, createdAt: '2026-10-01T00:00:00.000Z', expiresAt: new Date(NOW + 5 * DAY).toISOString(), status: 'active',
		createdByYou: true, ...overrides,
	}
}
const noop = () => undefined
const render = (agents: Agent[], pending: { kind: 'rotate' | 'revoke'; ref: string } | null = null) =>
	renderToStaticMarkup(createElement(AgentList, { agents, busy: false, pending, onStart: noop, onCancel: noop, onRotate: noop, onRevoke: noop, now: NOW }))

describe('the Agents page shows it and never offers an expiry the server would refuse', () => {
	it('shows an "Uploads CAD files" badge on the agent that can, and not on others', () => {
		expect(render([agent({ canUploadCad: true })])).toContain('Uploads CAD files')
		expect(render([agent()])).not.toContain('Uploads CAD files')
	})

	it('offers a CAD-upload agent every expiry up to the maximum and a chosen date, never "No expiry", and says why', () => {
		const cad = render([agent({ canUploadCad: true })], { kind: 'rotate', ref: REF })
		for (const wanted of ['7 days', '30 days', '90 days', '1 year', 'A date I choose']) expect(cad).toContain(wanted)
		expect(cad).not.toContain('No expiry')
		expect(cad).toContain(`at most ${CAD_UPLOAD_MAX_DAYS} days`)
		const plain = render([agent()], { kind: 'rotate', ref: REF })
		for (const wanted of ['7 days', '30 days', '90 days', '1 year', 'A date I choose']) expect(plain).toContain(wanted)
		expect(plain).not.toContain(`at most ${CAD_UPLOAD_MAX_DAYS} days`)
	})

	it('starts an expired agent on 90 days, a CAD-upload agent included', () => {
		const cad = render([agent({ canUploadCad: true, status: 'expired' })], { kind: 'rotate', ref: REF })
		expect(cad).toMatch(/<option value="90d" selected=""/)
		const plain = render([agent({ status: 'expired' })], { kind: 'rotate', ref: REF })
		expect(plain).toMatch(/<option value="90d" selected=""/)
	})
})

describe('the page model keeps to the same maximum as the server', () => {
	it('uses the server constant', () => {
		expect(CAD_UPLOAD_MAX_DAYS).toBe(CAD_UPLOAD_MAX_LIFETIME_DAYS)
	})

	it('filters choices and defaults by agent', () => {
		expect(rotateChoicesFor({ canUploadCad: true }).map((option) => option.value)).toEqual(['7d', '30d', '90d', '365d', 'custom'])
		expect(rotateChoicesFor({}).map((option) => option.value)).toEqual(['7d', '30d', '90d', '365d', 'custom'])
		expect(defaultRotateChoice({ status: 'active', canUploadCad: true })).toBe('keep')
		expect(defaultRotateChoice({ status: 'expired', canUploadCad: true })).toBe('90d')
		expect(defaultRotateChoice({ status: 'invalid' })).toBe('90d')
	})

	it('never offers a default that the maximum would refuse, and never shortens the presets any agent is offered', () => {
		const offered = rotateChoicesFor({ canUploadCad: true }).map((option) => option.value)
		expect(offered).toContain(defaultRotateChoice({ status: 'expired', canUploadCad: true }))
		expect(offered).toEqual(rotateChoicesFor({}).map((option) => option.value))
		expect(offered).not.toContain('never')
	})

	it('accepts exactly a year for a CAD-upload agent and refuses a date beyond it, but not for other agents', () => {
		expect(rotateExpiryFor({ canUploadCad: true }, '365d', '', NOW)).toEqual({ ok: true, expiresAt: new Date(NOW + 365 * DAY).toISOString() })
		expect(rotateExpiryFor({ canUploadCad: true }, '7d', '', NOW).ok).toBe(true)
		expect(rotateExpiryFor({ canUploadCad: true }, 'keep', '', NOW)).toEqual({ ok: true })
		const far = new Date(NOW + 400 * DAY)
		const farDate = `${far.getFullYear()}-${String(far.getMonth() + 1).padStart(2, '0')}-${String(far.getDate()).padStart(2, '0')}`
		const refused = rotateExpiryFor({ canUploadCad: true }, 'custom', farDate, NOW)
		expect(refused.ok).toBe(false)
		expect(!refused.ok && refused.message).toContain(`${CAD_UPLOAD_MAX_DAYS} days`)
		expect(rotateExpiryFor({}, 'custom', farDate, NOW).ok).toBe(true)
		expect(rotateExpiryFor({}, '90d', '', NOW)).toEqual({ ok: true, expiresAt: new Date(NOW + 90 * DAY).toISOString() })
	})

	it('picks the last chosen date whose end is still within the maximum, and refuses the day after', () => {
		const last = latestCadUploadDate(NOW)
		expect(rotateExpiryFor({ canUploadCad: true }, 'custom', last, NOW).ok).toBe(true)
		const [year, month, day] = last.split('-').map(Number)
		const after = new Date(year, month - 1, day + 1)
		const next = `${after.getFullYear()}-${String(after.getMonth() + 1).padStart(2, '0')}-${String(after.getDate()).padStart(2, '0')}`
		expect(rotateExpiryFor({ canUploadCad: true }, 'custom', next, NOW).ok).toBe(false)
		expect(rotateExpiryFor({}, 'custom', next, NOW).ok).toBe(true)
	})
})
