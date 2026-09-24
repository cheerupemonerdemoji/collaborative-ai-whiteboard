import { type ReactNode, useMemo } from 'react'
import { createTLStore, defaultShapeUtils, Tldraw } from 'tldraw'
import type { TLRecord } from '@tldraw/tlschema'
import { multiplayerAssetStore } from '../multiplayerAssetStore'
import '../account-history.css'

export interface HistoricalCanvasProps {
	snapshot: unknown
	selectedAt: number | string
	onReturnToLive(): void
	actions?: ReactNode
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isTLRecord(value: unknown): value is TLRecord {
	return isRecord(value) && typeof value.id === 'string' && typeof value.typeName === 'string'
}

function parseSnapshot(value: unknown): unknown {
	if (typeof value !== 'string') return value
	try { return JSON.parse(value) as unknown } catch { return value }
}

/** Accepts history's {document: recordMap}, TLSocketRoom snapshots, or tldraw store snapshots. */
function recordsFromSnapshot(input: unknown): TLRecord[] {
	const value = parseSnapshot(input)
	if (Array.isArray(value)) return value.filter(isTLRecord)
	if (!isRecord(value)) return []
	if ('snapshot' in value) return recordsFromSnapshot(value.snapshot)
	if (Array.isArray(value.documents)) {
		return value.documents.map((entry) => isRecord(entry) && 'state' in entry ? entry.state : entry).filter(isTLRecord)
	}
	if (isRecord(value.document)) {
		if (isRecord(value.document.store)) return Object.values(value.document.store).filter(isTLRecord)
		return Object.values(value.document).filter(isTLRecord)
	}
	if (isRecord(value.store)) return Object.values(value.store).filter(isTLRecord)
	return Object.values(value).filter(isTLRecord)
}

function formatDate(value: number | string) {
	const date = new Date(typeof value === 'number' && value < 1_000_000_000_000 ? value * 1000 : value)
	return Number.isNaN(date.valueOf()) ? 'Unknown time' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' }).format(date)
}

export function HistoricalCanvas({ snapshot, selectedAt, onReturnToLive, actions }: HistoricalCanvasProps) {
	const prepared = useMemo(() => {
		try {
			const records = recordsFromSnapshot(snapshot)
			if (!records.length) throw new Error('This version does not contain a readable canvas snapshot.')
			const initialData = Object.fromEntries(records.map((record) => [record.id, record])) as Record<TLRecord['id'], TLRecord>
			return { store: createTLStore({ initialData, shapeUtils: defaultShapeUtils, assets: multiplayerAssetStore }), error: null }
		} catch (caught) {
			return { store: null, error: caught instanceof Error ? caught.message : 'This version could not be displayed.' }
		}
	}, [snapshot])

	return <section className="aw-history-viewer" aria-label="Historical whiteboard view">
		<header className="aw-history-viewer-header">
			<div><span className="aw-history-badge">Read-only history</span><strong>{formatDate(selectedAt)}</strong><small>You are viewing an earlier version. The live whiteboard has not changed.</small></div>
			<div className="aw-history-viewer-actions">{actions}<button className="aw-primary-button" onClick={onReturnToLive}>Return to live board</button></div>
		</header>
		<div className="aw-history-canvas">
			{prepared.store ? <Tldraw
				store={prepared.store}
				hideUi
				onMount={(editor) => {
					editor.updateInstanceState({ isReadonly: true })
					editor.zoomToFit()
				}}
			/> : <div className="aw-snapshot-error" role="alert"><strong>Version unavailable</strong><span>{prepared.error}</span></div>}
		</div>
	</section>
}
