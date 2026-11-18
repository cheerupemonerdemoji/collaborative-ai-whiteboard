import { z } from 'zod'
import {
	classifyTelemetry,
	DEFAULT_TELEMETRY_THRESHOLDS,
	normalizeReadingsMap,
	TELEMETRY_SCHEMA_VERSION,
	TELEMETRY_SOURCE_ID,
	telemetrySnapshotSchema,
	validateThresholds,
	type TelemetryFailure,
	type TelemetrySnapshot,
	type TelemetryThresholds,
	type TelemetryView,
} from '../shared/telemetry'

/**
 * The protected backend reader for read-only machine telemetry. Credentials, sockets and provider errors all stay in
 * this module: what leaves it is a validated snapshot and a failure *category*, never a provider message.
 * Nothing here sends a command to a machine; a source can only be read.
 */

/** A source returns unvalidated data; the reader validates it, so a source cannot hand the browser anything the contract does not allow. */
export interface TelemetrySource {
	readonly sourceId: string
	readonly machineName: string
	/** True for anything that is not a real machine, so the card can say so. */
	readonly simulated: boolean
	read(signal: AbortSignal): Promise<unknown>
}

export type FakeSensorMode = 'ok' | 'disconnected' | 'hanging' | 'malformed' | 'leaky-error'

/**
 * A stand-in for a Viam sensor component. Like a real one, it answers `GetReadings` with a flat name -> value map;
 * unlike a real one it can be told to drop off, hang, return junk, or fail with an error whose message contains a
 * credential, so every failure path can be tested without hardware.
 */
export class FakeViamSensor implements TelemetrySource {
	readonly simulated = true
	mode: FakeSensorMode = 'ok'
	/** How far behind the reader's clock the sensor's own clock runs, to model a lagging sensor. */
	sensorLagMs = 0
	private tick = 0
	constructor(
		readonly sourceId: string,
		readonly machineName: string,
		private readonly clock: () => number = Date.now,
		/** Planted in the `leaky-error` failure so tests can prove it never escapes. */
		private readonly secretForLeakTest = 'fake-viam-credential-for-tests',
	) {}

	setMode(mode: FakeSensorMode) { this.mode = mode }

	async read(signal: AbortSignal): Promise<unknown> {
		switch (this.mode) {
			case 'disconnected': throw new Error('connect ECONNREFUSED 127.0.0.1:1')
			case 'leaky-error': throw new Error(`rpc error: unauthenticated for key ${this.secretForLeakTest}`)
			case 'malformed': return { readings: 'not-a-map' }
			case 'hanging':
				return new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
			case 'ok': break
		}
		this.tick += 1
		const readings = {
			battery_pct: 100 - (this.tick % 40),
			temperature_c: 24 + (this.tick % 7) * 0.5,
			motor_current_a: 1.2 + (this.tick % 5) * 0.1,
			docked: this.tick % 10 === 0,
		}
		return {
			schemaVersion: TELEMETRY_SCHEMA_VERSION,
			sourceId: this.sourceId,
			machineName: this.machineName,
			readings: normalizeReadingsMap(readings, {
				battery_pct: { label: 'Battery', unit: '%' },
				temperature_c: { label: 'Temperature', unit: '°C' },
				motor_current_a: { label: 'Motor current', unit: 'A' },
				docked: { label: 'Docked' },
			}),
			observedAt: Math.max(0, this.clock() - this.sensorLagMs),
		}
	}
}

export interface TelemetryReaderOptions {
	source: TelemetrySource
	thresholds?: TelemetryThresholds
	/** A read that takes longer than this counts as a failed read. */
	readTimeoutMs?: number
	/** The most often the source is actually read, however many viewers ask. */
	minRefreshMs?: number
	clock?: () => number
	/** Receives `{ sourceId, category }` only. Never an error message. */
	onFailure?: (event: { sourceId: string; category: TelemetryFailure }) => void
}

/**
 * Holds the last good snapshot for one source and reads it on demand, at most once per `minRefreshMs`, one read at a
 * time. A failed read never replaces the last good data, so a disconnect degrades the card through Stale to Offline
 * instead of blanking it, and an invalid snapshot is a failed read rather than something shown.
 */
export class TelemetryReader {
	private snapshot: TelemetrySnapshot | null = null
	private receivedAt: number | null = null
	private lastAttemptAt: number | null = null
	private failures = 0
	private lastFailure: TelemetryFailure | null = null
	private inFlight: Promise<void> | null = null
	readonly thresholds: TelemetryThresholds
	private readonly clock: () => number
	private readonly readTimeoutMs: number
	private readonly minRefreshMs: number

	constructor(private readonly options: TelemetryReaderOptions) {
		this.thresholds = validateThresholds(options.thresholds ?? DEFAULT_TELEMETRY_THRESHOLDS)
		this.clock = options.clock ?? Date.now
		this.readTimeoutMs = options.readTimeoutMs ?? 3_000
		this.minRefreshMs = options.minRefreshMs ?? 2_000
	}

	get sourceId() { return this.options.source.sourceId }

	/** Reads once, unless a read is already running. Never rejects. */
	refresh(): Promise<void> {
		if (this.inFlight) return this.inFlight
		this.lastAttemptAt = this.clock()
		this.inFlight = this.readOnce().finally(() => { this.inFlight = null })
		return this.inFlight
	}

