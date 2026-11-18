/**
 * The public agent guide (server/agent-guide.ts, served at GET /agent-guide.md).
 *
 * It is the one page served with no sign-in so an agent can learn how to connect before it holds any credential.
 * These tests pin three things: it is reachable in the right places and only there, it carries nothing secret, and
 * every request it teaches is one the machine API really accepts (so the guide cannot drift from the allowlist).
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AccessVerifier } from '../server/access-jwt'
import { renderAgentGuide } from '../server/agent-guide'
import { buildApp } from '../server/app'
import { isMachineRoute } from '../server/host-policy'

const HUMAN = 'whiteboard.example.test'
const MACHINE = 'whiteboard-api.example.test'
const accessVerifier: AccessVerifier = { async verify(assertion) { return assertion === 'valid' ? { ok: true, clientId: 'svc' } : { ok: false, reason: 'invalid' } } }

async function withApp<T>(run: (app: Awaited<ReturnType<typeof buildApp>>) => Promise<T>, hostPolicy?: Parameters<typeof buildApp>[0]['hostPolicy']): Promise<T> {
	const directory = mkdtempSync(join(tmpdir(), 'agent-guide-'))
	const app = await buildApp({ dataDirectory: directory, clientDirectory: directory, logger: false, ...(hostPolicy ? { hostPolicy } : {}) })
	try {
		return await run(app)
	} finally {
		await app.close()
		rmSync(directory, { recursive: true, force: true })
	}
}

describe('who can read the guide', () => {
	it('is served to anyone with no sign-in, as plain text a browser shows inline', async () => {
		await withApp(async (app) => {
			const response = await app.inject({ method: 'GET', url: '/agent-guide.md' })

			expect(response.statusCode).toBe(200)
			expect(response.headers['content-type']).toMatch(/^text\/plain; charset=utf-8/)
			expect(response.headers['cache-control']).toMatch(/public/)
			expect(response.body).toContain('# How an AI agent connects to this whiteboard')
		})
	})

	it('is public on the browser hostname and names the machine address, while sending no cookie or credential', async () => {
		await withApp(async (app) => {
			const response = await app.inject({ method: 'GET', url: '/agent-guide.md', headers: { host: HUMAN } })

			expect(response.statusCode).toBe(200)
			expect(response.body).toContain(`https://${MACHINE}`)
			expect(response.headers['set-cookie']).toBeUndefined()
		}, { publicHost: HUMAN, machineHost: MACHINE, accessVerifier })
	})

	it('is not a machine route: behind Cloudflare Access on the machine hostname, and a 404 even for a valid agent', async () => {
		await withApp(async (app) => {
			const anonymous = await app.inject({ method: 'GET', url: '/agent-guide.md', headers: { host: MACHINE } })
			const credentialed = await app.inject({ method: 'GET', url: '/agent-guide.md', headers: { host: MACHINE, 'cf-access-jwt-assertion': 'valid' } })

			expect(anonymous.statusCode).toBe(403)
			expect(credentialed.statusCode).toBe(404)
		}, { publicHost: HUMAN, machineHost: MACHINE, accessVerifier })
	})

	it('answers GET only', async () => {
		await withApp(async (app) => {
			const response = await app.inject({ method: 'POST', url: '/agent-guide.md', headers: { origin: 'http://127.0.0.1:8787' }, payload: {} })

			expect(response.statusCode).toBeGreaterThanOrEqual(400)
		})
	})
})

describe('what the guide must never contain', () => {
	const guide = renderAgentGuide({ agentApiOrigin: `https://${MACHINE}` })

	it('holds no token, key or secret value: only the names of the values a person hands over', () => {
		// A base64url run this long can only be a bearer token or a client secret.
		expect(guide).not.toMatch(/[A-Za-z0-9_-]{32,}/)
		expect(guide).not.toMatch(/Bearer [A-Za-z0-9_-]{8,}/)
		expect(guide).not.toMatch(/\.access\.|cloudflareaccess\.com/i)
		for (const name of ['WHITEBOARD_TOKEN', 'CF_ACCESS_CLIENT_ID', 'CF_ACCESS_CLIENT_SECRET', 'WHITEBOARD_API', 'WHITEBOARD_BOARD_ID']) expect(guide).toContain(name)
	})

	it('names no real board, account or production hostname, with or without a configured address', () => {
		for (const text of [guide, renderAgentGuide()]) {
			expect(text).not.toMatch(/your-server|100\.\d+\.\d+\.\d+/i)
			expect(text).not.toMatch(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i)
		}
		// Only the address this deployment itself passed in appears, and only as a suggestion.
		expect(renderAgentGuide()).not.toMatch(/https?:\/\//)
	})

	it('leaves no placeholder behind', () => {
		expect(renderAgentGuide()).not.toContain('{{')
		expect(guide).not.toContain('{{')
	})

	it('tells an agent to use the API and to run every check before it says it is finished', () => {
		const section = /## Before you say you are finished\n([\s\S]*?)\n## /.exec(guide)?.[1] ?? ''
		expect(section).not.toBe('')
		expect(section).toMatch(/Use this API for every change/)
		expect(section).toMatch(/partially_unverified. is not a pass/)
		for (const check of ['Read the page back over the API', 'phone-sized view', 'Other pages are unchanged', 'No token, secret or password', 'names anything you could not verify']) expect(section, check).toContain(check)
		expect(section).toMatch(/Do not report the work as done until they all pass/)
	})
})

describe('what the guide teaches is what the machine API accepts', () => {
	const guide = renderAgentGuide()

	/** Every curl command in a fenced block, joined across its line continuations. */
	function commands(): Array<{ method: string; path: string; headers: string[] }> {
		const found: Array<{ method: string; path: string; headers: string[] }> = []
		for (const block of guide.matchAll(/```bash\n([\s\S]*?)```/g)) {
			const joined = block[1].replace(/\\\n\s*/g, ' ').trim()
			const method = /-X (GET|POST|PUT|PATCH|DELETE)/.exec(joined)?.[1] ?? 'GET'
			const url = /"\$WHITEBOARD_API(\/[^"]*)"/.exec(joined)?.[1]
			if (!url) continue
			found.push({ method, path: url.replace('$WHITEBOARD_BOARD_ID', 'board-x'), headers: [...joined.matchAll(/-H "([^"]+)"/g)].map((match) => match[1]) })
		}
		return found
	}

	it('keeps its shell line continuations intact, so a pasted command runs', () => {
		expect(guide).toMatch(/curl -sS "\$WHITEBOARD_API\/api\/health" \\\n/)
	})

	it('teaches at least the five core requests', () => {
		expect(commands().map((command) => `${command.method} ${command.path}`)).toEqual([
			'GET /api/health',
			'GET /api/agent-session',
			'GET /api/rooms/board-x/semantic-context',
			'POST /api/rooms/board-x/actions',
			'POST /api/boards/board-x/images',
			'POST /api/agent-boards',
		])
	})

	it('teaches how to add a picture and a link, and that SVG and non-https links are refused', () => {
		expect(guide).toMatch(/### Add a picture/)
		expect(guide).toContain('create_image')
		expect(guide).toContain('set_link')
		expect(guide).toMatch(/not\s+SVG/)
		expect(guide).toMatch(/Only a plain address that starts with `https`/)
	})

	it('only shows requests the machine hostname actually routes', () => {
		for (const command of commands()) expect(isMachineRoute(command.method, command.path), `${command.method} ${command.path}`).toBe(true)
	})

	it('sends the whiteboard token on everything past the first reachability check', () => {
		for (const command of commands().slice(1)) expect(command.headers.some((header) => header.startsWith('Authorization: Bearer $WHITEBOARD_TOKEN')), command.path).toBe(true)
		expect(commands()[0].headers.some((header) => header.startsWith('Authorization'))).toBe(false)
	})
})
