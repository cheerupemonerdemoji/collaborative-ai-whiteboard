import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { matchRoutes, Route, Routes } from 'react-router-dom'
import { StaticRouter } from 'react-router-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { AuthContext, type AuthContextValue } from '../client/auth'
import { findGuidePage, GUIDE_PAGES, guidePath, guideSource, resolveGuideLink } from '../client/help/guide'
import { HelpPage } from '../client/help/HelpPage'
import { parseBlocks, renderBlocks, slugifyHeading } from '../client/help/markdown'
import { Dashboard } from '../client/pages/Dashboard'
import { Login } from '../client/pages/Login'
import { appRoutes } from '../client/routes'
import { buildApp } from '../server/app'

const GUIDE_DIRECTORY = join(__dirname, '..', 'docs', 'user-guide')

function renderHelp(location: string): string {
	return renderToStaticMarkup(createElement(StaticRouter, { location }, createElement(Routes, null,
		createElement(Route, { path: '/help', element: createElement(HelpPage) }),
		createElement(Route, { path: '/help/:slug', element: createElement(HelpPage) }),
		createElement(Route, { path: '/help/*', element: createElement(HelpPage) }),
	)))
}

function authValue(user: AuthContextValue['user']): AuthContextValue {
	const noop = async () => {}
	return { user, session: null, isLoading: false, startupError: null, login: noop, register: noop, logout: noop, refresh: noop }
}

function renderWithAuth(location: string, user: AuthContextValue['user'], element: ReactElement): string {
	return renderToStaticMarkup(createElement(AuthContext.Provider, { value: authValue(user) },
		createElement(StaticRouter, { location }, element)))
}

const SIGNED_IN: AuthContextValue['user'] = {
	id: 'u1', login: 'sam', displayName: 'Sam Example', createdAt: 0, updatedAt: 0, lastLoginAt: null,
}