	private async readOnce(): Promise<void> {
		const { source } = this.options
		const controller = new AbortController()
		let timer: ReturnType<typeof setTimeout> | undefined
		try {
			const raw = await Promise.race([
				source.read(controller.signal),
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(() => { controller.abort(); reject(new TelemetryTimeout()) }, this.readTimeoutMs)
				}),
			])
			const parsed = telemetrySnapshotSchema.safeParse(raw)
			// A source may only speak for itself: a snapshot naming another source or machine is refused.
			if (!parsed.success || parsed.data.sourceId !== source.sourceId) return this.fail('invalid-data')
			this.snapshot = { ...parsed.data, machineName: source.machineName }
			this.receivedAt = this.clock()
			this.failures = 0
			this.lastFailure = null
		} catch (error) {
			this.fail(error instanceof TelemetryTimeout ? 'timeout' : 'unreachable')
		} finally {
			if (timer) clearTimeout(timer)
		}
	}

	private fail(category: TelemetryFailure) {
		this.failures += 1
		this.lastFailure = category
		this.options.onFailure?.({ sourceId: this.options.source.sourceId, category })
	}

	/** Makes sure the data is as recent as the refresh budget allows. The first request waits for a first read; later ones never wait. */
	async ensureCurrent(): Promise<void> {
		if (this.lastAttemptAt === null) return this.refresh()
		if (this.clock() - this.lastAttemptAt >= this.minRefreshMs) void this.refresh()
		if (this.inFlight && this.snapshot === null) await this.inFlight
	}

	view(): TelemetryView {
		const now = this.clock()
		const verdict = classifyTelemetry({ now, receivedAt: this.receivedAt, observedAt: this.snapshot?.observedAt ?? null, consecutiveFailures: this.failures, thresholds: this.thresholds })
		return {
			schemaVersion: TELEMETRY_SCHEMA_VERSION,
			sourceId: this.options.source.sourceId,
			machineName: this.options.source.machineName,
			simulated: this.options.source.simulated,
			status: verdict.status,
			reason: verdict.reason,
			readings: this.snapshot?.readings ?? [],
			observedAt: this.snapshot?.observedAt ?? null,
			receivedAt: this.receivedAt,
			serverTime: now,
			ageMs: verdict.ageMs,
			consecutiveFailures: this.failures,
			lastFailure: this.lastFailure,
			thresholds: this.thresholds,
		}
	}
}

class TelemetryTimeout extends Error {}

export interface TelemetrySourceEntry {
	reader: TelemetryReader
	/** The only boards this source may be shown on. */
	boardIds: ReadonlySet<string>
}

/** Sources and the boards each is bound to. A board never sees a source it is not bound to, and cannot tell it exists. */
export class TelemetryRegistry {
	private readonly entries = new Map<string, TelemetrySourceEntry>()

	add(reader: TelemetryReader, boardIds: Iterable<string>): this {
		if (this.entries.has(reader.sourceId)) throw new Error(`Duplicate telemetry source: ${reader.sourceId}`)
		this.entries.set(reader.sourceId, { reader, boardIds: new Set(boardIds) })
		return this
	}

	forBoard(boardId: string, sourceId: string): TelemetryReader | null {
		const entry = this.entries.get(sourceId)
		return entry?.boardIds.has(boardId) ? entry.reader : null
	}

	listForBoard(boardId: string): Array<{ sourceId: string; machineName: string; simulated: boolean }> {
		return [...this.entries.values()]
			.filter((entry) => entry.boardIds.has(boardId))
			.map(({ reader }) => ({ sourceId: reader.sourceId, ...describe(reader) }))
	}

	get size() { return this.entries.size }
}

function describe(reader: TelemetryReader) {
	const view = reader.view()
	return { machineName: view.machineName, simulated: view.simulated }
}

/**
 * Source configuration holds names and bindings only. A credential never goes in it: when a real provider is added it
 * will name an environment variable to read, and the schema is `.strict()` so a pasted key is rejected, not stored.
 * Only the simulated provider exists in this phase; asking for anything else is refused, so a config cannot make the
 * server connect to hardware.
 */
const sourceConfigSchema = z.object({
	id: z.string().regex(TELEMETRY_SOURCE_ID),
	machineName: z.string().trim().min(1).max(100),
	provider: z.literal('fake'),
	boards: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,80}$/)).min(1).max(20),
	thresholds: z.object({ staleAfterMs: z.number(), offlineAfterMs: z.number(), offlineAfterFailures: z.number() }).strict().optional(),
}).strict()
export const telemetryConfigSchema = z.array(sourceConfigSchema).max(20)

export class TelemetryConfigError extends Error {}

/** Reads `CANVAS_TELEMETRY_SOURCES` (a JSON array). Reports which entry is wrong and why, never the offending value. */
export function loadTelemetryRegistry(env: NodeJS.ProcessEnv, options: { clock?: () => number; onFailure?: TelemetryReaderOptions['onFailure'] } = {}): TelemetryRegistry {
	const registry = new TelemetryRegistry()
	const raw = env.CANVAS_TELEMETRY_SOURCES?.trim()
	if (!raw) return registry
	let json: unknown
	try { json = JSON.parse(raw) } catch { throw new TelemetryConfigError('CANVAS_TELEMETRY_SOURCES is not valid JSON') }
	const parsed = telemetryConfigSchema.safeParse(json)
	if (!parsed.success) {
		const where = parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.code}`).join('; ')
		throw new TelemetryConfigError(`CANVAS_TELEMETRY_SOURCES is invalid (${where})`)
	}
	for (const entry of parsed.data) {
		const source = new FakeViamSensor(entry.id, entry.machineName, options.clock)
		registry.add(new TelemetryReader({ source, thresholds: entry.thresholds, clock: options.clock, onFailure: options.onFailure }), entry.boards)
	}
	return registry
}
