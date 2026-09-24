import { useSync } from '@tldraw/sync'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { type Editor, Tldraw } from 'tldraw'
import { apiRequest, useAuth } from '../auth'
import { copyText, SharingPanel } from '../SharingPanel'
import { getBookmarkPreview } from '../getBookmarkPreview'
import { HistoryPanel } from '../history/HistoryPanel'
import { createMultiplayerAssetStore } from '../multiplayerAssetStore'
import { type BoardSummary } from './Dashboard'
import '../account-history.css'

const tldrawLicenseKey = import.meta.env.VITE_TLDRAW_LICENSE_KEY

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

export function Room() {
	const { roomId = 'demo' } = useParams<{ roomId: string }>()
	const { user, logout } = useAuth()
	const navigate = useNavigate()
	const [board, setBoard] = useState<BoardSummary | null>(null)
	const [boardError, setBoardError] = useState<string | null>(null)
	const [historyOpen, setHistoryOpen] = useState(false)
	const [presenting, setPresenting] = useState(false)
	const [shareOpen, setShareOpen] = useState(false)
	const [linkCopied, setLinkCopied] = useState(false)
	const editorRef = useRef<Editor | null>(null)

	const assets = useMemo(() => createMultiplayerAssetStore(roomId), [roomId])
	const store = useSync({ uri: `${window.location.origin}/api/connect/${roomId}`, assets })

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

	useEffect(() => {
		const editor = editorRef.current
		if (editor) editor.updateInstanceState({ isReadonly: board?.role === 'viewer' })
	}, [board?.role])

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

	const isViewer = board.role === 'viewer'

	return <div className={`app-shell ${presenting ? 'presenting' : ''}`}>
		<header className="topbar">
			<div className="brand"><span className="live-dot" />Collaborative AI Canvas</div>
			<div className="room-name" title={board.name}>Room: {roomId} · {board.name}</div>
			<span className={`aw-role aw-role-${board.role}`}>{board.role}</span>
			<button onClick={() => navigate('/boards')}>Dashboard</button>
			<button className={historyOpen ? 'aw-active' : ''} onClick={() => setHistoryOpen((open) => !open)}>History</button>
			<button onClick={() => void copyText(window.location.href).then(setLinkCopied)}>{linkCopied ? 'Link copied!' : 'Copy room link'}</button>
			{board.role === 'owner' ? <button className={shareOpen ? 'aw-active' : ''} onClick={() => setShareOpen(true)}>Share</button> : null}
			<button onClick={() => setPresenting((value) => !value)}>{presenting ? 'Exit presentation' : 'Present'}</button>
			<div className="aw-user-menu">
				<div className="aw-avatar" aria-hidden="true">{initials(user?.displayName ?? '')}</div>
				<div><strong>{user?.displayName}</strong><small>{user?.login}</small></div>
				<button onClick={() => void signOut()}>Sign out</button>
			</div>
		</header>
		<main className="workspace">
			<section className="canvas">
				<Tldraw
					store={store}
					components={tldrawComponents}
					licenseKey={tldrawLicenseKey}
					options={{ deepLinks: true }}
					onMount={(editor) => {
						editorRef.current = editor
						editor.updateInstanceState({ isReadonly: isViewer })
						editor.registerExternalAssetHandler('url', getBookmarkPreview)
					}}
				/>
			</section>
		</main>
		{shareOpen && board.role === 'owner' ? <SharingPanel boardId={roomId} isOwner onClose={() => setShareOpen(false)} /> : null}
		{historyOpen ? <HistoryPanel
			boardId={roomId}
			canRestore={!isViewer}
			getExpectedClock={getExpectedClock}
			onClose={() => setHistoryOpen(false)}
		/> : null}
	</div>
}
