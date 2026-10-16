import { useState } from 'react'
import { Link } from 'react-router-dom'
import { copyText } from '../SharingPanel'

/**
 * What the agent's own side needs. This page issues and revokes whiteboard tokens only. It does not create,
 * store, display or manage Cloudflare credentials: those belong to whoever administers Cloudflare, and the agent
 * keeps its copy in its own secret store. The whiteboard's board id is not a secret.
 */
export function SetupChecklist({ boardId, boardName, creator = false }: { boardId?: string; boardName?: string; creator?: boolean }) {
	const [copied, setCopied] = useState(false)

	async function copyBoardId() {
		if (boardId) setCopied(await copyText(boardId))
	}

	return <details className="aw-agents-checklist">
		<summary>Set up the agent's side</summary>
		<p className="aw-muted">An agent needs two separate credentials: one to get through Cloudflare to the agent API, and the whiteboard token from this page. This page only manages the whiteboard token.</p>
		<ol>
			<li><strong>Cloudflare access.</strong> Ask your administrator for a Cloudflare Access service token for this agent, with access to the agent API address. Use one per agent so a single agent can be switched off without affecting the others.</li>
			<li><strong>Store the Cloudflare pair.</strong> Save its Client ID and Client Secret in the agent's secret store as <code>CF_ACCESS_CLIENT_ID</code> and <code>CF_ACCESS_CLIENT_SECRET</code>. Never paste them into a chat, a document or Git.</li>
			{creator
				? <li><strong>Store the whiteboard values.</strong> Save the token you get when you create or rotate an agent as <code>WHITEBOARD_TOKEN</code> and the agent API address your administrator gave you as <code>WHITEBOARD_API_BASE</code>. There is no whiteboard ID yet: the agent gets one when it creates its first whiteboard.</li>
				: <li><strong>Store the whiteboard values.</strong> Save the token you get when you create or rotate an agent as <code>WHITEBOARD_TOKEN</code>, the agent API address your administrator gave you as <code>WHITEBOARD_API_BASE</code>, and this whiteboard's ID as <code>WHITEBOARD_BOARD_ID</code>:
				<span className="aw-agents-boardid"><code>{boardId}</code><button onClick={() => void copyBoardId()} aria-label={`Copy the ID of ${boardName}`}>{copied ? 'Copied' : 'Copy ID'}</button></span>
			</li>}
			{creator
				? <li><strong>Check it works.</strong> Make the board-creation request in the <Link to="/help/agent-api">Agent API guide</Link>. A successful reply gives the new whiteboard's ID, and the same token can use that whiteboard straight away.</li>
				: <li><strong>Check it works.</strong> Make the first request shown in the <Link to="/help/agent-api">Agent API guide</Link>. If it returns the whiteboard's records, the agent can reach this whiteboard with these credentials.</li>}
		</ol>
		<p className="aw-muted">Read the <Link to="/help/agent-api">Agent API guide</Link> for the full list of what an agent can call and what each reply means.</p>
	</details>
}
