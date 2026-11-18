import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTLStore } from 'tldraw'
import { describe, expect, it } from 'vitest'
import { TelemetryCardView } from '../client/telemetry/TelemetryCardShape'
import { cardState, formatAge, formatReadingValue, type CardInputs } from '../client/telemetry/telemetry-model'
import { syncSchema } from '../shared/schema'
import { TELEMETRY_CARD_SHAPE_TYPE, TELEMETRY_CARD_SIZE, type TelemetryView } from '../shared/telemetry'

const thresholds = { staleAfterMs: 10_000, offlineAfterMs: 30_000, offlineAfterFailures: 3 }
const view = (patch: Partial<TelemetryView> = {}): TelemetryView => ({
	schemaVersion: 1, sourceId: 'rover', machineName: 'Test rover', simulated: true, status: 'fresh', reason: 'ok',
	readings: [{ key: 'battery_pct', label: 'Battery', value: 91, unit: '%' }, { key: 'temperature_c', label: 'Temperature', value: 24.5, unit: '°C' }, { key: 'docked', label: 'Docked', value: false }],
	observedAt: Date.UTC(2026, 9, 28, 12, 0, 0), receivedAt: 5_000, serverTime: 5_000, ageMs: 0, consecutiveFailures: 0, lastFailure: null, thresholds, ...patch,
})
const inputs = (patch: Partial<CardInputs> = {}): CardInputs => ({ view: view(), fetchedAt: 1_000, now: 1_000, requestFailed: false, notFound: false, ...patch })

describe('telemetry card state', () => {
	it('shows Connecting before the first response, and Offline if that never arrives', () => {
		expect(cardState(inputs({ view: null, fetchedAt: null })).status).toBe('loading')
		expect(cardState(inputs({ view: null, fetchedAt: null, requestFailed: true }))).toMatchObject({ status: 'offline', reason: 'server-unreachable' })
	})

	it('is unavailable when the board does not offer the source', () => {
		expect(cardState(inputs({ notFound: true }))).toMatchObject({ status: 'unavailable', machineName: null, readings: [] })
	})

	it('keeps counting age between polls, so a card whose polls stop degrades from Fresh to Stale to Offline', () => {
		expect(cardState(inputs({ now: 1_000 + 5_000 })).status).toBe('fresh')
		expect(cardState(inputs({ now: 1_000 + 12_000 })).status).toBe('stale')
		expect(cardState(inputs({ now: 1_000 + 31_000 })).status).toBe('offline')
	})

	it('never lets the server be reached-but-wrong: the server verdict is kept when it is worse than the age', () => {
		const state = cardState(inputs({ view: view({ status: 'offline', reason: 'reader-failing', ageMs: 2_000, consecutiveFailures: 3 }) }))
		expect(state).toMatchObject({ status: 'offline', reason: 'reader-failing' })
	})

	it('does not show Fresh when the poll failed, since currency cannot be confirmed', () => {
		expect(cardState(inputs({ requestFailed: true }))).toMatchObject({ status: 'stale', reason: 'server-unreachable' })
		expect(cardState(inputs({ requestFailed: true, now: 1_000 + 40_000 })).status).toBe('offline')
	})

	it('measures local age from elapsed time only, so a wrong browser clock cannot change it', () => {
		// fetchedAt and now are both browser readings; the server's own ageMs is the only cross-clock figure used.
		const state = cardState(inputs({ view: view({ ageMs: 4_000 }), fetchedAt: 9_000_000_000, now: 9_000_003_000 }))
		expect(state.ageMs).toBe(7_000)
	})
})

describe('telemetry card formatting', () => {
	it('formats ages and readings', () => {
		expect(formatAge(null)).toBe('never')
		expect(formatAge(2_000)).toBe('just now')
		expect(formatAge(42_000)).toBe('42s ago')
		expect(formatAge(5 * 60_000)).toBe('5m ago')
		expect(formatAge(3 * 3_600_000)).toBe('3h ago')
		expect(formatReadingValue({ key: 'a', label: 'A', value: 24.5, unit: '°C' })).toBe('24.5 °C')
		expect(formatReadingValue({ key: 'a', label: 'A', value: 91, unit: '%' })).toBe('91 %')
		expect(formatReadingValue({ key: 'a', label: 'A', value: 1.0000001 })).toBe('1')
		expect(formatReadingValue({ key: 'a', label: 'A', value: true })).toBe('Yes')
		expect(formatReadingValue({ key: 'a', label: 'A', value: null })).toBe('—')
		expect(formatReadingValue({ key: 'a', label: 'A', value: 'idle' })).toBe('idle')
	})
})

