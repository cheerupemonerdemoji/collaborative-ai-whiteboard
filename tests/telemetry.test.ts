import { afterEach, describe, expect, it, vi } from 'vitest'
import { isMachineRoute } from '../server/host-policy'
import { FakeViamSensor, loadTelemetryRegistry, TelemetryConfigError, TelemetryReader, TelemetryRegistry } from '../server/telemetry'
import {
	classifyTelemetry,
	DEFAULT_TELEMETRY_THRESHOLDS,
	normalizeReadingsMap,
	statusFromAge,
	telemetrySnapshotSchema,
	validateThresholds,
	type TelemetryThresholds,
} from '../shared/telemetry'
import { createAcceptanceFixture, type AcceptanceFixture } from './helpers/acceptance-fixture'

const T: TelemetryThresholds = { staleAfterMs: 10_000, offlineAfterMs: 30_000, offlineAfterFailures: 3 }
const SECRET = 'fake-viam-credential-for-tests'

function clockAt(start = 1_000_000) {
	let now = start
	return { now: () => now, advance: (ms: number) => { now += ms } }
}

describe('telemetry contract', () => {
	it('classifies by age on the server clock', () => {
		const base = { receivedAt: 1000, observedAt: 1000, consecutiveFailures: 0, thresholds: T }
		expect(classifyTelemetry({ ...base, now: 1000 + 10_000 }).status).toBe('fresh')
		expect(classifyTelemetry({ ...base, now: 1000 + 10_001 }).status).toBe('stale')
		expect(classifyTelemetry({ ...base, now: 1000 + 30_000 }).status).toBe('stale')
		expect(classifyTelemetry({ ...base, now: 1000 + 30_001 })).toMatchObject({ status: 'offline', reason: 'data-expired' })
	})

	it('is offline with no data, and with enough consecutive failures whatever the age', () => {
		expect(classifyTelemetry({ now: 5, receivedAt: null, observedAt: null, consecutiveFailures: 0, thresholds: T })).toEqual({ status: 'offline', reason: 'no-data', ageMs: null })
		expect(classifyTelemetry({ now: 1001, receivedAt: 1000, observedAt: 1000, consecutiveFailures: 3, thresholds: T })).toMatchObject({ status: 'offline', reason: 'reader-failing' })
		expect(classifyTelemetry({ now: 1001, receivedAt: 1000, observedAt: 1000, consecutiveFailures: 2, thresholds: T }).status).toBe('fresh')
	})

	it('does not let a sensor clock in the future make data look fresher than its arrival', () => {
		const verdict = classifyTelemetry({ now: 1000 + 20_000, receivedAt: 1000, observedAt: 1000 + 3_600_000, consecutiveFailures: 0, thresholds: T })
		expect(verdict).toMatchObject({ status: 'stale', ageMs: 20_000 })
	})

	it('calls data that arrived promptly but describes an old moment sensor-lagging', () => {
		const verdict = classifyTelemetry({ now: 100_000, receivedAt: 99_000, observedAt: 80_000, consecutiveFailures: 0, thresholds: T })
		expect(verdict).toMatchObject({ status: 'stale', reason: 'sensor-lagging' })
	})

	it('lets the browser keep degrading a card from age alone', () => {
		expect(statusFromAge(0, T).status).toBe('fresh')
		expect(statusFromAge(15_000, T).status).toBe('stale')
		expect(statusFromAge(45_000, T).status).toBe('offline')
		expect(statusFromAge(null, T)).toEqual({ status: 'offline', reason: 'no-data' })
	})

	it('rejects thresholds that cannot work', () => {
		expect(() => validateThresholds({ ...T, staleAfterMs: 0 })).toThrow()
		expect(() => validateThresholds({ ...T, offlineAfterMs: T.staleAfterMs })).toThrow()
		expect(() => validateThresholds({ ...T, offlineAfterFailures: 0 })).toThrow()
		expect(validateThresholds(DEFAULT_TELEMETRY_THRESHOLDS)).toBe(DEFAULT_TELEMETRY_THRESHOLDS)
	})

	it('normalises a Viam readings map and drops what the contract cannot carry', () => {
		const readings = normalizeReadingsMap({ 'Battery %': 91, temp: 22.5, docked: true, nested: { a: 1 }, nan: Number.NaN, list: [1], nothing: null }, { battery_: { label: 'Battery', unit: '%' } })
		expect(readings.map((r) => r.key)).toEqual(['battery_', 'temp', 'docked', 'nothing'])
		expect(readings[0]).toMatchObject({ label: 'Battery', unit: '%', value: 91 })
		expect(() => normalizeReadingsMap([1, 2])).toThrow()
		expect(() => normalizeReadingsMap('x')).toThrow()
	})

	it('validates snapshots strictly', () => {
		const ok = { schemaVersion: 1, sourceId: 'rover', machineName: 'Rover', readings: [{ key: 'a', label: 'A', value: 1 }] }
		expect(telemetrySnapshotSchema.safeParse(ok).success).toBe(true)
		expect(telemetrySnapshotSchema.safeParse({ ...ok, command: 'move' }).success).toBe(false)
		expect(telemetrySnapshotSchema.safeParse({ ...ok, schemaVersion: 2 }).success).toBe(false)
		expect(telemetrySnapshotSchema.safeParse({ ...ok, readings: [ok.readings[0], ok.readings[0]] }).success).toBe(false)
		expect(telemetrySnapshotSchema.safeParse({ ...ok, readings: [{ key: 'a', label: 'A', value: {} }] }).success).toBe(false)
		expect(telemetrySnapshotSchema.safeParse({ ...ok, readings: Array.from({ length: 33 }, (_, i) => ({ key: `k${i}`, label: 'x', value: 1 })) }).success).toBe(false)
	})
})

