import { type FormEvent, useCallback, useEffect, useState } from 'react'
import { apiRequest } from './auth'

export type ShareRole = 'editor' | 'viewer'

export interface BoardMember {
	boardId: string
	userId: string
	role: 'owner' | ShareRole
	displayName?: string | null
	createdAt: number | string
	updatedAt: number | string
}

export interface InvitationSummary {
	id: string
	boardId: string | null
	role: ShareRole | null
	invitedLogin: string | null
	createdAt: number | string
	expiresAt: number | string
	consumedAt: number | string | null
	revokedAt: number | string | null
}

export async function copyText(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text)
		return true
	} catch {
		const textarea = document.createElement('textarea')
		textarea.value = text
		textarea.setAttribute('readonly', '')
		textarea.style.position = 'fixed'
		textarea.style.left = '-9999px'
		document.body.appendChild(textarea)
		textarea.select()
		try {
			return document.execCommand('copy')
		} finally {
			document.body.removeChild(textarea)
		}
	}
}

export interface SharingPanelProps {
	boardId: string
	isOwner: boolean
	onClose(): void
	onChanged?(): void
}

export function SharingPanel({ boardId, isOwner, onClose, onChanged }: SharingPanelProps) {
	const [members, setMembers] = useState<BoardMember[]>([])
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState<string | null>(null)
	const [inviteRole, setInviteRole] = useState<ShareRole>('viewer')
	const [invitedLogin, setInvitedLogin] = useState('')
	const [inviteUrl, setInviteUrl] = useState<string | null>(null)
	const [creatingInvite, setCreatingInvite] = useState(false)
	const [copied, setCopied] = useState(false)
	const [changing, setChanging] = useState<string | null>(null)
	const [removeConfirm, setRemoveConfirm] = useState<string | null>(null)

	const loadMembers = useCallback(async () => {
		setLoading(true)
		setError(null)
		try {
			const result = await apiRequest<{ members: BoardMember[] }>(`/api/boards/${encodeURIComponent(boardId)}/members`)
			setMembers(result.members)
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : 'Could not load members.')
		} finally {
			setLoading(false)
		}
	}, [boardId])

	useEffect(() => {
		void loadMembers()
	}, [loadMembers])

	async function createInvite(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		setCreatingInvite(true)
		setError(null)
		try {
			const result = await apiRequest<{ invitation: InvitationSummary; token: string }>('/api/invitations', {
				method: 'POST',
				body: JSON.stringify({
					boardId,
					role: inviteRole,
					...(invitedLogin.trim() ? { invitedLogin: invitedLogin.trim() } : {}),
				}),
			})
			setInviteUrl(`${window.location.origin}/login#invite=${encodeURIComponent(result.token)}`)
			setCopied(false)
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : 'Could not create the invitation.')
		} finally {
			setCreatingInvite(false)
		}
	}

	async function changeRole(userId: string, role: ShareRole | null) {
		setChanging(userId)
		setError(null)
		try {
			await apiRequest(`/api/boards/${encodeURIComponent(boardId)}/members/${encodeURIComponent(userId)}`, {
				method: 'PUT',
				body: JSON.stringify({ role }),
			})
			if (role === null) {
				setMembers((current) => current.filter((member) => member.userId !== userId))
			} else {
				setMembers((current) => current.map((member) => (member.userId === userId ? { ...member, role } : member)))
			}
			setRemoveConfirm(null)
			onChanged?.()
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : 'Could not update that member.')
		} finally {
			setChanging(null)
		}
	}

	async function copyInvite() {
		if (inviteUrl) setCopied(await copyText(inviteUrl))
	}

	return <aside className="aw-share-panel" aria-label="Share this whiteboard">
		<header className="aw-share-header">
			<div><h2>Share</h2><p>Invite people and set their role.</p></div>
			<button className="aw-icon-button" onClick={onClose} aria-label="Close sharing panel">×</button>
		</header>
		<div className="aw-share-body">
			{error ? <div className="aw-error" role="alert">{error}</div> : null}
			{isOwner ? <section className="aw-share-section">
				<h3>Invite link</h3>
				<form className="aw-share-form" onSubmit={(event) => void createInvite(event)}>
					<label><span>Role</span>
						<select value={inviteRole} onChange={(event) => setInviteRole(event.target.value as ShareRole)}>
							<option value="editor">Editor</option>
							<option value="viewer">Viewer</option>
						</select>
					</label>
					<label><span>Invite a specific person <em>optional</em></span>
						<input value={invitedLogin} onChange={(event) => setInvitedLogin(event.target.value)} placeholder="username or email" autoComplete="off" maxLength={80} />
					</label>
					<div><button className="aw-primary-button" disabled={creatingInvite}>{creatingInvite ? 'Creating…' : 'Create invite link'}</button></div>
				</form>
				{inviteUrl ? <div className="aw-share-link">
					<p className="aw-share-hint">Share this link. It works for new and existing accounts.</p>
					<div className="aw-share-link-row">
						<input readOnly value={inviteUrl} onFocus={(event) => event.target.select()} />
						<button onClick={() => void copyInvite()}>{copied ? 'Copied!' : 'Copy'}</button>
					</div>
				</div> : null}
			</section> : null}
			<section className="aw-share-section">
				<h3>Members ({members.length})</h3>
				{loading ? <div className="aw-share-hint" role="status">Loading members…</div> : null}
				{!loading && members.length === 0 ? <div className="aw-share-hint">No members yet.</div> : null}
				<div className="aw-member-list">
					{members.map((member) => <div className="aw-member-row" key={member.userId}>
						<span className="aw-avatar" aria-hidden="true">{(member.displayName ?? member.userId).slice(0, 2).toUpperCase()}</span>
						<span className="aw-member-id" title={member.userId}>{member.displayName ?? member.userId}</span>
						{member.role === 'owner' ? <span className="aw-owner-label">Owner</span> : <div className="aw-member-controls">
							<select value={member.role} disabled={changing === member.userId} onChange={(event) => {
								const value = event.target.value
								if (value === 'remove') setRemoveConfirm(member.userId)
								else void changeRole(member.userId, value as ShareRole)
							}}>
								<option value="editor">Editor</option>
								<option value="viewer">Viewer</option>
								<option value="remove">Remove…</option>
							</select>
							{removeConfirm === member.userId ? <button className="aw-danger-outline" disabled={changing === member.userId} onClick={() => void changeRole(member.userId, null)}>{changing === member.userId ? 'Removing…' : 'Confirm'}</button> : null}
						</div>}
					</div>)}
				</div>
			</section>
		</div>
	</aside>
}
