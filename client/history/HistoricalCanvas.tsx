import { type ReactNode, useMemo } from 'react'
import { Tldraw } from 'tldraw'
import { multiplayerAssetStore } from '../multiplayerAssetStore'
import { createHistoricalStore } from './historicalStore'
import '../account-history.css'

export interface HistoricalCanvasProps {
	snapshot: unknown
	selectedAt: number | string
	onReturnToLive(): void
	actions?: ReactNode
}

function formatDate(value: number | string) {
	const date = new Date(typeof value === 'number' && value < 1_000_000_000_000 ? value * 1000 : value)
	return Number.isNaN(date.valueOf()) ? 'Unknown time' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' }).format(date)
}

export function HistoricalCanvas({ snapshot, selectedAt, onReturnToLive, actions }: HistoricalCanvasProps) {
	const prepared = useMemo(() => {
		try {
			return { store: createHistoricalStore(snapshot, multiplayerAssetStore), error: null }
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
