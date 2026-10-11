import { useCallback, useEffect, useReducer, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { ApiError, useAuth } from '../auth'
import { HelpLink } from '../help/HelpPage'
import './agents.css'
import { createAgent, listAgents, listOwnedBoards, revokeAgent, rotateAgent } from './agents-api'
import { agentTitle, friendlyError, onPageHide, tokenReducer, type AccessLevel, type Agent, type OwnedBoard } from './agents-model'
import { AgentList, type Pending } from './AgentList'
import { CreateAgentForm } from './CreateAgentForm'
import { SetupChecklist } from './SetupChecklist'
import { TokenDialog } from './TokenDialog'

function initials(name: string) {
	return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') || '?'
}

/**
 * Owner-only agent access: create an agent for a whiteboard you own, see who can reach it, rotate a token, revoke
 * access. All authorization is the server's; this page only reflects it (an agent that also reaches boards the
 * viewer does not own has its buttons disabled, and the server would refuse them anyway).
 *
 * The one-time bearer token is held in `revealed` and nowhere else: not in storage, the URL, history state or the
 * console. Closing the dialog, leaving the page, or the page being hidden drops it.
 */
export function AgentsPage() {
	const { user, logout } = useAuth()
	const navigate = useNavigate()
	const [params] = useSearchParams()
	const [boards, setBoards] = useState<OwnedBoard[] | null>(null)
	const [boardsError, setBoardsError] = useState<string | null>(null)
	const [boardId, setBoardId] = useState<string | null>(null)
	const [agents, setAgents] = useState<Agent[] | null>(null)
	const [agentsError, setAgentsError] = useState<string | null>(null)
	const [reloadTick, setReloadTick] = useState(0)
	const [pending, setPending] = useState<Pending | null>(null)
	const [busy, setBusy] = useState(false)
	const [notice, setNotice] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [formKey, setFormKey] = useState(0)
	const [revealed, dispatchToken] = useReducer(tokenReducer, null)

	const board = boards?.find((candidate) => candidate.id === boardId) ?? null
	const reload = useCallback(() => setReloadTick((tick) => tick + 1), [])

	useEffect(() => {
		let cancelled = false
		listOwnedBoards().then((list) => {
			if (cancelled) return
			setBoards(list)
			const wanted = params.get('board')
			setBoardId(list.find((candidate) => candidate.id === wanted)?.id ?? list[0]?.id ?? null)
		}).catch((caught) => {
			if (!cancelled) setBoardsError(friendlyError(caught, 'Could not load your whiteboards.'))
		})
		return () => { cancelled = true }
		// The board named in the address is only a starting point; later changes come from the selector.
	}, [])

	useEffect(() => {
		setAgents(null)
		setAgentsError(null)
		setPending(null)
		setNotice(null)
		setError(null)
	}, [boardId])

	useEffect(() => {
		if (!boardId) return
		let cancelled = false
		listAgents(boardId).then((list) => {
			if (!cancelled) setAgents(list)
		}).catch((caught) => {
			if (!cancelled) setAgentsError(friendlyError(caught, 'Could not load the agents.'))
		})
		return () => { cancelled = true }
	}, [boardId, reloadTick])

	// A frozen back/forward-cache page must not keep a live token behind it.
	useEffect(() => onPageHide(window, () => dispatchToken({ type: 'pagehide' })), [])

	async function run(label: string, action: () => Promise<void>) {
		setBusy(true)
		setError(null)
		setNotice(null)
		try {
			await action()
		} catch (caught) {
			setError(friendlyError(caught, `Could not ${label}.`))
			// The agent is gone or has changed under us: stop showing a stale confirmation and show the truth.
			if (caught instanceof ApiError && (caught.status === 404 || caught.status === 409)) {
				setPending(null)
				reload()
			}
		} finally {
			setBusy(false)
		}
	}

	function create(input: { displayName: string; access: AccessLevel; expiresAt?: string }) {
		if (!board) return
		void run('create the agent', async () => {
			const { token } = await createAgent({ boardId: board.id, ...input })
			dispatchToken({ type: 'reveal', revealed: { kind: 'created', agentTitle: input.displayName, boardName: board.name, token } })
			setFormKey((key) => key + 1)
			setNotice(`Created access for “${input.displayName}”.`)
			reload()
		})
	}

	function rotate(ref: string, expiresAt?: string) {
		if (!board) return
		const title = agentTitle(agents?.find((candidate) => candidate.ref === ref) ?? { name: 'the agent' })
		void run('rotate the token', async () => {
			const { token } = await rotateAgent(ref, expiresAt)
			dispatchToken({ type: 'reveal', revealed: { kind: 'rotated', agentTitle: title, boardName: board.name, token } })
			setPending(null)
			setNotice(`Rotated the token for “${title}”.`)
			reload()
		})
	}

	function revoke(ref: string) {
		const title = agentTitle(agents?.find((candidate) => candidate.ref === ref) ?? { name: 'the agent' })
		void run('revoke the agent', async () => {
			await revokeAgent(ref)
			setPending(null)
			setNotice(`Revoked “${title}”. It can no longer be used.`)
			reload()
		})
	}

	async function signOut() {
		try { await logout() } finally { navigate('/login', { replace: true }) }
	}

	return <main className="aw-dashboard aw-agents">
		<header className="aw-dashboard-header">
			<div className="aw-dashboard-brand"><span className="aw-brand-mark" aria-hidden="true">✦</span><span>Collaborative AI Canvas</span></div>
			<div className="aw-dashboard-actions">
				<Link className="aw-help-link" to="/boards">Your whiteboards</Link>
				<HelpLink />
				<div className="aw-user-menu">
					<div className="aw-avatar" aria-hidden="true">{initials(user?.displayName ?? '')}</div>
					<div><strong>{user?.displayName}</strong><small>{user?.login}</small></div>
					<button onClick={() => void signOut()}>Sign out</button>
				</div>
			</div>
		</header>
		<section className="aw-dashboard-content">
			<div className="aw-dashboard-title">
				<div>
					<h1>Agent access</h1>
					<p className="aw-muted">Let an AI agent read or work on one of your whiteboards. Each agent gets its own token, which you can rotate or revoke at any time. Only a whiteboard's owner can do this.</p>
				</div>
			</div>
			{boardsError ? <div className="aw-error" role="alert">{boardsError}</div>
				: boards === null ? <div className="aw-empty-card" role="status">Loading your whiteboards…</div>
				: boards.length === 0 ? <div className="aw-empty-card">
					<div className="aw-empty-icon" aria-hidden="true">✎</div>
					<h2>You do not own any whiteboards yet</h2>
					<p>Only a whiteboard's owner can give an agent access to it. Create a whiteboard, or ask the owner of a shared one to set up the agent.</p>
					<Link className="aw-primary-button aw-link-button" to="/boards">Go to your whiteboards</Link>
				</div>
				: board ? <>
					<label className="aw-agents-board">
						<span>Whiteboard</span>
						<select value={board.id} onChange={(event) => setBoardId(event.target.value)} disabled={busy}>
							{boards.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
						</select>
					</label>
					<div aria-live="polite">
						{notice ? <div className="aw-agents-notice" role="status">{notice}</div> : null}
						{error ? <div className="aw-error" role="alert">{error}</div> : null}
					</div>
					<section className="aw-agents-section" aria-labelledby="aw-agents-list-title">
						<h2 id="aw-agents-list-title">Agents with access to “{board.name}”</h2>
						{agentsError ? <div className="aw-error" role="alert">{agentsError} <button onClick={reload}>Try again</button></div>
							: agents === null ? <div className="aw-empty-card" role="status">Loading agents…</div>
							: agents.length === 0 ? <div className="aw-empty-card"><p>No agent can reach this whiteboard yet. Create one below.</p></div>
							: <AgentList
								agents={agents}
								busy={busy}
								pending={pending}
								onStart={(kind, ref) => { setPending({ kind, ref }); setError(null); setNotice(null) }}
								onCancel={() => setPending(null)}
								onRotate={rotate}
								onRevoke={revoke}
							/>}
					</section>
					<CreateAgentForm key={formKey} boardName={board.name} busy={busy} onCreate={create} />
					<SetupChecklist boardId={board.id} boardName={board.name} />
				</> : null}
		</section>
		{revealed ? <TokenDialog revealed={revealed} onDismiss={() => dispatchToken({ type: 'dismiss' })} /> : null}
	</main>
}
