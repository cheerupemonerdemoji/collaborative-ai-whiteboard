import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { apiRequest } from '../auth'
import { HistoricalCanvas } from './HistoricalCanvas'
import '../account-history.css'

export type HistorySource = 'human' | 'ai' | 'system'

export interface HistoryActor {
	id: string
	displayName: string
	avatarUrl?: string | null
}

export interface HistoryEvent {
	id: number | string
	boardId: string
	actorUserId: string | null
	actor?: HistoryActor | null
	sessionId?: string | null
	eventType: string
	entityType: string | null
	entityId: string | null
	source: HistorySource
	createdAt: number | string
	metadata: Record<string, unknown>
	documentClock?: number | null
}

interface HistoryResponse {
	events: HistoryEvent[]
	nextCursor?: number | string | null
	actors?: HistoryActor[]
}

interface SnapshotResponse {
	event?: HistoryEvent
	snapshot: unknown
}

export interface HistoryPanelProps {
	boardId: string
	canRestore: boolean
	knownActors?: readonly HistoryActor[]
	expectedClock?: number | null
	getExpectedClock?: () => number | Promise<number>
	onClose(): void
	onRestored?: (result: unknown) => void
}

const COMMON_EVENT_TYPES = [
	'board.created', 'board.renamed', 'object.created', 'object.edited', 'object.moved',
	'object.deleted', 'ai.requested', 'ai.suggestion_generated', 'ai.suggestion_accepted',
	'ai.suggestion_rejected', 'checkpoint.created', 'restore.completed', 'permissions.changed',
]

