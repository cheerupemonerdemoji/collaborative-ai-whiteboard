import { useSync } from '@tldraw/sync'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { atom, createShapeId, createUserId, type Editor, Tldraw, UserRecordType } from 'tldraw'
import { CAD_CARD_SIZE, CAD_REVIEW_SHAPE_TYPE, type CadModel } from '../../shared/cad-model'
import { syncSchema } from '../../shared/schema'
import { apiRequest, useAuth } from '../auth'
import { setCadBoardId, submitCadAssemblySample, submitCadSample } from '../cad/cad-api'
import { CAD_REVIEW_OPEN_EVENT, cadReviewShapeUtils } from '../cad/CadReviewShape'
import { chartShapeUtils } from '../charts/ChartShape'
import { CadUploadDialog } from '../cad/CadUploadDialog'
import { copyText, SharingPanel } from '../SharingPanel'
import { loadDisplayTheme, saveDisplayTheme, type DisplayTheme } from '../display-theme'
import { getBookmarkPreview } from '../getBookmarkPreview'
import { HistoryPanel } from '../history/HistoryPanel'
import { attachMeasurementReporter } from '../layout/attach-measurement-reporter'
import { createMultiplayerAssetStore } from '../multiplayerAssetStore'
import { SemanticInspectorPanel } from '../semantic/SemanticInspectorPanel'
import { HelpLink } from '../help/HelpPage'
import { TELEMETRY_CARD_SHAPE_TYPE, TELEMETRY_CARD_SIZE } from '../../shared/telemetry'
import { listTelemetrySources } from '../telemetry/telemetry-api'
import { TelemetryBoardContext, telemetryCardShapeUtils } from '../telemetry/TelemetryCardShape'
import { type BoardSummary } from './Dashboard'
import '../account-history.css'

const tldrawLicenseKey = import.meta.env.VITE_TLDRAW_LICENSE_KEY
const CadReviewPanel = lazy(() => import('../cad/CadReviewPanel').then(({ CadReviewPanel: component }) => ({ default: component })))

const interactionModeStorageKey = 'aw-interaction-mode'

type InteractionMode = 'edit' | 'view'

function requiresEditConfirmation() {
	return window.matchMedia('(any-pointer: coarse)').matches || window.matchMedia('(max-width: 640px)').matches
}

function loadInteractionMode(): InteractionMode {
	// Touch/mobile sessions always begin safely in View mode. A previously saved
	// desktop preference must never silently enable editing on these devices.
	if (requiresEditConfirmation()) return 'view'

	try {
		const saved = window.localStorage.getItem(interactionModeStorageKey)
		if (saved === 'edit' || saved === 'view') return saved
	} catch {
		// Storage can be unavailable in private or restricted browser contexts.
	}

	return 'edit'
}

function saveInteractionMode(mode: InteractionMode) {
	try {
		window.localStorage.setItem(interactionModeStorageKey, mode)
	} catch {
		// The mode still works for this page when storage is unavailable.
	}
}

function initials(name: string) {
	return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') || '?'
}

function CanvasErrorFallback({ error }: { error: unknown }) {
	const message = error instanceof Error ? error.message : String(error)

	return <main className="aw-auth-screen">
		<section className="aw-status-card" role="alert">
			<div className="aw-brand-mark" aria-hidden="true">✦</div>
			<h1>Whiteboard canvas failed</h1>
			<p>{message || 'The canvas encountered an unexpected error.'}</p>
			<button className="aw-primary-button" onClick={() => window.location.reload()}>Try again</button>
		</section>
	</main>
}

const tldrawComponents = { ErrorFallback: CanvasErrorFallback }
const roomShapeUtils = [...cadReviewShapeUtils, ...telemetryCardShapeUtils, ...chartShapeUtils]

