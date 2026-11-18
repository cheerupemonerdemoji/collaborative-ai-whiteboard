import { createContext, useContext, useEffect, useState } from 'react'
import { BaseBoxShapeUtil, HTMLContainer, RecordProps, type TLShape } from 'tldraw'
import {
	TELEMETRY_CARD_SHAPE_TYPE,
	TELEMETRY_CARD_SIZE,
	TELEMETRY_STATUS_LABELS,
	telemetryCardShapeProps,
	type TelemetryCardShapeProps,
	type TelemetryStatus,
	type TelemetryView,
} from '../../shared/telemetry'
import { fetchTelemetry } from './telemetry-api'
import { cardState, formatAge, formatReadingValue, isTelemetryStatus, POLL_INTERVAL_MS, reasonText, type CardState } from './telemetry-model'
import './telemetry-card.css'

declare module '@tldraw/tlschema' {
	export interface TLGlobalShapePropsMap {
		[TELEMETRY_CARD_SHAPE_TYPE]: TelemetryCardShapeProps
	}
}

export type TelemetryCardShape = TLShape<typeof TELEMETRY_CARD_SHAPE_TYPE>

/** The board the card is on. Absent in the read-only history viewer, where a card has nothing live to show. */
export const TelemetryBoardContext = createContext<string | null>(null)

/** Polls the server while the page is visible and ticks once a second so the age keeps counting between polls. */
function useCardState(boardId: string | null, sourceId: string): CardState {
	const [view, setView] = useState<{ value: TelemetryView; fetchedAt: number } | null>(null)
	const [requestFailed, setRequestFailed] = useState(false)
	const [notFound, setNotFound] = useState(false)
	const [now, setNow] = useState(() => Date.now())

	useEffect(() => {
		if (!boardId) return
		const controller = new AbortController()
		let timer: ReturnType<typeof setTimeout> | undefined
		const poll = async () => {
			if (typeof document === 'undefined' || document.visibilityState !== 'hidden') {
				const result = await fetchTelemetry(boardId, sourceId, controller.signal)
				if (controller.signal.aborted) return
				if (result.kind === 'view') { setView({ value: result.view, fetchedAt: Date.now() }); setRequestFailed(false); setNotFound(false) }
				else if (result.kind === 'not-found') { setNotFound(true); setRequestFailed(false) }
				else setRequestFailed(true)
			}
			if (!controller.signal.aborted) timer = setTimeout(() => void poll(), POLL_INTERVAL_MS)
		}
		void poll()
		const tick = setInterval(() => setNow(Date.now()), 1_000)
		return () => { controller.abort(); if (timer) clearTimeout(timer); clearInterval(tick) }
	}, [boardId, sourceId])

	return cardState({ view: view?.value ?? null, fetchedAt: view?.fetchedAt ?? null, now, requestFailed, notFound: notFound || !boardId })
}

const STATUS_CLASS: Record<CardState['status'], string> = { fresh: 'fresh', stale: 'stale', offline: 'offline', loading: 'loading', unavailable: 'offline' }

function badgeLabel(status: CardState['status']): string {
	if (status === 'loading') return 'Connecting'
	if (status === 'unavailable') return 'Unavailable'
	return isTelemetryStatus(status) ? TELEMETRY_STATUS_LABELS[status as TelemetryStatus] : status
}

/** Everything the card draws, from one `CardState`, so it can be rendered statically in tests. */
export function TelemetryCardView({ state, width, height, sourceId }: { state: CardState; width: number; height: number; sourceId: string }) {
	const lastUpdate = state.observedAt === null ? 'No update yet' : `${formatAge(state.ageMs)} · ${new Date(state.observedAt).toLocaleTimeString()}`
	return <HTMLContainer className={`telemetry-card telemetry-card-${STATUS_CLASS[state.status]}`} style={{ width, height }}>
		<div className="telemetry-kicker">
			<span>Machine status</span>
			{state.simulated ? <span className="telemetry-simulated" title="These readings come from a simulated sensor, not a real machine.">Simulated</span> : null}
		</div>
		<div className="telemetry-heading">
			<strong>{state.machineName ?? sourceId}</strong>
			<span className={`telemetry-badge telemetry-badge-${STATUS_CLASS[state.status]}`} role="status">{badgeLabel(state.status)}</span>
		</div>
		<div className="telemetry-reason">{reasonText(state.reason)}</div>
		{state.readings.length > 0
			? <dl className="telemetry-readings">{state.readings.map((reading) => <div key={reading.key}><dt>{reading.label}</dt><dd>{formatReadingValue(reading)}</dd></div>)}</dl>
			: <div className="telemetry-empty">No readings to show</div>}
		<div className="telemetry-footer">Last update: {lastUpdate}</div>
	</HTMLContainer>
}

function LiveTelemetryCard({ shape }: { shape: TelemetryCardShape }) {
	const boardId = useContext(TelemetryBoardContext)
	const state = useCardState(boardId, shape.props.sourceId)
	return <TelemetryCardView state={state} width={shape.props.w} height={shape.props.h} sourceId={shape.props.sourceId} />
}

export class TelemetryCardShapeUtil extends BaseBoxShapeUtil<TelemetryCardShape> {
	static override type = TELEMETRY_CARD_SHAPE_TYPE
	static override props: RecordProps<TelemetryCardShape> = telemetryCardShapeProps

	override getDefaultProps(): TelemetryCardShape['props'] {
		return { ...TELEMETRY_CARD_SIZE, sourceId: 'unset' }
	}

	override canEdit() { return false }
	override canBind() { return true }

	override component(shape: TelemetryCardShape) {
		return <LiveTelemetryCard shape={shape} />
	}

	override getIndicatorPath(shape: TelemetryCardShape) {
		const path = new Path2D()
		path.roundRect(0, 0, shape.props.w, shape.props.h, 16)
		return path
	}

	override getText(shape: TelemetryCardShape) { return shape.props.sourceId }
}

export const telemetryCardShapeUtils = [TelemetryCardShapeUtil]
