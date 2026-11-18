import { T } from '@tldraw/validate'
import { z } from 'zod'

/**
 * Read-only machine telemetry: the one contract every telemetry source (a Viam sensor, a fake, a future provider) is
 * normalised into, and the one set of freshness rules the server and the browser card both apply.
 *
 * Trust model. A source is configured on the server and bound to specific boards. The browser only ever names a
 * `sourceId` (the card's one stored property), and the server decides whether that source may be shown on that board.
 * Nothing in this contract carries a credential, and nothing here sends a command to a machine.
 */
export const TELEMETRY_SCHEMA_VERSION = 1
export const TELEMETRY_CARD_SHAPE_TYPE = 'telemetry-card' as const
export const TELEMETRY_CARD_SIZE = { w: 320, h: 260 } as const
export const TELEMETRY_SOURCE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/
export const TELEMETRY_LIMITS = { maxReadings: 32, maxStringLength: 200 } as const

export const TELEMETRY_STATUSES = ['fresh', 'stale', 'offline'] as const
export type TelemetryStatus = (typeof TELEMETRY_STATUSES)[number]
export const TELEMETRY_STATUS_LABELS: Record<TelemetryStatus, string> = { fresh: 'Fresh', stale: 'Stale', offline: 'Offline' }

/** Why a source has the status it has. A category only: never a provider message, which could carry a secret. */
export const TELEMETRY_REASONS = ['ok', 'sensor-lagging', 'data-aging', 'data-expired', 'no-data', 'reader-failing'] as const
export type TelemetryReason = (typeof TELEMETRY_REASONS)[number]
/** What went wrong on the last failed read. A category only. */
export const TELEMETRY_FAILURES = ['unreachable', 'timeout', 'invalid-data'] as const
export type TelemetryFailure = (typeof TELEMETRY_FAILURES)[number]

export const telemetryReadingSchema = z.object({
	key: z.string().regex(/^[a-z][a-z0-9_.-]{0,39}$/),
	label: z.string().trim().min(1).max(60),
	value: z.union([z.number().finite(), z.string().max(TELEMETRY_LIMITS.maxStringLength), z.boolean(), z.null()]),
	unit: z.string().trim().min(1).max(16).optional(),
}).strict()
export type TelemetryReading = z.infer<typeof telemetryReadingSchema>

/** What a source hands the reader. `observedAt` is the sensor's own clock, which is never trusted for freshness. */
export const telemetrySnapshotSchema = z.object({
	schemaVersion: z.literal(TELEMETRY_SCHEMA_VERSION),
	sourceId: z.string().regex(TELEMETRY_SOURCE_ID),
	machineName: z.string().trim().min(1).max(100),
	readings: z.array(telemetryReadingSchema).max(TELEMETRY_LIMITS.maxReadings),
	observedAt: z.number().int().nonnegative().optional(),
}).strict().superRefine((snapshot, ctx) => {
	const keys = snapshot.readings.map((reading) => reading.key)
	if (new Set(keys).size !== keys.length) ctx.addIssue({ code: 'custom', message: 'Reading keys must be unique' })
})
export type TelemetrySnapshot = z.infer<typeof telemetrySnapshotSchema>

export interface TelemetryThresholds {
	/** Older than this, the data is Stale. */
	staleAfterMs: number
	/** Older than this, the machine is Offline. */
	offlineAfterMs: number
	/** This many failed reads in a row is Offline whatever the age of the last good reading. */
	offlineAfterFailures: number
}
export const DEFAULT_TELEMETRY_THRESHOLDS: TelemetryThresholds = { staleAfterMs: 10_000, offlineAfterMs: 30_000, offlineAfterFailures: 3 }

export function validateThresholds(thresholds: TelemetryThresholds): TelemetryThresholds {
	const { staleAfterMs, offlineAfterMs, offlineAfterFailures } = thresholds
	if (!Number.isFinite(staleAfterMs) || staleAfterMs <= 0) throw new Error('staleAfterMs must be a positive number')
	if (!Number.isFinite(offlineAfterMs) || offlineAfterMs <= staleAfterMs) throw new Error('offlineAfterMs must be greater than staleAfterMs')
	if (!Number.isInteger(offlineAfterFailures) || offlineAfterFailures < 1) throw new Error('offlineAfterFailures must be a positive integer')
	return thresholds
}

