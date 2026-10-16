import { useState } from 'react'
import {
	EXPIRY_CHOICES,
	PERMISSION_LABELS,
	agentTitle,
	describeStatus,
	formatDate,
	rotateExpiry,
	rotationNeedsExpiry,
	type Agent,
	type RotateExpiryChoice,
} from './agents-model'

export type Pending = { kind: 'rotate' | 'revoke'; ref: string }

export interface AgentListProps {
	agents: Agent[]
	busy: boolean
	pending: Pending | null
	onStart(kind: Pending['kind'], ref: string): void
	onCancel(): void
	onRotate(ref: string, expiresAt?: string): void
	onRevoke(ref: string): void
	now?: number
}

/**
 * The agents that can reach the selected whiteboard. People see display names, scopes and expiry. The opaque `ref`
 * is used only as a React key and as the argument handed back to the server; it, the stored name of an agent that
 * has a display name, and every credential detail stay out of the markup.
 */
export function AgentList({ agents, busy, pending, onStart, onCancel, onRotate, onRevoke, now = Date.now() }: AgentListProps) {
	return <ul className="aw-agent-list">
		{agents.map((agent) => {
			const title = agentTitle(agent)
			const status = describeStatus(agent, now)
			const created = formatDate(agent.createdAt)
			const rotated = formatDate(agent.rotatedAt)
			const manageable = !agent.sharedWithOtherBoards
			return <li className="aw-agent-row" key={agent.ref}>
				<div className="aw-agent-main">
					<strong className="aw-agent-title">{title}</strong>
					<span className="aw-agent-badges">
						{agent.canCreateBoards ? <span className="aw-badge aw-badge-create">Creates whiteboards</span> : null}
							{agent.permissions.map((permission) => <span className={`aw-badge aw-badge-${permission}`} key={permission}>{PERMISSION_LABELS[permission]}</span>)}
					</span>
					<span className={`aw-status aw-status-${status.tone}`}>{status.label}</span>
				</div>
				<div className="aw-agent-meta aw-muted">
					{created ? `Created ${created}${agent.createdByYou ? ' by you' : ''}` : 'Created before dates were recorded'}
					{rotated ? ` · Token replaced ${rotated}` : ''}
						{agent.canCreateBoards ? ` · ${agent.rooms.length === 1 ? '1 whiteboard' : `${agent.rooms.length} whiteboards`} created so far` : ''}
				</div>
				{agent.sharedWithOtherBoards
					? <div className="aw-agent-note">This agent can also reach whiteboards you do not own, so only an administrator can rotate or revoke it.</div>
					: null}
				{pending?.ref === agent.ref && pending.kind === 'rotate'
					? <RotatePanel agent={agent} title={title} busy={busy} onCancel={onCancel} onRotate={(expiresAt) => onRotate(agent.ref, expiresAt)} now={now} />
					: null}
				{pending?.ref === agent.ref && pending.kind === 'revoke'
					? <div className="aw-agent-confirm" role="alertdialog" aria-label={`Confirm revoking ${title}`}>
						<span>
							Revoke <strong>{title}</strong>? It stops working immediately and cannot be switched back on. You can always create a new one.
							{agent.canCreateBoards ? ' It also loses access to every whiteboard it created. The whiteboards stay yours.' : ''}
						</span>
						<button onClick={onCancel}>Cancel</button>
						<button className="aw-danger-button" disabled={busy} onClick={() => onRevoke(agent.ref)}>{busy ? 'Revoking…' : 'Revoke access'}</button>
					</div>
					: null}
				{pending?.ref === agent.ref ? null : <div className="aw-agent-actions">
					<button disabled={busy || !manageable} onClick={() => onStart('rotate', agent.ref)} aria-label={`Rotate the token for ${title}`}>Rotate token</button>
					<button className="aw-danger-outline" disabled={busy || !manageable} onClick={() => onStart('revoke', agent.ref)} aria-label={`Revoke access for ${title}`}>Revoke</button>
				</div>}
			</li>
		})}
	</ul>
}

function RotatePanel({ agent, title, busy, onCancel, onRotate, now }: {
	agent: Agent
	title: string
	busy: boolean
	onCancel(): void
	onRotate(expiresAt?: string): void
	now: number
}) {
	const mustChoose = rotationNeedsExpiry(agent)
	const [choice, setChoice] = useState<RotateExpiryChoice>(mustChoose ? '90d' : 'keep')
	const [customDate, setCustomDate] = useState('')
	const [message, setMessage] = useState<string | null>(null)

	function submit() {
		const result = rotateExpiry(choice, customDate, Date.now())
		if (!result.ok) {
			setMessage(result.message)
			return
		}
		setMessage(null)
		onRotate(result.expiresAt)
	}

	return <div className="aw-agent-confirm aw-agent-rotate" role="group" aria-label={`Rotate the token for ${title}`}>
		<p>
			Rotating gives <strong>{title}</strong> a new token and <strong>the current token stops working immediately</strong>. Update the agent with the new one straight away.
			{mustChoose ? ' This agent has expired, so choose a new expiry.' : ''}
		</p>
		<label>
			<span>Expiry</span>
			<select value={choice} onChange={(event) => setChoice(event.target.value as RotateExpiryChoice)}>
				{mustChoose ? null : <option value="keep">{agent.status === 'none' ? 'Keep it with no expiry' : `Keep the current expiry (${formatDate(agent.expiresAt)})`}</option>}
				{EXPIRY_CHOICES.filter((option) => option.value !== 'never').map((option) => <option key={option.value} value={option.value}>{`Set a new expiry: ${option.label}`}</option>)}
			</select>
		</label>
		{choice === 'custom' ? <input type="date" aria-label="Last day of access" value={customDate} min={new Date(now + 86_400_000).toISOString().slice(0, 10)} onChange={(event) => setCustomDate(event.target.value)} /> : null}
		{message ? <div className="aw-error" role="alert">{message}</div> : null}
		<div className="aw-agent-confirm-actions">
			<button onClick={onCancel}>Cancel</button>
			<button className="aw-primary-button" disabled={busy} onClick={submit}>{busy ? 'Rotating…' : 'Rotate token'}</button>
		</div>
	</div>
}