describe('user guide content', () => {
	it('ships exactly the ten documented pages, each non-empty', () => {
		const files = readdirSync(GUIDE_DIRECTORY).filter((name) => name.endsWith('.md')).sort()
		expect(files).toEqual(GUIDE_PAGES.map((page) => page.file).sort())
		expect(GUIDE_PAGES).toHaveLength(10)
		for (const page of GUIDE_PAGES) expect(guideSource(page).length, page.file).toBeGreaterThan(500)
	})

	it('the bundled source is the repository file, not a copy', () => {
		for (const page of GUIDE_PAGES) {
			expect(guideSource(page).replace(/\r\n/g, '\n')).toBe(readFileSync(join(GUIDE_DIRECTORY, page.file), 'utf8').replace(/\r\n/g, '\n'))
		}
	})

	it('every page starts with a single title heading', () => {
		for (const page of GUIDE_PAGES) {
			const headings = parseBlocks(guideSource(page)).filter((block) => block.kind === 'heading')
			expect(headings[0], page.file).toMatchObject({ kind: 'heading', level: 1 })
			expect(headings.filter((block) => block.kind === 'heading' && block.level === 1), page.file).toHaveLength(1)
		}
	})

	it('every internal link resolves to a guide page, and every anchor to a real heading', () => {
		const linkPattern = /\]\(([^)\s]+)\)/g
		let checked = 0
		for (const page of GUIDE_PAGES) {
			for (const match of guideSource(page).matchAll(linkPattern)) {
				const href = match[1]
				if (/^https:\/\//.test(href)) continue
				const route = resolveGuideLink(href)
				expect(route, `${page.file} -> ${href}`).not.toBeNull()
				const [path, anchor] = (route as string).split('#')
				const target = GUIDE_PAGES.find((candidate) => guidePath(candidate) === path)
				expect(target, `${page.file} -> ${href}`).toBeDefined()
				if (anchor) {
					const ids = parseBlocks(guideSource(target!)).flatMap((block) => (block.kind === 'heading' ? [block.id] : []))
					expect(ids, `${page.file} -> ${href}`).toContain(anchor)
				}
				checked += 1
			}
		}
		expect(checked).toBeGreaterThan(20)
	})

	it('contains no operator, infrastructure, or private details', () => {
		const forbidden: [string, RegExp][] = [
			['hostname', /your-server|whiteboard\.example\.com|localhost/i],
			['server path', /\/home\/|\/mnt\/|\.local\/share|\.config\/|[A-Za-z]:\\/],
			['ip address', /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/],
			['email', /[\w.+-]+@[\w-]+\.[\w.-]+/],
			['commit hash', /\b(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/],
			['uuid', /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
			['infrastructure', /cloudflare|tailscale|sqlite|tunnel|systemctl|journalctl|backup|licen[cs]e key/i],
			['secret', /bearer|api key|secret|\btoken\b/i],
			['internal api', /engineering_entity|\/api\/|semantic-context|asset id|upload id/i],
		]
		// The Agent API guide must name credentials, the access layer and the API routes, so it is exempt from
		// exactly those four checks. Every check about hosts, paths, addresses, identities and hashes still applies.
		const agentGuideMayMention = new Set(['infrastructure', 'secret', 'internal api'])
		for (const page of GUIDE_PAGES) {
			for (const [name, pattern] of forbidden) {
				if (page.file === 'agent-api.md' && agentGuideMayMention.has(name)) continue
				const hit = pattern.exec(guideSource(page))
				expect(hit, `${page.file} contains a ${name}: ${hit?.[0]}`).toBeNull()
			}
		}
	})

	it('the Agent API guide uses placeholders only and never a real credential, host or identifier', () => {
		const text = guideSource(findGuidePage('agent-api')!)
		for (const name of ['WHITEBOARD_API_BASE', 'CF_ACCESS_CLIENT_ID', 'CF_ACCESS_CLIENT_SECRET', 'WHITEBOARD_TOKEN']) expect(text, name).toContain(name)
		expect(text).not.toMatch(/https?:\/\/(?!example\.com)[^\s"`)]*\.[a-z]{2,}/i)
		expect(text).not.toMatch(/cloudflareaccess\.com|[A-Za-z0-9_-]{40,}/)
		expect(text).not.toMatch(/Bearer (?!\$WHITEBOARD_TOKEN)\S/)
		expect(text).not.toMatch(/CF-Access-Client-(Id|Secret): (?!\$CF_ACCESS)/)
	})

	it('the Agent API guide documents exactly the routes the server allows machines to call', async () => {
		const { MACHINE_ROUTES, isMachineRoute } = await import('../server/host-policy')
		const text = guideSource(findGuidePage('agent-api')!)
		const documented = [...text.matchAll(/^\| `(GET|POST) (\/api\/[^`\s]+)`/gm)].map((match) => ({ method: match[1], url: match[2].replace('BOARD_ID', 'board-a').replace('EVENT_ID', '12') }))
		for (const route of documented) expect(isMachineRoute(route.method, route.url), `${route.method} ${route.url}`).toBe(true)
		expect(documented).toHaveLength(MACHINE_ROUTES.length)
	})

	it('documents every entity type and every relationship type the product has', () => {
		const text = guideSource(findGuidePage('semantic-inspector')!)
		for (const type of ['Component', 'Interface', 'Requirement', 'Task', 'Experiment', 'Decision', 'Risk', 'Evidence']) expect(text).toContain(`### ${type}`)
		for (const relation of ['contains', 'connects_to', 'satisfies', 'tests', 'blocks', 'depends_on', 'mitigates', 'supported_by']) expect(text).toContain(`\`${relation}\``)
	})

	it('only claims things the product genuinely supports', () => {
		const everything = GUIDE_PAGES.map((page) => guideSource(page)).join('\n').toLowerCase()
		for (const planned of ['3d workspace', 'graph visuali', 'automatically appear', 'garbage collect', 'delete an artifact', 'ai graph query']) {
			// A mention is only acceptable inside a sentence that says it is NOT supported.
			for (const line of everything.split('\n').filter((l) => l.includes(planned))) expect(line, planned).toMatch(/not|no |cannot|never|currently/)
		}
	})
})

describe('markdown renderer', () => {
	const html = (markdown: string) => renderToStaticMarkup(createElement(StaticRouter, { location: '/help' }, ...renderBlocks(parseBlocks(markdown))))

	it('renders headings, paragraphs, inline formatting, lists, code, quotes, rules and tables', () => {
		const out = html([
			'# Title', '', 'Some **bold** and *italic* and `code_with_underscores`.', '',
			'- one', '- two', '', '1. first', '2. second', '', '```text', 'a < b', '```', '', '> quoted', '', '---', '',
			'| a | b |', '|---:|---|', '| 1 | x |',
		].join('\n'))
		expect(out).toContain('<h1 id="title">Title</h1>')
		expect(out).toContain('<strong>bold</strong>')
		expect(out).toContain('<em>italic</em>')
		expect(out).toContain('<code>code_with_underscores</code>')
		expect(out).toContain('<ul><li>one</li><li>two</li></ul>')
		expect(out).toContain('<ol><li>first</li><li>second</li></ol>')
		expect(out).toContain('a &lt; b')
		expect(out).toContain('<blockquote><p>quoted</p></blockquote>')
		expect(out).toContain('<hr/>')
		expect(out).toContain('<th style="text-align:right">a</th>')
		expect(out).toContain('<td style="text-align:right">1</td>')
	})

	it('never emits raw HTML or unsafe links', () => {
		const out = html('<script>alert(1)</script> and [bad](javascript:alert(1)) and [ok](https://example.com) and [guide](quick-start.md)')
		expect(out).not.toContain('<script>')
		expect(out).toContain('&lt;script&gt;')
		expect(out).not.toContain('href="javascript:')
		expect(out).toContain('href="https://example.com"')
		expect(out).toContain('rel="noopener noreferrer"')
		expect(out).toContain('href="/help/quick-start"')
	})

	it('slugifies headings predictably', () => {
		expect(slugifyHeading('History, Checkpoints, and Restore')).toBe('history-checkpoints-and-restore')
	})
})

describe('help site rendering', () => {
	it('/help renders the documentation home with the full contents list', () => {
		const out = renderHelp('/help')
		expect(out).toContain('Collaborative AI Whiteboard — User Guide')
		expect(out).toContain('A collaborative engineering workspace')
		expect(out).toContain('aria-label="User guide contents"')
		for (const page of GUIDE_PAGES) expect(out, page.label).toContain(`href="${guidePath(page)}"`)
		expect(out).toContain('aria-current="page"')
	})

	it('every guide page is reachable and renders its own title with previous/next navigation', () => {
		GUIDE_PAGES.forEach((page, index) => {
			const out = renderHelp(guidePath(page))
			const title = parseBlocks(guideSource(page)).find((block) => block.kind === 'heading')
			expect(title).toBeDefined()
			if (title?.kind === 'heading') expect(out, page.file).toContain(`<h1 id="${title.id}"`)
			if (index > 0) expect(out, page.file).toMatch(new RegExp(`rel="prev" href="${guidePath(GUIDE_PAGES[index - 1])}"`))
			if (index < GUIDE_PAGES.length - 1) expect(out, page.file).toMatch(new RegExp(`rel="next" href="${guidePath(GUIDE_PAGES[index + 1])}"`))
			if (page.file !== 'agent-api.md') expect(out, page.file).not.toContain('/api/')
		})
	})

	it('unknown guide paths show a not-found page with a way back, not a blank screen', () => {
		for (const location of ['/help/no-such-page', '/help/a/b']) {
			const out = renderHelp(location)
			expect(out).toContain('Page not found')
			expect(out).toContain('href="/help"')
		}
	})

	it('works without an authentication provider at all (public, no board membership needed)', () => {
		expect(() => renderHelp('/help/quick-start')).not.toThrow()
	})

	it('shows Sign in to visitors and Your whiteboards to signed-in users', () => {
		const render = (user: AuthContextValue['user']) => renderWithAuth('/help', user, createElement(Routes, null, createElement(Route, { path: '/help', element: createElement(HelpPage) })))
		expect(render(null)).toContain('href="/login"')
		expect(render(SIGNED_IN)).toContain('href="/boards"')
	})
})

describe('Help navigation', () => {
	it('is in the boards dashboard header', () => {
		const out = renderWithAuth('/boards', SIGNED_IN, createElement(Dashboard))
		expect(out).toContain('<a class="aw-help-link" href="/help">Help</a>')
		expect(out).toContain('Sign out')
	})

	it('is on the sign-in page, so invitation recipients can read the guide before they have an account', () => {
		// Login reads the invitation from the address bar; the test environment has no browser window.
		const globals = globalThis as { window?: unknown }
		globals.window = { location: { hash: '', search: '' } }
		try {
			const out = renderWithAuth('/login', null, createElement(Login))
			expect(out).toContain('href="/help"')
		} finally { delete globals.window }
	})

	it('is in the board toolbar (checked at source level: the board view needs a live canvas to render)', () => {
		const room = readFileSync(join(__dirname, '..', 'client', 'pages', 'Room.tsx'), 'utf8')
		expect(room).toContain("import { HelpLink } from '../help/HelpPage'")
		expect(room).toMatch(/<header className="topbar">[\s\S]*<HelpLink \/>[\s\S]*<\/header>/)
	})
})

describe('routing', () => {
	const route = (path: string) => matchRoutes(appRoutes, path)
	const requiresAuth = (path: string) => (route(path) ?? []).some((match) => match.route.children !== undefined)

	it('/help and every guide page are public routes, outside the authentication guard', () => {
		for (const path of ['/help', ...GUIDE_PAGES.filter((page) => page.slug).map(guidePath)]) {
			expect(route(path), path).not.toBeNull()
			expect(requiresAuth(path), path).toBe(false)
		}
	})

	it('/help is never mistaken for a board in the legacy /:roomId route', () => {
		const matches = route('/help')!
		expect(matches[matches.length - 1].route.path).toBe('/help')
	})

	it('board and account routes still work and still require sign-in', () => {
		for (const [path, expected] of [['/boards', '/boards'], ['/room/abc123', '/room/:roomId'], ['/legacy-board', '/:roomId'], ['/', '/']] as const) {
			const matches = route(path)!
			expect(matches[matches.length - 1].route.path, path).toBe(expected)
			expect(requiresAuth(path), path).toBe(true)
		}
		expect(requiresAuth('/login')).toBe(false)
	})
})

describe('serving /help from the real server', () => {
	let dir: string | undefined
	afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined })

	async function server() {
		dir = mkdtempSync(join(tmpdir(), 'help-test-'))
		const client = join(dir, 'client')
		const { mkdirSync } = await import('node:fs')
		mkdirSync(client)
		writeFileSync(join(client, 'index.html'), '<!doctype html><div id="root"></div>')
		return buildApp({ dataDirectory: join(dir, 'data'), clientDirectory: client, serveClient: true, logger: false })
	}

	it('serves the application shell for /help and nested guide URLs to anonymous visitors, so a refresh survives', async () => {
		const app = await server()
		try {
			for (const url of ['/help', '/help/quick-start', '/help/engineering-workflow-example']) {
				const response = await app.inject({ method: 'GET', url })
				expect(response.statusCode, url).toBe(200)
				expect(response.headers['content-type'], url).toContain('text/html')
				expect(response.body, url).toContain('id="root"')
			}
		} finally { await app.close() }
	})

	it('public docs do not open any private surface: boards and APIs still refuse anonymous callers', async () => {
		const app = await server()
		try {
			expect((await app.inject({ method: 'GET', url: '/api/boards' })).statusCode).toBe(401)
			expect((await app.inject({ method: 'GET', url: '/api/rooms/anything/semantic-context' })).statusCode).toBe(401)
			const room = await app.inject({ method: 'GET', url: '/room/some-board' })
			expect(room.body).not.toMatch(/some-board|semantic|entities/i)
		} finally { await app.close() }
	})
})