describe('telemetry reader', () => {
	function setup(options: { minRefreshMs?: number; readTimeoutMs?: number } = {}) {
		const clock = clockAt()
		const sensor = new FakeViamSensor('rover', 'Test rover', clock.now, SECRET)
		const failures: unknown[] = []
		const reader = new TelemetryReader({ source: sensor, thresholds: T, clock: clock.now, minRefreshMs: options.minRefreshMs ?? 1_000, readTimeoutMs: options.readTimeoutMs ?? 50, onFailure: (event) => failures.push(event) })
		return { clock, sensor, reader, failures }
	}

	it('shows Fresh with readings, machine name and a last-update time after a good read', async () => {
		const { reader } = setup()
		await reader.ensureCurrent()
		const view = reader.view()
		expect(view).toMatchObject({ status: 'fresh', reason: 'ok', machineName: 'Test rover', simulated: true, consecutiveFailures: 0, lastFailure: null })
		expect(view.readings.map((r) => r.key)).toEqual(['battery_pct', 'temperature_c', 'motor_current_a', 'docked'])
		expect(view.observedAt).toBe(1_000_000)
		expect(view.receivedAt).toBe(1_000_000)
	})

	it('degrades Fresh to Stale to Offline after a disconnect, keeping the last good readings, and recovers', async () => {
		const { clock, sensor, reader, failures } = setup()
		await reader.ensureCurrent()
		sensor.setMode('disconnected')
		clock.advance(11_000)
		await reader.ensureCurrent(); await reader.refresh()
		let view = reader.view()
		expect(view.status).toBe('stale')
		expect(view.readings.length).toBe(4)
		expect(view.lastFailure).toBe('unreachable')
		clock.advance(25_000)
		view = reader.view()
		expect(view.status).toBe('offline')
		expect(view.reason).toBe('data-expired')
		expect(failures.length).toBeGreaterThanOrEqual(1)
		sensor.setMode('ok')
		await reader.refresh()
		view = reader.view()
		expect(view).toMatchObject({ status: 'fresh', consecutiveFailures: 0, lastFailure: null })
	})

	it('goes Offline on repeated failures even while the last good reading is still recent', async () => {
		const { clock, sensor, reader } = setup()
		await reader.ensureCurrent()
		sensor.setMode('disconnected')
		for (let i = 0; i < 3; i += 1) { clock.advance(1_000); await reader.refresh() }
		expect(reader.view()).toMatchObject({ status: 'offline', reason: 'reader-failing', consecutiveFailures: 3 })
		expect(reader.view().ageMs).toBeLessThan(T.staleAfterMs)
	})

	it('is Offline with no readings when the first read fails', async () => {
		const { sensor, reader } = setup()
		sensor.setMode('disconnected')
		await reader.ensureCurrent()
		expect(reader.view()).toMatchObject({ status: 'offline', reason: 'no-data', readings: [], observedAt: null, ageMs: null, lastFailure: 'unreachable' })
	})

	it('treats a hanging sensor as a timeout rather than waiting on it', async () => {
		const { sensor, reader } = setup({ readTimeoutMs: 20 })
		sensor.setMode('hanging')
		await reader.ensureCurrent()
		expect(reader.view().lastFailure).toBe('timeout')
	})

	it('treats malformed data as a failed read and never shows it', async () => {
		const { clock, sensor, reader } = setup()
		await reader.ensureCurrent()
		const before = reader.view().readings
		sensor.setMode('malformed')
		clock.advance(2_000)
		await reader.refresh()
		const view = reader.view()
		expect(view.lastFailure).toBe('invalid-data')
		expect(view.readings).toEqual(before)
	})

	it('refuses a snapshot that names a different source', async () => {
		const clock = clockAt()
		const liar = { sourceId: 'rover', machineName: 'Rover', simulated: true, read: async () => ({ schemaVersion: 1, sourceId: 'someone-else', machineName: 'Other', readings: [] }) }
		const reader = new TelemetryReader({ source: liar, thresholds: T, clock: clock.now })
		await reader.refresh()
		expect(reader.view()).toMatchObject({ status: 'offline', lastFailure: 'invalid-data', readings: [] })
	})

	it('reads one at a time and no more often than the refresh budget', async () => {
		const { clock, sensor, reader } = setup({ minRefreshMs: 5_000 })
		const spy = vi.spyOn(sensor, 'read')
		await Promise.all([reader.refresh(), reader.refresh(), reader.ensureCurrent()])
		expect(spy).toHaveBeenCalledTimes(1)
		clock.advance(1_000)
		await reader.ensureCurrent()
		expect(spy).toHaveBeenCalledTimes(1)
		clock.advance(5_000)
		await reader.ensureCurrent()
		await reader.refresh()
		expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2)
	})

	it('never lets a provider error message, which may hold a credential, reach the view or the failure events', async () => {
		const { sensor, reader, failures } = setup()
		sensor.setMode('leaky-error')
		await reader.ensureCurrent()
		const everything = JSON.stringify({ view: reader.view(), failures })
		expect(everything).not.toContain(SECRET)
		expect(everything).not.toContain('unauthenticated')
		expect(reader.view().lastFailure).toBe('unreachable')
		expect(failures).toEqual([{ sourceId: 'rover', category: 'unreachable' }])
	})
})

