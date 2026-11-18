import { statusFromAge, TELEMETRY_STATUSES, type TelemetryFailure, type TelemetryReading, type TelemetryReason, type TelemetryStatus, type TelemetryView } from '../../shared/telemetry'

/**
 * What a card shows, derived from the last response, when it arrived, and the time now. Pure, so every state
 * (including the ones that only arise when the network or the server goes away) can be tested without a browser.
 */
export type CardReason = TelemetryReason | 'server-unreachable' | 'unavailable' | 'loading'
export interface CardState {
	/** `loading` only until the first response, and `unavailable` when the board does not offer this source. */
	status: TelemetryStatus | 'loading' | 'unavailable'
	reason: CardReason
	machineName: string | null
	simulated: boolean
	readings: TelemetryReading[]
	observedAt: number | null
	ageMs: number | null
	lastFailure: TelemetryFailure | null
}

export interface CardInputs {
	view: TelemetryView | null
	/** `Date.now()` in the browser when `view` arrived. */
	fetchedAt: number | null
	now: number
	/** The most recent poll failed to reach the server at all. */
	requestFailed: boolean
	/** The server answered that this source is not available on this board. */
	notFound: boolean
}

const SEVERITY: Record<TelemetryStatus, number> = { fresh: 0, stale: 1, offline: 2 }
const worse = (a: TelemetryStatus, b: TelemetryStatus): TelemetryStatus => (SEVERITY[a] >= SEVERITY[b] ? a : b)

export function cardState({ view, fetchedAt, now, requestFailed, notFound }: CardInputs): CardState {
	const empty = { machineName: null, simulated: false, readings: [], observedAt: null, ageMs: null, lastFailure: null }
	if (notFound) return { ...empty, status: 'unavailable', reason: 'unavailable' }
	if (!view || fetchedAt === null) {
		return requestFailed
			? { ...empty, status: 'offline', reason: 'server-unreachable' }
			: { ...empty, status: 'loading', reason: 'loading' }
	}
	// Age keeps growing in the browser between polls, using only elapsed local time (never the browser's wall clock against
	// the server's), so a card whose polls stop arriving still degrades instead of freezing on Fresh.
	const ageMs = view.ageMs === null ? null : view.ageMs + Math.max(0, now - fetchedAt)
	const byAge = statusFromAge(ageMs, view.thresholds)
	let status = worse(view.status, byAge.status)
	let reason: CardReason = SEVERITY[byAge.status] > SEVERITY[view.status] ? byAge.reason : view.reason
	// If the server cannot be reached the card cannot confirm that the data is still current, so it is never shown as Fresh.
	if (requestFailed) {
		status = worse(status, 'stale')
		if (status === 'stale') reason = 'server-unreachable'
	}
	return { status, reason, machineName: view.machineName, simulated: view.simulated, readings: view.readings, observedAt: view.observedAt, ageMs, lastFailure: view.lastFailure }
}

export const isTelemetryStatus = (value: string): value is TelemetryStatus => (TELEMETRY_STATUSES as readonly string[]).includes(value)

export function formatAge(ageMs: number | null): string {
	if (ageMs === null) return 'never'
	const seconds = Math.floor(ageMs / 1000)
	if (seconds < 5) return 'just now'
	if (seconds < 60) return `${seconds}s ago`
	const minutes = Math.floor(seconds / 60)
	if (minutes < 60) return `${minutes}m ago`
	const hours = Math.floor(minutes / 60)
	return hours < 48 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`
}

export function formatReadingValue(reading: TelemetryReading): string {
	const { value, unit } = reading
	if (value === null) return '—'
	if (typeof value === 'boolean') return value ? 'Yes' : 'No'
	const text = typeof value === 'number' ? (Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, '')) : value
	return unit ? `${text} ${unit}` : text
}

const REASON_TEXT: Record<CardReason, string> = {
	ok: 'Receiving readings',
	'sensor-lagging': 'The sensor is reporting old data',
	'data-aging': 'No new readings recently',
	'data-expired': 'No readings for a long time',
	'no-data': 'No reading received yet',
	'reader-failing': 'The server cannot read this machine',
	'server-unreachable': 'Cannot reach the server',
	unavailable: 'This source is not available on this board',
	loading: 'Connecting…',
}
export const reasonText = (reason: CardReason): string => REASON_TEXT[reason]

export const POLL_INTERVAL_MS = 5_000