export function Room() {
	const { roomId = 'demo' } = useParams<{ roomId: string }>()
	const { user, logout } = useAuth()
	const navigate = useNavigate()
	const [board, setBoard] = useState<BoardSummary | null>(null)
	const [boardError, setBoardError] = useState<string | null>(null)
	const [historyOpen, setHistoryOpen] = useState(false)
	const [inspectorOpen, setInspectorOpen] = useState(false)
	const [presenting, setPresenting] = useState(false)
	const [menuCollapsed, setMenuCollapsed] = useState(() => window.matchMedia('(max-width: 640px)').matches)
	const [interactionMode, setInteractionMode] = useState<InteractionMode>(loadInteractionMode)
	const [shareOpen, setShareOpen] = useState(false)
	const [linkCopied, setLinkCopied] = useState(false)
	const [displayTheme, setDisplayTheme] = useState<DisplayTheme>(loadDisplayTheme)
	const [cadModelRecordId, setCadModelRecordId] = useState<string | null>(null)
	const [cadUploadOpen, setCadUploadOpen] = useState(false)
	const [cadBusy, setCadBusy] = useState<string | null>(null)
	const [cadError, setCadError] = useState<string | null>(null)
	const [telemetryNotice, setTelemetryNotice] = useState<string | null>(null)
	const editorRef = useRef<Editor | null>(null)
	const stopReporterRef = useRef<(() => void) | null>(null)

	const assets = useMemo(() => createMultiplayerAssetStore(roomId), [roomId])
	// Use the signed-in person's identity across devices instead of an anonymous
	// browser preference. This is display presence; the server still authorizes the cookie.
	const users = useMemo(() => ({ currentUser: atom('whiteboard user', user ? UserRecordType.create({
		id: createUserId(user.id), name: user.displayName,
		color: `hsl(${Array.from(user.id).reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) % 360, 0)}, 65%, 45%)`,
	}) : null) }), [user?.id, user?.displayName])
	const store = useSync({ uri: `${window.location.origin}/api/connect/${roomId}`, assets, schema: syncSchema, users })
	const live = store.status === 'synced-remote' && store.connectionStatus === 'online'
	const connectionLabel = live ? 'Live' : store.status === 'loading' ? 'Connecting…' : 'Reconnecting…'

	const loadBoard = useCallback(async () => {
		setBoardError(null)
		try {
			const result = await apiRequest<{ board: BoardSummary }>(`/api/boards/${encodeURIComponent(roomId)}`)
			setBoard(result.board)
		} catch (caught) {
			setBoard(null)
			setBoardError(caught instanceof Error ? caught.message : 'Could not load this whiteboard.')
		}
	}, [roomId])

	useEffect(() => {
		void loadBoard()
	}, [loadBoard])

	// CAD cards and the review panel read files through this board's authenticated asset route.
	useEffect(() => {
		setCadBoardId(roomId)
		return () => setCadBoardId(null)
	}, [roomId])

	const isViewer = board?.role === 'viewer'
	const isReadonly = isViewer || interactionMode === 'view'

	useEffect(() => {
		const editor = editorRef.current
		if (editor) {
			editor.updateInstanceState({ isReadonly })
			editor.setCurrentTool(isReadonly ? 'hand' : 'select')
		}
	}, [isReadonly])

	useEffect(() => {
		editorRef.current?.user.updateUserPreferences({ colorScheme: displayTheme })
	}, [displayTheme])

	useEffect(() => {
		const openCadReview = (event: Event) => {
			const modelRecordId = (event as CustomEvent<{ modelRecordId?: string }>).detail?.modelRecordId
			if (modelRecordId) setCadModelRecordId(modelRecordId)
		}
		window.addEventListener(CAD_REVIEW_OPEN_EVENT, openCadReview)
		return () => window.removeEventListener(CAD_REVIEW_OPEN_EVENT, openCadReview)
	}, [])

	// People who can edit report the sizes their browser measured for text and notes, so agents can lay the board out against
	// real sizes. Optional and silent: it never edits the board, and viewers (whom the server would refuse) do not run it.
	const syncReporter = useCallback(() => {
		stopReporterRef.current?.()
		stopReporterRef.current = null
		const editor = editorRef.current
		if (editor && (board?.role === 'owner' || board?.role === 'editor')) stopReporterRef.current = attachMeasurementReporter(editor, roomId)
	}, [board?.role, roomId])
	useEffect(() => {
		syncReporter()
		return () => { stopReporterRef.current?.(); stopReporterRef.current = null }
	}, [syncReporter])

	/** Read the live server clock immediately before the restore request. */
	const getExpectedClock = useCallback(async () => {
		const result = await apiRequest<{ clock: number }>(
			`/api/rooms/${encodeURIComponent(roomId)}/canvas`
		)
		return result.clock
	}, [roomId])

	async function signOut() {
		try { await logout() } finally { navigate('/login', { replace: true }) }
	}

	function toggleDisplayTheme() {
		setDisplayTheme((current) => {
			const next = current === 'dark' ? 'light' : 'dark'
			saveDisplayTheme(next)
			return next
		})
	}

	/** Puts a card for an existing `cad_model` record at the centre of the view. The record itself is written by the server. */
	function placeCadCard(model: CadModel) {
		const editor = editorRef.current
		if (!editor) return
		const viewport = editor.getViewportPageBounds()
		const id = createShapeId()
		editor.createShape({
			id,
			type: CAD_REVIEW_SHAPE_TYPE,
			x: viewport.center.x - CAD_CARD_SIZE.w / 2,
			y: viewport.center.y - CAD_CARD_SIZE.h / 2,
			props: { ...CAD_CARD_SIZE, modelRecordId: model.id },
		})
		editor.select(id)
	}

	/** Puts a status card on the board for each machine the server offers this board that is not already shown. Reads only. */
	async function addTelemetryCards() {
		const editor = editorRef.current
		if (!editor) return
		setTelemetryNotice(null)
		try {
			const sources = await listTelemetrySources(roomId)
			if (sources.length === 0) { setTelemetryNotice('No machine status sources are set up for this whiteboard.'); return }
			const shown = new Set(editor.getCurrentPageShapes().filter((shape) => shape.type === TELEMETRY_CARD_SHAPE_TYPE).map((shape) => (shape.props as { sourceId: string }).sourceId))
			const missing = sources.filter((source) => !shown.has(source.sourceId))
			if (missing.length === 0) { setTelemetryNotice('Every available machine already has a status card on this page.'); return }
			const viewport = editor.getViewportPageBounds()
			const gap = 24
			const total = missing.length * TELEMETRY_CARD_SIZE.w + (missing.length - 1) * gap
			const ids = missing.map((source, index) => {
				const id = createShapeId()
				editor.createShape({ id, type: TELEMETRY_CARD_SHAPE_TYPE, x: viewport.center.x - total / 2 + index * (TELEMETRY_CARD_SIZE.w + gap), y: viewport.center.y - TELEMETRY_CARD_SIZE.h / 2, props: { ...TELEMETRY_CARD_SIZE, sourceId: source.sourceId } })
				return id
			})
			editor.select(...ids)
		} catch (caught) { setTelemetryNotice(caught instanceof Error ? caught.message : 'Could not add the machine status card.') }
	}

	async function addCadAssemblySample() {
		setCadBusy('Adding the training assembly…')
		setCadError(null)
		try { placeCadCard(await submitCadAssemblySample(setCadBusy)) }
		catch (caught) { setCadError(caught instanceof Error ? caught.message : 'Could not add the training assembly.') }
		finally { setCadBusy(null) }
	}

	async function addCadSample() {
		setCadBusy('Adding the training model…')
		setCadError(null)
		try { placeCadCard(await submitCadSample(setCadBusy)) }
		catch (caught) { setCadError(caught instanceof Error ? caught.message : 'Could not add the training model.') }
		finally { setCadBusy(null) }
	}

	function toggleInteractionMode() {
		setInteractionMode((current) => {
			const next = current === 'edit' ? 'view' : 'edit'
			saveInteractionMode(next)
			return next
		})
	}

	if (boardError) {
		return <main className="aw-auth-screen">
			<section className="aw-status-card" role="status">
				<div className="aw-brand-mark" aria-hidden="true">✦</div>
				<p>{boardError}</p>
				<button className="aw-primary-button" onClick={() => navigate('/boards')}>Go to your whiteboards</button>
			</section>
		</main>
	}

	if (!board) {
		return <main className="aw-auth-screen">
			<section className="aw-status-card" role="status">
				<div className="aw-brand-mark" aria-hidden="true">✦</div>
				<p>Opening {roomId}…</p>
			</section>
		</main>
	}

	if (store.status === 'error') {
		return <main className="aw-auth-screen">
			<section className="aw-status-card" role="alert">
				<div className="aw-brand-mark" aria-hidden="true">✦</div>
				<h1>Whiteboard connection failed</h1>
				<p>{store.error.message || 'The live canvas could not connect.'}</p>
				<button className="aw-primary-button" onClick={() => window.location.reload()}>Try again</button>
			</section>
		</main>
	}

	if (import.meta.env.PROD && !tldrawLicenseKey) {
		return <main className="aw-auth-screen">
			<section className="aw-status-card" role="alert">
				<div className="aw-brand-mark" aria-hidden="true">✦</div>
				<h1>Whiteboard license required</h1>
				<p>This production site needs a tldraw hobby, trial, or commercial license key before the canvas can load.</p>
				<a className="aw-primary-button" href="https://tldraw.dev/get-a-license/hobby" target="_blank" rel="noreferrer">Request a hobby license</a>
			</section>
		</main>
	}

	return <div className={`room-root theme-${displayTheme}`}>
		<div className={`app-shell ${presenting ? 'presenting' : ''}`}>
		<header className={`topbar ${menuCollapsed ? 'is-collapsed' : ''}`}>
			<button
				type="button"
				className="aw-menu-toggle"
				aria-expanded={!menuCollapsed}
				aria-controls="room-menu-actions"
				aria-label={menuCollapsed ? 'Show whiteboard menu' : 'Hide whiteboard menu'}
				onClick={() => setMenuCollapsed((collapsed) => !collapsed)}
			>{menuCollapsed ? '☰ Menu' : 'Hide menu'}</button>
			<div className="brand"><span className="aw-brand-text">Collaborative AI Canvas</span></div>
			<span className="aw-sync-status" data-live={live} role="status" title={live ? 'Drawing changes appear automatically for everyone in this board.' : 'Connection interrupted. Keep this tab open while it reconnects.'}>
				<span className="live-dot" aria-hidden="true" />{connectionLabel}
			</span>
			<div className="room-name" title={board.name}>Room: {roomId} · {board.name}</div>
			<span className={`aw-role aw-role-${board.role}`}>{board.role}</span>
			{!isViewer ? <button
				className="aw-mode-toggle"
				data-mode={interactionMode}
				aria-pressed={interactionMode === 'view'}
				aria-label={`Canvas mode: ${interactionMode}. Switch to ${interactionMode === 'edit' ? 'view' : 'edit'} mode`}
				title={interactionMode === 'edit'
					? 'Editing is enabled. Switch to View mode to prevent accidental changes.'
					: 'Changes are disabled on this device. Switch to Edit mode to make changes.'}
				onClick={toggleInteractionMode}
			>Mode: {interactionMode === 'edit' ? 'Edit' : 'View'}</button> : null}
			<div id="room-menu-actions" className="aw-room-menu-actions" hidden={menuCollapsed}>
			<button onClick={() => navigate('/boards')}>Dashboard</button>
			<button className={historyOpen ? 'aw-active' : ''} onClick={() => setHistoryOpen((open) => !open)}>History</button>
			<button className={inspectorOpen ? 'aw-active' : ''} onClick={() => setInspectorOpen((open) => !open)}>Semantic</button>
			{!isViewer ? <button onClick={() => setCadUploadOpen(true)} disabled={!!cadBusy}>Add CAD model</button> : null}
			{!isViewer ? <button onClick={() => void addCadSample()} disabled={!!cadBusy} title="Adds a synthetic 60 x 40 x 10 mm block to try the review workflow">{cadBusy ?? 'Add CAD sample'}</button> : null}
			{!isViewer ? <button onClick={() => void addCadAssemblySample()} disabled={!!cadBusy} title="Adds a synthetic five-part assembly to try assembly review">Add assembly sample</button> : null}
			{!isViewer ? <button onClick={() => void addTelemetryCards()} title="Adds a read-only status card for each machine set up for this whiteboard">Add machine status</button> : null}
			<button onClick={() => void copyText(window.location.href).then(setLinkCopied)}>{linkCopied ? 'Link copied!' : 'Copy room link'}</button>
			{board.role === 'owner' ? <button className={shareOpen ? 'aw-active' : ''} onClick={() => setShareOpen(true)}>Share</button> : null}
			<button onClick={() => setPresenting((value) => !value)}>{presenting ? 'Exit presentation' : 'Present'}</button>
			<div className="aw-topbar-end">
				<button onClick={toggleDisplayTheme} aria-label={`Switch to ${displayTheme === 'dark' ? 'light' : 'dark'} display`} title="This display preference is saved only in this browser">Display: {displayTheme === 'dark' ? 'Dark' : 'Light'}</button>
				<HelpLink />
				<div className="aw-user-menu">
					<div className="aw-avatar" aria-hidden="true">{initials(user?.displayName ?? '')}</div>
					<div><strong>{user?.displayName}</strong><small>{user?.login}</small></div>
					<button onClick={() => void signOut()}>Sign out</button>
				</div>
			</div>
			</div>
		</header>
		<main className="workspace">
			<section className="canvas">
				{store.status === 'synced-remote' && !live ? <div className="aw-sync-warning" role="status">Reconnecting to the board. Other people’s changes will appear when the connection returns. Keep this tab open to sync your edits.</div> : null}
				{isReadonly ? <div className="aw-view-mode-hint" role="status">One finger to pan · Pinch to zoom</div> : null}
				<TelemetryBoardContext.Provider value={roomId}>
				<Tldraw
					store={store}
					shapeUtils={roomShapeUtils}
					colorScheme={displayTheme}
					components={tldrawComponents}
					licenseKey={tldrawLicenseKey}
					options={{ deepLinks: true }}
					onMount={(editor) => {
						editorRef.current = editor
						editor.user.updateUserPreferences({ colorScheme: displayTheme })
						editor.updateInstanceState({ isReadonly })
						editor.setCurrentTool(isReadonly ? 'hand' : 'select')
						editor.registerExternalAssetHandler('url', getBookmarkPreview)
						syncReporter()
					}}
				/>
				</TelemetryBoardContext.Provider>
			</section>
		</main>
		</div>
		{shareOpen && board.role === 'owner' ? <SharingPanel boardId={roomId} isOwner onClose={() => setShareOpen(false)} /> : null}
		{historyOpen ? <HistoryPanel
			boardId={roomId}
			canRestore={!isReadonly}
			displayTheme={displayTheme}
			getExpectedClock={getExpectedClock}
			onClose={() => setHistoryOpen(false)}
		/> : null}
		{inspectorOpen ? <SemanticInspectorPanel
			boardId={roomId}
			canEdit={!isReadonly}
			onClose={() => setInspectorOpen(false)}
		/> : null}
		{cadModelRecordId && editorRef.current ? <Suspense fallback={<div className="cad-panel-loading" role="status">Opening CAD review…</div>}>
			<CadReviewPanel
				editor={editorRef.current}
				modelRecordId={cadModelRecordId}
				canEdit={!isViewer}
				onClose={() => setCadModelRecordId(null)}
			/>
		</Suspense> : null}
		{cadUploadOpen ? <CadUploadDialog mode="model" onCancel={() => setCadUploadOpen(false)} onDone={(model) => { setCadUploadOpen(false); placeCadCard(model) }} /> : null}
		{telemetryNotice ? <div className="cad-toast" role="alert">{telemetryNotice}<button type="button" onClick={() => setTelemetryNotice(null)}>Dismiss</button></div> : null}
		{cadError ? <div className="cad-toast" role="alert">{cadError}<button type="button" onClick={() => setCadError(null)}>Dismiss</button></div> : null}
	</div>
}
