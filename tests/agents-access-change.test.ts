/**
 * The browser side of deliberately changing an agent's access while rotating its token: what a choice means (old scopes, new scopes, what is
 * added), when it may be submitted, what is sent, and what the panel shows. The server's own enforcement is in lossless-editing.test.ts.
 */

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentList } from '../client/agents/AgentList'
import { rotateAgent } from '../client/agents/agents-api'
import { ACCESS_LEVELS, accessLevelFor, previewAccessChange, validateRotateAccess, type Agent, type Permission } from '../client/agents/agents-model'

const REF = 'agent-aaaaaaaaaaaa.0123456789abcdef'
const agent = (permissions: Permission[]): Agent => ({
	ref: REF, name: 'agent-aaaaaaaaaaaa', displayName: 'Maze helper', permissions, rooms: ['board-one'],
	sharedWithOtherBoards: false, createdAt: '2026-10-01T00:00:00.000Z', status: 'none', createdByYou: true,
})

describe('what a change of access means', () => {
	it('names the access level an agent holds, or none when it holds a combination the page does not offer', () => {
		expect(accessLevelFor(['read', 'write'])?.value).toBe('read-write')
		expect(accessLevelFor(['history', 'read', 'write'])?.value).toBe('read-write-history')
		expect(accessLevelFor(['read', 'restore'])).toBeNull()
	})

	it('keeping the access changes nothing', () => {
		expect(previewAccessChange(['read', 'write'], 'keep')).toEqual({ previous: ['read', 'write'], next: ['read', 'write'], added: [], removed: [], changed: false, addsRestore: false })
	})

	it('shows exactly what is added and removed, and adding history never adds restore', () => {
		const grow = previewAccessChange(['read', 'write'], 'read-write-history')
		expect(grow).toMatchObject({ added: ['history'], removed: [], changed: true, addsRestore: false })
		expect(grow.next).not.toContain('restore')
		const shrink = previewAccessChange(['read', 'write', 'history'], 'read')
		expect(shrink).toMatchObject({ added: [], removed: ['write', 'history'], changed: true })
	})

	it('flags restore, and only restore, as the elevated addition; choosing the access it already has is not a change', () => {
		expect(previewAccessChange(['read', 'write'], 'full')).toMatchObject({ added: ['history', 'restore'], addsRestore: true })
		expect(previewAccessChange(['read', 'write', 'history', 'restore'], 'full')).toMatchObject({ changed: false, addsRestore: false })
		for (const level of ACCESS_LEVELS) {
			const adds = previewAccessChange(['read'], level.value).addsRestore
			expect(adds, level.value).toBe(level.permissions.includes('restore'))
		}
	})
})

describe('when a rotation with a change of access may be sent', () => {
	it('sends nothing extra for an ordinary rotation or for choosing the access it already has', () => {
		expect(validateRotateAccess(['read', 'write'], 'keep', false)).toEqual({ ok: true })
		expect(validateRotateAccess(['read', 'write'], 'read-write', false)).toEqual({ ok: true })
	})

	it('sends the new access for an addition of history, with no restore acknowledgement', () => {
		expect(validateRotateAccess(['read', 'write'], 'read-write-history', false)).toEqual({ ok: true, change: { access: 'read-write-history' } })
	})

	it('will not add restore without the explicit acknowledgement, and sends it only when restore is added', () => {
		const refused = validateRotateAccess(['read', 'write'], 'full', false)
		expect(refused).toMatchObject({ ok: false })
		expect(validateRotateAccess(['read', 'write'], 'full', true)).toEqual({ ok: true, change: { access: 'full', acknowledgeRestore: true } })
		// an acknowledgement given for something else is never sent
		expect(validateRotateAccess(['read', 'write'], 'read-write-history', true)).toEqual({ ok: true, change: { access: 'read-write-history' } })
	})
})

describe('what is sent', () => {
	const calls: Array<{ url: string; body: unknown }> = []
	afterEach(() => { vi.unstubAllGlobals(); calls.length = 0 })
	function stub() {
		vi.stubGlobal('fetch', async (input: string, init: RequestInit = {}) => {
			calls.push({ url: String(input), body: JSON.parse(String(init.body ?? '{}')) })
			return new Response(JSON.stringify({ agent: agent(['read', 'write', 'history']), token: 'T'.repeat(43), accessChange: { previous: ['read', 'write'], current: ['read', 'write', 'history'], added: ['history'], removed: [] } }), { status: 200, headers: { 'content-type': 'application/json' } })
		})
	}

	it('an ordinary rotation sends exactly what it always sent', async () => {
		stub()
		await rotateAgent(REF)
		await rotateAgent(REF, '2027-06-01T00:00:00.000Z')
		expect(calls.map((call) => call.body)).toEqual([{}, { expiresAt: '2027-06-01T00:00:00.000Z' }])
	})

	it('a change of access travels with the rotation, and the acknowledgement only when given', async () => {
		stub()
		const result = await rotateAgent(REF, undefined, { access: 'read-write-history' })
		await rotateAgent(REF, '2027-06-01T00:00:00.000Z', { access: 'full', acknowledgeRestore: true })
		expect(calls.map((call) => call.body)).toEqual([{ access: 'read-write-history' }, { expiresAt: '2027-06-01T00:00:00.000Z', access: 'full', acknowledgeRestore: true }])
		expect(result.accessChange).toMatchObject({ added: ['history'] })
	})
})

describe('the rotate panel', () => {
	const noop = () => {}
	const panel = (permissions: Permission[]) => renderToStaticMarkup(createElement(AgentList, { agents: [agent(permissions)], busy: false, pending: { kind: 'rotate', ref: REF }, onStart: noop, onCancel: noop, onRotate: noop, onRevoke: noop, now: Date.UTC(2026, 9, 18) }))

	it('offers to keep the current access (named in words) and to change to each access level, and shows no change until one is chosen', () => {
		const out = panel(['read', 'write'])
		expect(out).toContain('Keep the current access (Read, Edit)')
		for (const level of ACCESS_LEVELS) expect(out).toContain(`Change to: ${level.label}`)
		expect(out).not.toContain('(added)')
		expect(out).not.toContain('roll the whole whiteboard back')
		expect(out).toContain('the current token stops working immediately')
	})

	it('never puts a token, hash or reference on the panel', () => {
		const out = panel(['read', 'write'])
		expect(out).not.toContain(REF)
		expect(out).not.toMatch(/[0-9a-f]{40,}/)
	})
})