/** What the API returns for one source. Carries the server's own measurements so a browser never depends on its own clock. */
export interface TelemetryView {
	schemaVersion: typeof TELEMETRY_SCHEMA_VERSION
	sourceId: string
	machineName: string
	/** A simulated source says so, so a fake can never be mistaken for a real machine. */
	simulated: boolean
	status: TelemetryStatus
	reason: TelemetryReason
	readings: TelemetryReading[]
	/** The sensor's reported time, shown as "last update". Null until a first successful read. */
	observedAt: number | null
	/** When the server last read the source successfully, on the server's clock. */
	receivedAt: number | null
	serverTime: number
	/** Age of the data at `serverTime`: the effective observation time, never later than receipt. Null with no data. */
	ageMs: number | null
	consecutiveFailures: number
	lastFailure: TelemetryFailure | null
	thresholds: TelemetryThresholds
}

/** The age rules alone, so the browser can keep degrading a card between polls (or when a poll never arrives). */
export function statusFromAge(ageMs: number | null, thresholds: TelemetryThresholds): { status: TelemetryStatus; reason: TelemetryReason } {
	if (ageMs === null) return { status: 'offline', reason: 'no-data' }
	if (ageMs > thresholds.offlineAfterMs) return { status: 'offline', reason: 'data-expired' }
	if (ageMs > thresholds.staleAfterMs) return { status: 'stale', reason: 'data-aging' }
	return { status: 'fresh', reason: 'ok' }
}

export interface FreshnessInput {
	now: number
	receivedAt: number | null
	observedAt: number | null
	consecutiveFailures: number
	thresholds: TelemetryThresholds
}

/**
 * Freshness is measured on the server's clock. A sensor that reports an old `observedAt` is lagging even though the
 * link is up, so the effective observation time is the older of the sensor's time and the time of receipt; a sensor
 * clock in the future cannot make data look fresher than the moment it arrived.
 */
export function classifyTelemetry(input: FreshnessInput): { status: TelemetryStatus; reason: TelemetryReason; ageMs: number | null } {
	const { now, receivedAt, observedAt, consecutiveFailures, thresholds } = input
	if (receivedAt === null) return { status: 'offline', reason: 'no-data', ageMs: null }
	const effective = Math.min(observedAt ?? receivedAt, receivedAt)
	const ageMs = Math.max(0, now - effective)
	if (consecutiveFailures >= thresholds.offlineAfterFailures) return { status: 'offline', reason: 'reader-failing', ageMs }
	const byAge = statusFromAge(ageMs, thresholds)
	// Data that arrived promptly but describes an old moment is the sensor lagging, not the link.
	const lagging = byAge.status !== 'fresh' && now - receivedAt <= thresholds.staleAfterMs
	return { ...byAge, reason: lagging ? 'sensor-lagging' : byAge.reason, ageMs }
}

/**
 * Viam sensors return a flat `{ name: value }` map. Anything that is not a finite number, string, boolean or null is
 * dropped, and the map is bounded, so one odd reading cannot make the whole snapshot invalid or unbounded.
 */
export function normalizeReadingsMap(raw: unknown, labels: Readonly<Record<string, { label?: string; unit?: string }>> = {}): TelemetryReading[] {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('Readings must be an object')
	const out: TelemetryReading[] = []
	for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
		const key = name.toLowerCase().replace(/[^a-z0-9_.-]+/g, '_').replace(/^[^a-z]+/, '').slice(0, 40)
		if (!key || out.some((reading) => reading.key === key)) continue
		const acceptable = value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && value.length <= TELEMETRY_LIMITS.maxStringLength)
		if (!acceptable) continue
		const meta = labels[name] ?? labels[key] ?? {}
		out.push({ key, label: (meta.label ?? name).slice(0, 60), value: value as TelemetryReading['value'], ...(meta.unit ? { unit: meta.unit } : {}) })
		if (out.length >= TELEMETRY_LIMITS.maxReadings) break
	}
	return out
}

/** The card stores one property of its own: which source to show. Everything it displays comes from the server. */
export const telemetryCardShapeProps = {
	w: T.nonZeroNumber,
	h: T.nonZeroNumber,
	sourceId: T.string.check('sourceId', (value) => {
		if (!TELEMETRY_SOURCE_ID.test(value)) throw new Error('Expected a telemetry source id')
	}),
}
export interface TelemetryCardShapeProps { w: number; h: number; sourceId: string }
