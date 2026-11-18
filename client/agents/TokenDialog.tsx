import { useEffect, useRef, useState } from 'react'
import { copyText } from '../SharingPanel'
import { buildSetupBlock } from '../help/agent-setup'
import type { AgentConnection, RevealedToken } from './agents-model'

/**
 * Shows a newly issued bearer token exactly once.
 *
 * The token reaches this component as a prop and goes no further: it is rendered as text (not an <input>, so a
 * password manager or autofill never sees it), handed to the clipboard when the owner asks, and otherwise stored
 * nowhere. It is never written to localStorage, sessionStorage, the URL, history state, a cookie or the console.
 * When the dialog closes the parent drops the token (see `tokenReducer`), React unmounts this component, and
 * nothing remains in the page.
 */
export function TokenDialog({ revealed, connection = null, onDismiss }: { revealed: RevealedToken; connection?: AgentConnection | null; onDismiss: () => void }) {
	const [copied, setCopied] = useState<'idle' | 'copied' | 'copiedAll' | 'failed'>('idle')
	const copyButton = useRef<HTMLButtonElement>(null)

	useEffect(() => { copyButton.current?.focus() }, [])
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onDismiss() }
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [onDismiss])

	async function copy() {
		setCopied((await copyText(revealed.token)) ? 'copied' : 'failed')
	}

	// The whole setup as one block, so the agent's address, whiteboard and token are copied together.
	const setup = connection ? buildSetupBlock({ apiOrigin: connection.apiOrigin, guideUrl: connection.guideUrl, boardId: revealed.boardId ?? null, token: revealed.token, viaCloudflare: connection.viaCloudflare }) : null
	async function copySetup() {
		if (setup) setCopied((await copyText(setup)) ? 'copiedAll' : 'failed')
	}

	const rotated = revealed.kind === 'rotated'
	return <div className="aw-token-backdrop">
		<div className="aw-token-dialog" role="dialog" aria-modal="true" aria-labelledby="aw-token-title">
			<h2 id="aw-token-title">{rotated ? 'New token issued' : 'Agent access created'}</h2>
			<p>{revealed.boardName === null
				? <><strong>{revealed.agentTitle}</strong>, which can create new whiteboards owned by your account</>
				: <><strong>{revealed.agentTitle}</strong> on <strong>{revealed.boardName}</strong></>}</p>
			<div className="aw-agents-warning" role="note">
				<strong>Copy this token now.</strong> It is shown only once and cannot be recovered.
				{rotated ? ' The previous token has already stopped working.' : ''} If you lose it, rotate the agent to get a new one.
			</div>
			<code className="aw-token-value">{revealed.token}</code>
			<div className="aw-token-copy">
				{setup ? <button ref={copyButton} className="aw-primary-button" onClick={() => void copySetup()}>Copy full setup</button> : null}
				<button ref={setup ? undefined : copyButton} className={setup ? undefined : 'aw-primary-button'} onClick={() => void copy()}>Copy token</button>
				<span role="status" aria-live="polite">
					{copied === 'copied' ? 'Copied the token.' : copied === 'copiedAll' ? 'Copied the full setup.' : copied === 'failed' ? 'Could not copy automatically. Select the token and copy it by hand.' : ''}
				</span>
			</div>
			{setup ? <>
				<h3>Everything the agent needs</h3>
				<pre className="aw-token-value aw-token-setup">{setup}</pre>
				<p className="aw-muted">Paste all of this into your AI agent as your first message and it will walk you through the rest, one step at a time{connection?.viaCloudflare ? ', including the two Cloudflare values this page never sees' : ''}. The agent sees the token in that conversation, so use an agent you trust. You can rotate the token on this page at any time.</p>
			</> : null}
			<h3>What to do with it</h3>
			<ol className="aw-token-steps">
				<li>Easiest: copy the full setup, paste it into your agent, and answer what it asks. Or save the token yourself as <code>WHITEBOARD_TOKEN</code> in the agent's secret store. Never paste it into a ticket, a document or Git.</li>
				<li>The agent also needs its Cloudflare service credentials. The full setup tells the agent how to get them with you, and the setup checklist on this page lists everything it needs.</li>
			</ol>
			<div className="aw-token-actions"><button onClick={onDismiss}>I have saved it</button></div>
		</div>
	</div>
}
