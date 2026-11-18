/**
 * The text an owner hands an agent after creating or rotating its access: the address, the whiteboard, the token
 * and one command that proves the connection works.
 *
 * This is documentation for the agent's side, the same material as the Agent API guide, so it lives with the help
 * pages and not in `client/agents`, whose source guards keep the Agents page itself from setting authorization
 * headers or touching Cloudflare credentials. Nothing here makes a request or stores anything: the block is built
 * on demand from the one-time token, copied only when the owner asks, and kept nowhere.
 *
 * `viaCloudflare` is true when a separate machine hostname is configured. The agent then also needs its Cloudflare
 * Access pair, which an administrator issues and this product never sees, so those two lines are left empty.
 */
/**
 * The walk-through at the top of the block. It is addressed to the agent: the person pastes the whole block into their agent, and the agent
 * then takes them through the steps one at a time. Every line is a comment, so the block still works pasted into an environment file.
 *
 * It names the token and the Cloudflare secret only by variable name, never by value, and the Cloudflare step (and every mention of
 * Cloudflare) exists only when a separate machine hostname is configured.
 */
function walkthrough(input: { guideUrl?: string; boardId: string | null; viaCloudflare: boolean }): string[] {
	const { guideUrl, boardId, viaCloudflare } = input
	const steps: string[][] = [
		[
			'Store the values. Save the setup lines below exactly as written, in your secret store or in an environment file that is not committed to Git.',
			'Do not repeat them back to the person.',
		],
	]
	if (viaCloudflare) {
		steps.push([
			'Get the two Cloudflare values. They are empty on purpose: this whiteboard never sees them. Ask the person to create a service token for you in the Cloudflare',
			'Zero Trust dashboard (Access, then Service credentials, then Service Tokens), and to check that the Access application protecting the API address has a',
			'Service Auth policy that includes that token. Cloudflare shows the secret only once, so they should save both values into your secret store themselves',
			'and tell you when that is done.',
		])
	}
	const refusals = [
		...(viaCloudflare ? ['403 means the Cloudflare pair is missing, wrong, or not allowed by the Access policy (repeat the Cloudflare step).'] : []),
		...(boardId ? ['401 means the whiteboard token is wrong, or was rotated or revoked (ask the person to rotate it on the Agents page and give you the new one).', '404 means the board id is wrong.'] : []),
	]
	steps.push([
		boardId
			? 'Check the connection. Run the command at the bottom of this block. A JSON reply means you are connected.'
			: 'Check the service. Run the command at the bottom of this block. A JSON reply means it can be reached; it does not test the token.',
		...refusals,
	])
	if (guideUrl) steps.push(['Read the guide at the address on the "How to use these values" line before you change anything on the whiteboard.'])
	steps.push([
		boardId
			? 'Tell the person you are connected and which whiteboard you can reach, then ask what they want on it first.'
			: 'Tell the person the service is reachable, then ask what whiteboard they want you to create first.',
	])
	return [
		'# ===== Instructions for the AI agent reading this =====',
		'# A person has just given you access to a collaborative whiteboard. Walk them through the steps below one at a time, in plain language.',
		'# Do every step you can do yourself, ask them only for what you cannot, and wait for their reply before the next step.',
		'# Never print or log the token or any secret, and never ask them to put one in a chat, a document, a ticket or Git.',
		'#',
		...steps.flatMap((step, index) => step.map((line, row) => `# ${row === 0 ? `Step ${index + 1}. ` : '        '}${line}`)),
		'#',
		'# ===== The values =====',
	]
}

export function buildSetupBlock(input: { apiOrigin: string; guideUrl?: string; boardId: string | null; token: string; viaCloudflare: boolean }): string {
	const { apiOrigin, guideUrl, boardId, token, viaCloudflare } = input
	const lines = [
		'# Whiteboard agent setup. Keep this private: the token is shown only once.',
		...(guideUrl ? [`# How to use these values: read ${guideUrl}`] : []),
		`WHITEBOARD_API=${apiOrigin}`,
		...(boardId ? [`WHITEBOARD_BOARD_ID=${boardId}`] : []),
		`WHITEBOARD_TOKEN=${token}`,
	]
	if (viaCloudflare) lines.push('# Ask your administrator for these two:', 'CF_ACCESS_CLIENT_ID=', 'CF_ACCESS_CLIENT_SECRET=')
	const headers = [
		'-H "Authorization: Bearer $WHITEBOARD_TOKEN"',
		...(viaCloudflare ? ['-H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID"', '-H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET"'] : []),
	].join(' ')
	const path = boardId ? '/api/rooms/$WHITEBOARD_BOARD_ID/canvas' : '/api/health'
	lines.push('', '# First check: a JSON reply means the agent is connected.', `curl -sS ${headers} "$WHITEBOARD_API${path}"`)
	return `${[...walkthrough({ guideUrl, boardId, viaCloudflare }), ...lines].join('\n')}\n`
}