describe('telemetry configuration', () => {
	const entry = { id: 'rover', machineName: 'Rover', provider: 'fake', boards: ['b1'] }

	it('has no sources when nothing is configured', () => {
		expect(loadTelemetryRegistry({}).size).toBe(0)
		expect(loadTelemetryRegistry({ CANVAS_TELEMETRY_SOURCES: '  ' }).size).toBe(0)
	})

	it('binds simulated sources to boards', () => {
		const registry = loadTelemetryRegistry({ CANVAS_TELEMETRY_SOURCES: JSON.stringify([entry]) })
		expect(registry.forBoard('b1', 'rover')).not.toBeNull()
		expect(registry.forBoard('b2', 'rover')).toBeNull()
		expect(registry.listForBoard('b1')).toEqual([{ sourceId: 'rover', machineName: 'Rover', simulated: true }])
		expect(registry.listForBoard('b2')).toEqual([])
	})

	it('refuses a real provider in this phase and a credential in the config, without echoing the value', () => {
		const attempt = (value: unknown) => { try { loadTelemetryRegistry({ CANVAS_TELEMETRY_SOURCES: JSON.stringify(value) }) } catch (error) { return error } return null }
		for (const bad of [[{ ...entry, provider: 'viam' }], [{ ...entry, apiKey: SECRET }], [{ ...entry, boards: [] }], [{ ...entry, id: 'Bad Id' }], [entry, entry]]) {
			const error = attempt(bad)
			expect(error).toBeInstanceOf(Error)
			expect(String((error as Error).message)).not.toContain(SECRET)
		}
		expect(attempt([{ ...entry, apiKey: SECRET }])).toBeInstanceOf(TelemetryConfigError)
		expect(() => loadTelemetryRegistry({ CANVAS_TELEMETRY_SOURCES: '{nope' })).toThrow(TelemetryConfigError)
		expect(() => loadTelemetryRegistry({ CANVAS_TELEMETRY_SOURCES: JSON.stringify([{ ...entry, thresholds: { staleAfterMs: 5, offlineAfterMs: 5, offlineAfterFailures: 1 } }]) })).toThrow()
	})
})

