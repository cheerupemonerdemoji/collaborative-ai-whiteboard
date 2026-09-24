import { type FormEvent, useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiRequest, useAuth } from '../auth'
import { copyText } from '../SharingPanel'

export type BoardRole = 'owner' | 'editor' | 'viewer'

export interface BoardSummary {
	id: string
	name: string
	ownerUserId: string
	role: BoardRole
	createdAt: number | string
	updatedAt: number | string
	deletedAt?: number | string | null
}

function formatDate(value: number | string) {
	const date = new Date(typeof value === 'number' && value < 1_000_000_000_000 ? value * 1000 : value)
	return Number.isNaN(date.valueOf()) ? '' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function initials(name: string) {
	return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') || '?'
}

export function Dashboard() {
	const { user, logout } = useAuth()
	const navigate = useNavigate()
	const [boards, setBoards] = useState<BoardSummary[]>([])
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState<string | null>(null)
	const [showCreate, setShowCreate] = useState(false)
	const [name, setName] = useState('')
	const [creating, setCreating] = useState(false)
	const [includeDeleted, setIncludeDeleted] = useState(false)
	const [joinOpen, setJoinOpen] = useState(false)
	const [joinValue, setJoinValue] = useState('')
	const [joining, setJoining] = useState(false)
	const [joinError, setJoinError] = useState<string | null>(null)
	const [renameId, setRenameId] = useState<string | null>(null)
	const [renameValue, setRenameValue] = useState('')
	const [renaming, setRenaming] = useState(false)
	const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)
	const [deleting, setDeleting] = useState(false)
	const [restoring, setRestoring] = useState(false)

	const loadBoards = useCallback(async (includeDeletedFlag = includeDeleted) => {
		setLoading(true)
		setError(null)
		try {
			const query = includeDeletedFlag ? '?includeDeleted=true' : ''
			const result = await apiRequest<{ boards: BoardSummary[] }>(`/api/boards${query}`)
			setBoards(result.boards)
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : 'Could not load your whiteboards.')
		} finally {
			setLoading(false)
		}
	}, [includeDeleted])

	useEffect(() => {
		void loadBoards()
	}, [loadBoards])

	async function createBoard(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		if (!name.trim()) return
		setCreating(true)
		setError(null)
		try {
			const result = await apiRequest<{ board: BoardSummary }>('/api/boards', {
				method: 'POST',
				body: JSON.stringify({ name: name.trim() }),
			})
			navigate(`/room/${encodeURIComponent(result.board.id)}`)
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : 'Could not create the whiteboard.')
		} finally {
			setCreating(false)
		}
	}

	async function joinBoard(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		const raw = joinValue.trim()
		if (!raw) return
		let token = raw
		if (/^https?:\/\//i.test(raw)) {
			try {
				const url = new URL(raw)
				token = new URLSearchParams(url.hash.slice(1)).get('invite') ?? new URLSearchParams(url.search).get('invite') ?? raw
			} catch {
				token = raw
			}
		}
		setJoining(true)
		setJoinError(null)
		try {
			const result = await apiRequest<{ invitation: { boardId: string | null } }>('/api/invitations/consume', {
				method: 'POST',
				body: JSON.stringify({ token }),
			})
			setJoinValue('')
			setJoinOpen(false)
			await loadBoards()
			if (result.invitation.boardId) navigate(`/room/${encodeURIComponent(result.invitation.boardId)}`)
		} catch (caught) {
			setJoinError(caught instanceof Error ? caught.message : 'Could not accept that invitation.')
		} finally {
			setJoining(false)
		}
	}

	function toggleDeleted() {
		setIncludeDeleted((value) => !value)
	}

	async function renameBoard(boardId: string, event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		const value = renameValue.trim()
		if (!value) return
		setRenaming(true)
		setError(null)
		try {
			const result = await apiRequest<{ board: BoardSummary }>(`/api/boards/${encodeURIComponent(boardId)}`, {
				method: 'PATCH',
				body: JSON.stringify({ name: value }),
			})
			setBoards((current) => current.map((board) => (board.id === boardId ? result.board : board)))
			setRenameId(null)
			setRenameValue('')
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : 'Could not rename the whiteboard.')
		} finally {
			setRenaming(false)
		}
	}

	async function deleteBoard(boardId: string) {
		setDeleting(true)
		setError(null)
		try {
			await apiRequest(`/api/boards/${encodeURIComponent(boardId)}`, { method: 'DELETE' })
			setDeleteConfirmId(null)
			await loadBoards()
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : 'Could not delete the whiteboard.')
		} finally {
			setDeleting(false)
		}
	}

	async function restoreBoard(boardId: string) {
		setRestoring(true)
		setError(null)
		try {
			await apiRequest(`/api/boards/${encodeURIComponent(boardId)}/restore`, { method: 'POST', body: JSON.stringify({}) })
			await loadBoards()
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : 'Could not restore the whiteboard.')
		} finally {
			setRestoring(false)
		}
	}

	async function signOut() {
		try { await logout() } finally { navigate('/login', { replace: true }) }
	}

	return <main className="aw-dashboard">
		<header className="aw-dashboard-header">
			<div className="aw-dashboard-brand"><span className="aw-brand-mark" aria-hidden="true">✦</span><span>Collaborative AI Canvas</span></div>
			<div className="aw-user-menu">
				<div className="aw-avatar" aria-hidden="true">{initials(user?.displayName ?? '')}</div>
				<div><strong>{user?.displayName}</strong><small>{user?.login}</small></div>
				<button onClick={() => void signOut()}>Sign out</button>
			</div>
		</header>
		<section className="aw-dashboard-content">
			<div className="aw-dashboard-title">
				<div><h1>Your whiteboards</h1><p className="aw-muted">Pick up where you left off or start something new.</p></div>
				<button className="aw-primary-button" onClick={() => setShowCreate(true)}>＋ New whiteboard</button>
			</div>
			{showCreate ? <form className="aw-create-board" onSubmit={(event) => void createBoard(event)}>
				<label><span>Whiteboard name</span><input required maxLength={120} value={name} onChange={(event) => setName(event.target.value)} autoFocus placeholder="Project ideas" /></label>
				<div><button type="button" onClick={() => { setShowCreate(false); setName('') }}>Cancel</button><button className="aw-primary-button" disabled={creating}>{creating ? 'Creating…' : 'Create and open'}</button></div>
			</form> : null}
			<div className="aw-dashboard-tools">
				<button onClick={() => { setJoinOpen((open) => !open); setJoinError(null) }}>Join whiteboard</button>
				<label className="aw-show-deleted"><input type="checkbox" checked={includeDeleted} onChange={toggleDeleted} /> Show deleted</label>
			</div>
			{joinOpen ? <form className="aw-join-form" onSubmit={(event) => void joinBoard(event)}>
				<label><span>Invitation token or link</span><input value={joinValue} onChange={(event) => setJoinValue(event.target.value)} placeholder="Paste a token or a full invite link" autoFocus maxLength={512} /></label>
				{joinError ? <div className="aw-error aw-join-error" role="alert">{joinError}</div> : null}
				<div><button type="button" onClick={() => { setJoinOpen(false); setJoinValue(''); setJoinError(null) }}>Cancel</button><button className="aw-primary-button" disabled={joining}>{joining ? 'Joining…' : 'Join'}</button></div>
			</form> : null}
			{error ? <div className="aw-error" role="alert">{error} <button onClick={() => void loadBoards()}>Try again</button></div> : null}
			{loading ? <div className="aw-empty-card" role="status">Loading your whiteboards…</div> : boards.length === 0 ? <div className="aw-empty-card">
				<div className="aw-empty-icon" aria-hidden="true">✎</div><h2>No whiteboards yet</h2><p>Create your first whiteboard to begin.</p><button className="aw-primary-button" onClick={() => setShowCreate(true)}>Create a whiteboard</button>
			</div> : <div className="aw-board-grid">
				{boards.map((board) => <article className={`aw-board-card${board.deletedAt ? ' aw-deleted' : ''}`} key={board.id}>
					{board.deletedAt ? <span className="aw-deleted-badge">Deleted</span> : null}
					<button className="aw-board-open" onClick={() => { if (!board.deletedAt) navigate(`/room/${encodeURIComponent(board.id)}`) }} aria-label={`Open ${board.name}`}>
						<span className="aw-board-preview" aria-hidden="true"><i /><i /><i /></span>
						<span className="aw-board-details"><strong>{board.name}</strong><span>Updated {formatDate(board.updatedAt)}</span></span>
					</button>
					{renameId === board.id ? <form className="aw-rename-form" onSubmit={(event) => void renameBoard(board.id, event)}>
						<input maxLength={120} value={renameValue} onChange={(event) => setRenameValue(event.target.value)} autoFocus />
						<div><button type="button" onClick={() => setRenameId(null)}>Cancel</button><button className="aw-primary-button" disabled={renaming}>{renaming ? 'Saving…' : 'Save'}</button></div>
					</form> : null}
					{deleteConfirmId === board.id ? <div className="aw-delete-confirm" role="alertdialog" aria-label="Confirm delete">
						<span>Delete this whiteboard? You can restore it later.</span>
						<button onClick={() => setDeleteConfirmId(null)}>Cancel</button>
						<button className="aw-danger-button" disabled={deleting} onClick={() => void deleteBoard(board.id)}>{deleting ? 'Deleting…' : 'Yes, delete'}</button>
					</div> : null}
					<footer><span className={`aw-role aw-role-${board.role}`}>{board.role}</span>
						<span className="aw-board-actions">
							{board.deletedAt
								? board.role === 'owner' ? <button disabled={restoring} onClick={() => void restoreBoard(board.id)}>{restoring ? 'Restoring…' : 'Restore'}</button> : null
								: <>
									{board.role === 'owner' ? <button onClick={() => { setRenameId(board.id); setRenameValue(board.name) }}>Rename</button> : null}
									{board.role === 'owner' ? <button onClick={() => setDeleteConfirmId(board.id)}>Delete</button> : null}
									<button onClick={() => void copyText(`${window.location.origin}/room/${encodeURIComponent(board.id)}`)}>Copy link</button>
								</>}
						</span>
					</footer>
				</article>)}
			</div>}
		</section>
	</main>
}
