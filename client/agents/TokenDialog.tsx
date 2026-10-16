import { useEffect, useRef, useState } from 'react'
import { copyText } from '../SharingPanel'
import type { RevealedToken } from './agents-model'

/**
 * Shows a newly issued bearer token exactly once.
 *
 * The token reaches this component as a prop and goes no further: it is rendered as text (not an <input>, so a
 * password manager or autofill never sees it), handed to the clipboard when the owner asks, and otherwise stored
 * nowhere. It is never written to localStorage, sessionStorage, the URL, history state, a cookie or the console.
 * When the dialog closes the parent drops the token (see `tokenReducer`), React unmounts this component, and
 * nothing remains in the page.
 */
export function TokenDialog({ revealed, onDismiss }: { revealed: RevealedToken; onDismiss: () => void }) {
	const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle')
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
				<button ref={copyButton} className="aw-primary-button" onClick={() => void copy()}>Copy token</button>
				<span role="status" aria-live="polite">
					{copied === 'copied' ? 'Copied to the clipboard.' : copied === 'failed' ? 'Could not copy automatically. Select the token and copy it by hand.' : ''}
				</span>
			</div>
			<h3>What to do with it</h3>
			<ol className="aw-token-steps">
				<li>Save it in the agent's secret store as <code>WHITEBOARD_TOKEN</code>. Never paste it into a chat, a document, a ticket or Git.</li>
				<li>The agent also needs its Cloudflare service credentials. The setup checklist on this page lists everything it needs.</li>
			</ol>
			<div className="aw-token-actions"><button onClick={onDismiss}>I have saved it</button></div>
		</div>
	</div>
}