describe('telemetry routes', () => {
	const fixtures: AcceptanceFixture[] = []
	afterEach(async () => { for (const built of fixtures.splice(0)) await built.cleanup() })

	async function boardWith(modes: { sensor?: FakeViamSensor; otherBoard?: boolean; limit?: number } = {}) {
		const boardId = 'telemetry-board'
		const sensor = modes.sensor ?? new FakeViamSensor('rover', 'Test rover', Date.now, SECRET)
		const registry = new TelemetryRegistry().add(new TelemetryReader({ source: sensor, thresholds: T, minRefreshMs: 1 }), [modes.otherBoard ? 'some-other-board' : boardId])
		const built = await createAcceptanceFixture({ boardId, telemetry: registry, rateLimits: modes.limit ? { telemetry: { limit: modes.limit, windowMs: 60_000 } } : undefined })
		fixtures.push(built)
		return { built, sensor }
	}
	const url = (boardId: string, sourceId = 'rover') => `/api/boards/${boardId}/telemetry/${sourceId}`

	it('serves members of every role a read-only view, marked simulated, never cached', async () => {
		const { built } = await boardWith()
		for (const who of [built.owner, built.editor, built.viewer]) {
			const response = await who.get(url(built.boardId))
			expect(response.statusCode).toBe(200)
			expect(response.headers['cache-control']).toBe('no-store')
			expect(response.json()).toMatchObject({ sourceId: 'rover', machineName: 'Test rover', simulated: true, status: 'fresh' })
		}
	})

	it('refuses anonymous callers and non-members with the same answers as other board routes', async () => {
		const { built } = await boardWith()
		expect((await built.anonymous.get(url(built.boardId))).statusCode).toBe(401)
		expect((await built.anonymous.get(`/api/boards/${built.boardId}/telemetry`)).statusCode).toBe(401)
		const outsider = await built.nonmember.get(url(built.boardId))
		expect(outsider.statusCode).toBe(404)
		expect(outsider.body).not.toContain('Test rover')
		expect((await built.nonmember.get(`/api/boards/${built.boardId}/telemetry`)).statusCode).toBe(404)
	})

	it('does not accept a bearer token, a header-supplied identity, or any write method', async () => {
		const { built } = await boardWith()
		const bearer = await built.anonymous.request('GET', url(built.boardId), undefined, { authorization: 'Bearer anything', 'x-user-id': built.owner.userId ?? 'x' })
		expect(bearer.statusCode).toBe(401)
		for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
			const response = await built.owner.request(method, url(built.boardId), {})
			expect([404, 405]).toContain(response.statusCode)
		}
	})

	it('answers a source bound to another board exactly as it answers one that does not exist', async () => {
		const { built } = await boardWith({ otherBoard: true })
		const bound = await built.owner.get(url(built.boardId))
		const unknown = await built.owner.get(url(built.boardId, 'no-such-source'))
		const malformed = await built.owner.get(url(built.boardId, 'Bad..Id'))
		expect(bound.statusCode).toBe(404)
		expect(bound.body).toBe(unknown.body)
		expect(malformed.statusCode).toBe(404)
		expect((await built.owner.get(`/api/boards/${built.boardId}/telemetry`)).json()).toEqual({ sources: [] })
	})

	it('lists only the sources bound to the board', async () => {
		const { built } = await boardWith()
		expect((await built.viewer.get(`/api/boards/${built.boardId}/telemetry`)).json()).toEqual({ sources: [{ sourceId: 'rover', machineName: 'Test rover', simulated: true }] })
	})

	it('reports a disconnect as a category only, and the response never contains the credential', async () => {
		const sensor = new FakeViamSensor('rover', 'Test rover', Date.now, SECRET)
		const { built } = await boardWith({ sensor })
		expect((await built.owner.get(url(built.boardId))).json().status).toBe('fresh')
		sensor.setMode('leaky-error')
		let body = ''
		for (let i = 0; i < 4; i += 1) { await new Promise((resolve) => setTimeout(resolve, 5)); body = (await built.owner.get(url(built.boardId))).body }
		await new Promise((resolve) => setTimeout(resolve, 20))
		body = (await built.owner.get(url(built.boardId))).body
		const view = JSON.parse(body)
		expect(view.status).toBe('offline')
		expect(view.lastFailure).toBe('unreachable')
		expect(body).not.toContain(SECRET)
		expect(body).not.toContain('unauthenticated')
	})

	it('is rate limited per user and board', async () => {
		const { built } = await boardWith({ limit: 2 })
		expect((await built.owner.get(url(built.boardId))).statusCode).toBe(200)
		expect((await built.owner.get(url(built.boardId))).statusCode).toBe(200)
		expect((await built.owner.get(url(built.boardId))).statusCode).toBe(429)
		expect((await built.editor.get(url(built.boardId))).statusCode).toBe(200)
	})

	it('is not reachable on the machine hostname', () => {
		expect(isMachineRoute('GET', '/api/boards/telemetry-board/telemetry/rover')).toBe(false)
		expect(isMachineRoute('GET', '/api/boards/telemetry-board/telemetry')).toBe(false)
	})
})