function eventLabel(value: string) {
	return value.replace(/[._-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function historyDate(value: number | string) {
	return new Date(typeof value === 'number' && value < 1_000_000_000_000 ? value * 1000 : value)
}

function formatDate(value: number | string, includeDate = true) {
	const date = historyDate(value)
	if (Number.isNaN(date.valueOf())) return 'Unknown time'
	return new Intl.DateTimeFormat(undefined, includeDate ? { dateStyle: 'medium', timeStyle: 'short' } : { timeStyle: 'short' }).format(date)
}

function metadataText(metadata: Record<string, unknown>, keys: string[]) {
	for (const key of keys) if (typeof metadata[key] === 'string' && metadata[key]) return metadata[key] as string
	return null
}

function actorName(event: HistoryEvent) {
	return event.actor?.displayName ?? metadataText(event.metadata, ['actorDisplayName', 'userName', 'displayName']) ?? (event.source === 'ai' ? 'AI' : event.source === 'system' ? 'System' : 'A collaborator')
}

function describeEvent(event: HistoryEvent) {
	const explicit = metadataText(event.metadata, ['description', 'summary'])
	if (explicit) return explicit
	const objectName = metadataText(event.metadata, ['objectName', 'label', 'name'])
	const descriptions: Record<string, string> = {
		'board.created': 'created this whiteboard', 'board.renamed': 'renamed this whiteboard', 'object.created': 'added an object',
		'object.edited': 'edited an object', 'object.moved': 'moved an object', 'object.deleted': 'deleted an object',
		'object.restored': 'restored an object', 'ai.requested': 'asked AI for help', 'ai.suggestion_generated': 'generated an AI suggestion',
		'ai.suggestion_accepted': 'accepted an AI suggestion', 'ai.suggestion_rejected': 'rejected an AI suggestion',
		'checkpoint.created': 'created a checkpoint', 'restore.started': 'started restoring an earlier version',
		'restore.completed': 'restored an earlier version', 'permissions.changed': 'changed sharing permissions',
		'collaborator.added': 'added a collaborator', 'collaborator.removed': 'removed a collaborator',
	}
	const description = descriptions[event.eventType] ?? eventLabel(event.eventType).toLowerCase()
	return objectName ? `${description}: “${objectName}”` : description
}

function sourceSymbol(source: HistorySource) {
	return source === 'ai' ? '✦' : source === 'system' ? '⚙' : '●'
}

export function HistoryPanel({ boardId, canRestore, knownActors = [], expectedClock, getExpectedClock, onClose, onRestored }: HistoryPanelProps) {
	const [events, setEvents] = useState<HistoryEvent[]>([])
	const [serverActors, setServerActors] = useState<HistoryActor[]>([])
	const [nextCursor, setNextCursor] = useState<number | string | null>(null)
	const [source, setSource] = useState('')
	const [userId, setUserId] = useState('')
	const [eventType, setEventType] = useState('')
	const [boardOnly, setBoardOnly] = useState(false)
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState<string | null>(null)
	const [selectedEvent, setSelectedEvent] = useState<HistoryEvent | null>(null)
	const [snapshot, setSnapshot] = useState<unknown>(null)
	const [snapshotLoading, setSnapshotLoading] = useState(false)
	const [restoreConfirm, setRestoreConfirm] = useState(false)
	const [restoring, setRestoring] = useState(false)
	const [checkpointOpen, setCheckpointOpen] = useState(false)
	const [checkpointLabel, setCheckpointLabel] = useState('')
	const [checkpointing, setCheckpointing] = useState(false)

	const fetchHistory = useCallback(async (cursor?: number | string | null) => {
		setLoading(true)
		setError(null)
		try {
			const query = new URLSearchParams({ limit: '50' })
			if (cursor !== undefined && cursor !== null) query.set('before', String(cursor))
			if (source) query.set('source', source)
			if (userId) query.set('userId', userId)
			if (eventType) query.set('eventType', eventType)
			if (boardOnly) query.set('entityType', 'board')
			const result = await apiRequest<HistoryResponse>(`/api/boards/${encodeURIComponent(boardId)}/history?${query}`)
			setEvents((current) => cursor === undefined ? result.events : [...current, ...result.events])
			setNextCursor(result.nextCursor ?? null)
			if (result.actors) setServerActors(result.actors)
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : 'Could not load this whiteboard’s history.')
		} finally {
			setLoading(false)
		}
	}, [boardId, source, userId, eventType, boardOnly])

	useEffect(() => {
		void fetchHistory()
	}, [fetchHistory])

	const actors = useMemo(() => {
		const found = new Map([...knownActors, ...serverActors].map((actor) => [actor.id, actor]))
		for (const event of events) {
			if (event.actor) found.set(event.actor.id, event.actor)
			else if (event.actorUserId && !found.has(event.actorUserId)) found.set(event.actorUserId, { id: event.actorUserId, displayName: `User ${event.actorUserId.slice(0, 8)}` })
		}
		return [...found.values()].sort((a, b) => a.displayName.localeCompare(b.displayName))
	}, [events, knownActors, serverActors])

	const eventTypes = useMemo(() => [...new Set([...COMMON_EVENT_TYPES, ...events.map((event) => event.eventType)])].sort(), [events])
	const visibleEvents = boardOnly ? events.filter((event) => event.entityType === 'board' || event.eventType.startsWith('board.')) : events
	const selectedIndex = selectedEvent ? visibleEvents.findIndex((event) => String(event.id) === String(selectedEvent.id)) : -1

	async function viewEvent(event: HistoryEvent) {
		setError(null)
		setSelectedEvent(event)
		setSnapshot(null)
		setSnapshotLoading(true)
		setRestoreConfirm(false)
		try {
			const result = await apiRequest<SnapshotResponse>(`/api/boards/${encodeURIComponent(boardId)}/history/${encodeURIComponent(String(event.id))}/snapshot`)
			setSelectedEvent(result.event ?? event)
			setSnapshot(result.snapshot)
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : 'Could not open that version.')
			setSelectedEvent(null)
		} finally {
			setSnapshotLoading(false)
		}
	}

	async function resolveExpectedClock() {
		if (getExpectedClock) return await getExpectedClock()
		if (expectedClock !== undefined && expectedClock !== null) return expectedClock
		const live = await apiRequest<{ clock: number }>(`/api/rooms/${encodeURIComponent(boardId)}/canvas`)
		return live.clock
	}

	async function restoreSelected() {
		if (!selectedEvent) return
		setRestoring(true)
		setError(null)
		try {
			const liveClock = await resolveExpectedClock()
			const result = await apiRequest<unknown>(`/api/boards/${encodeURIComponent(boardId)}/restore`, {
				method: 'POST',
				body: JSON.stringify({ eventId: selectedEvent.id, expectedClock: liveClock }),
			})
			setRestoreConfirm(false)
			setSelectedEvent(null)
			setSnapshot(null)
			await fetchHistory()
			onRestored?.(result)
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : 'The version could not be restored.')
		} finally {
			setRestoring(false)
		}
	}

	async function createCheckpoint(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		setCheckpointing(true)
		setError(null)
		try {
			await apiRequest(`/api/boards/${encodeURIComponent(boardId)}/checkpoints`, {
				method: 'POST',
				body: JSON.stringify({ ...(checkpointLabel.trim() ? { label: checkpointLabel.trim() } : {}) }),
			})
			setCheckpointLabel('')
			setCheckpointOpen(false)
			await fetchHistory()
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : 'Could not create the checkpoint.')
		} finally {
			setCheckpointing(false)
		}
	}

	function returnToLive() {
		setSelectedEvent(null)
		setSnapshot(null)
		setRestoreConfirm(false)
	}

	return <>
		<aside className="aw-history-panel" aria-label="Whiteboard history">
			<header className="aw-history-header"><div><h2>History</h2><p>See who changed what and when.</p></div><button className="aw-icon-button" onClick={onClose} aria-label="Close history">×</button></header>
			<div className="aw-history-actions"><button onClick={() => void fetchHistory()}>Refresh</button>{canRestore ? <button onClick={() => setCheckpointOpen((open) => !open)}>＋ Checkpoint</button> : null}</div>
			{checkpointOpen ? <form className="aw-checkpoint-form" onSubmit={(event) => void createCheckpoint(event)}>
				<label><span>Checkpoint name <em>optional</em></span><input maxLength={120} value={checkpointLabel} onChange={(event) => setCheckpointLabel(event.target.value)} placeholder="Before redesign" autoFocus /></label>
				<div><button type="button" onClick={() => setCheckpointOpen(false)}>Cancel</button><button className="aw-primary-button" disabled={checkpointing}>{checkpointing ? 'Saving…' : 'Save checkpoint'}</button></div>
			</form> : null}
			<div className="aw-history-filters">
				<label><span>Person</span><select value={userId} onChange={(event) => setUserId(event.target.value)}><option value="">Everyone</option>{actors.map((actor) => <option value={actor.id} key={actor.id}>{actor.displayName}</option>)}</select></label>
				<label><span>Source</span><select value={source} onChange={(event) => setSource(event.target.value)}><option value="">All activity</option><option value="human">People</option><option value="ai">AI only</option><option value="system">System</option></select></label>
				<label className="aw-filter-wide"><span>Event</span><select value={eventType} onChange={(event) => setEventType(event.target.value)}><option value="">All event types</option>{eventTypes.map((type) => <option value={type} key={type}>{eventLabel(type)}</option>)}</select></label>
				<label className="aw-check-filter"><input type="checkbox" checked={boardOnly} onChange={(event) => setBoardOnly(event.target.checked)} /> Board details only</label>
			</div>
			{error ? <div className="aw-error aw-history-error" role="alert">{error}</div> : null}
			<div className="aw-timeline">
				{loading && !events.length ? <div className="aw-history-empty" role="status">Loading history…</div> : null}
				{!loading && !visibleEvents.length ? <div className="aw-history-empty"><strong>No matching activity</strong><span>Try changing the filters above.</span></div> : null}
				{visibleEvents.map((event, index) => <button className="aw-timeline-event" key={event.id} onClick={() => void viewEvent(event)}>
					<span className={`aw-source-dot aw-source-${event.source}`} aria-label={event.source}>{sourceSymbol(event.source)}</span>
					<span className="aw-event-body"><span><strong>{actorName(event)}</strong> {describeEvent(event)}</span><small>{formatDate(event.createdAt, index === 0 || historyDate(event.createdAt).toDateString() !== historyDate(visibleEvents[index - 1]?.createdAt ?? 0).toDateString())}</small>{event.entityId ? <code>{event.entityId}</code> : null}</span>
					<span aria-hidden="true">›</span>
				</button>)}
				{nextCursor !== null ? <button className="aw-load-more" disabled={loading} onClick={() => void fetchHistory(nextCursor)}>{loading ? 'Loading…' : 'Load older activity'}</button> : null}
			</div>
		</aside>
		{snapshotLoading && selectedEvent ? <div className="aw-history-loading" role="status">Opening version…</div> : null}
		{selectedEvent && snapshot !== null ? <HistoricalCanvas
			snapshot={snapshot}
			selectedAt={selectedEvent.createdAt}
			onReturnToLive={returnToLive}
			actions={<>
				<div className="aw-version-nav">
					<button disabled={selectedIndex < 0 || selectedIndex >= visibleEvents.length - 1} onClick={() => { const event = visibleEvents[selectedIndex + 1]; if (event) void viewEvent(event) }}>← Older</button>
					<button disabled={selectedIndex <= 0} onClick={() => { const event = visibleEvents[selectedIndex - 1]; if (event) void viewEvent(event) }}>Newer →</button>
				</div>
				{canRestore ? restoreConfirm ? <div className="aw-restore-confirm" role="alertdialog" aria-label="Confirm version restore">
					<span>Restore this version as the new live version? The current board will be checkpointed first.</span>
					<button onClick={() => setRestoreConfirm(false)}>Cancel</button><button className="aw-danger-button" disabled={restoring} onClick={() => void restoreSelected()}>{restoring ? 'Restoring…' : 'Yes, restore'}</button>
				</div> : <button className="aw-danger-outline" onClick={() => setRestoreConfirm(true)}>Restore this version</button> : null}
			</>}
		/> : null}
	</>
}