describe('telemetry card rendering', () => {
	const render = (patch: Partial<CardInputs>) => renderToStaticMarkup(createElement(TelemetryCardView, { state: cardState(inputs(patch)), width: 320, height: 260, sourceId: 'rover' }))

	it('renders the machine name, readings, last update and a Fresh badge, marked simulated', () => {
		const html = render({})
		expect(html).toContain('Test rover')
		expect(html).toContain('Battery')
		expect(html).toContain('91 %')
		expect(html).toContain('Last update:')
		expect(html).toContain('>Fresh<')
		expect(html).toContain('Simulated')
	})

	it('renders Stale and Offline distinctly, and keeps the last readings visible', () => {
		const stale = render({ now: 1_000 + 15_000 })
		expect(stale).toContain('>Stale<')
		expect(stale).toContain('telemetry-card-stale')
		expect(stale).toContain('91 %')
		const offline = render({ now: 1_000 + 60_000 })
		expect(offline).toContain('>Offline<')
		expect(offline).toContain('telemetry-card-offline')
	})

	it('renders an honest empty state with no data', () => {
		const html = render({ view: null, fetchedAt: null, requestFailed: true })
		expect(html).toContain('>Offline<')
		expect(html).toContain('No readings to show')
		expect(html).toContain('No update yet')
		expect(html).toContain('rover')
	})
})

describe('telemetry card in the board schema', () => {
	const record = (props: Record<string, unknown>) => ({
		id: 'shape:tc1', typeName: 'shape', type: TELEMETRY_CARD_SHAPE_TYPE, x: 0, y: 0, rotation: 0, index: 'a1', parentId: 'page:page', isLocked: false, opacity: 1, meta: {}, props,
	}) as never

	it('is a registered shape type, so a board holding one loads, and its one stored property is checked', () => {
		const store = createTLStore({ schema: syncSchema })
		store.put([record({ ...TELEMETRY_CARD_SIZE, sourceId: 'rover' })])
		expect(store.get('shape:tc1' as never)).toBeTruthy()
		expect(() => store.put([record({ ...TELEMETRY_CARD_SIZE, sourceId: 'Not A Source!' })])).toThrow()
		expect(() => store.put([record({ ...TELEMETRY_CARD_SIZE, sourceId: 'rover', apiKey: 'nope' })])).toThrow()
	})
})

describe('telemetry source guards', () => {
	const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]))
	const clientSources = files('client/telemetry').filter((file) => /\.tsx?$/.test(file)).map((file) => [file, readFileSync(file, 'utf8')] as const)

	it('the browser side has no storage, console, token or credential handling', () => {
		for (const [file, source] of clientSources) {
			for (const banned of [/localStorage|sessionStorage|indexedDB/, /console\./, /Authorization|Bearer|CF-Access|api[_-]?key|secret|password/i, /document\.cookie/]) {
				expect(source, `${file} matches ${banned}`).not.toMatch(banned)
			}
		}
	})

	it('only reads: no write method and no command vocabulary anywhere in the telemetry code', () => {
		const sources = [...clientSources.map(([file, source]) => [file, source] as const), ...['server/telemetry.ts', 'server/telemetry-routes.ts', 'shared/telemetry.ts'].map((file) => [file, readFileSync(file, 'utf8')] as const)]
		for (const [file, source] of sources) {
			expect(source, `${file} writes`).not.toMatch(/method:\s*['"](POST|PUT|PATCH|DELETE)['"]|app\.(post|put|patch|delete)\(/)
			expect(source, `${file} commands a machine`).not.toMatch(/DoCommand|SetPower|MoveStraight|SetVelocity|\bactuate\b/i)
		}
	})

	it('the server never logs or returns a provider error message', () => {
		const server = readFileSync('server/telemetry.ts', 'utf8')
		expect(server).not.toMatch(/\.message/)
		expect(server).not.toMatch(/console\./)
	})
})
