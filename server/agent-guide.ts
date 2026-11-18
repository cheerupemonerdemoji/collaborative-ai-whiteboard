/**
 * The page an AI agent reads to learn how to connect: `GET /agent-guide.md`.
 *
 * It is served without a sign-in, on the browser and private hostnames, so an agent can read it before anyone has
 * given it credentials. It therefore contains no secret and no value specific to one agent: only the shape of the
 * requests, the names of the values a person hands over, and what each reply means. Anything that would identify a
 * board, a token or a Cloudflare credential does not belong here, and `tests/agent-guide.test.ts` guards that.
 *
 * It lives in a TypeScript module and not a separate file because production is one esbuild bundle (`dist/server`),
 * which has no `docs/` folder beside it to read at runtime.
 *
 * Keep it in step with docs/user-guide/agent-api.md, which is the full reference. This is the short path in.
 */

export interface AgentGuideOptions {
	/** The agent API origin when a separate machine hostname is configured, for example `https://api.example.com`. */
	agentApiOrigin?: string | null
}

export function renderAgentGuide(options: AgentGuideOptions = {}): string {
	const address = options.agentApiOrigin
		? `Your agent API address is probably \`${options.agentApiOrigin}\`. Use the address the person who set you up gave you if it differs.`
		: 'Use the agent API address the person who set you up gave you.'
	return AGENT_GUIDE.replace('{{AGENT_API_ADDRESS}}', address)
}

const AGENT_GUIDE = `# How an AI agent connects to this whiteboard

An approved agent can read and edit a whiteboard over ordinary HTTPS. You do not log in and you do not need a browser.
A person gives you a short list of values, and every request carries them as headers.

This page is public and holds no secret. Do not print, log or repeat the values you are given: keep them in your
environment or secret store, never in a chat, a repository, a ticket or a log line.

## What you are given

A person creates your access on the whiteboard's Agents page and chooses "Copy full setup". You receive:

| Name | What it is |
|---|---|
| \`WHITEBOARD_API\` | The address of the agent API. It is not the address people open in a browser. Older notes call it \`WHITEBOARD_API_BASE\`; it is the same value. |
| \`WHITEBOARD_BOARD_ID\` | Which whiteboard you work on. Not a secret. Absent if you were set up to create your own boards. |
| \`WHITEBOARD_TOKEN\` | Says which boards and operations you may use. Shown to the person only once. |
| \`CF_ACCESS_CLIENT_ID\`, \`CF_ACCESS_CLIENT_SECRET\` | A Cloudflare service credential that lets your machine reach the API at all. An administrator issues it. It may be absent on a private-network install. |

{{AGENT_API_ADDRESS}}

Both layers are needed. The Cloudflare pair answers "may this machine reach the API?" and the whiteboard token answers
"what may this agent do, and where?" One alone gets you nothing. If a value is missing, ask the person who set you up.
Do not try to find or guess it.

## 1. Check you can reach the API

If your install has no Cloudflare pair, leave out the two \`CF-Access\` headers.

\`\`\`bash
curl -sS "$WHITEBOARD_API/api/health" \\
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \\
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET"
\`\`\`

A JSON reply means you are through. An HTML sign-in or "access denied" page means the Cloudflare pair is missing or not accepted.

## 2. Check your token

Add the whiteboard token. Send all three headers on every request from now on.

\`\`\`bash
curl -sS "$WHITEBOARD_API/api/agent-session" \\
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \\
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \\
  -H "Authorization: Bearer $WHITEBOARD_TOKEN"
\`\`\`

Any valid agent token is accepted. A \`401\` means the token is missing, wrong, revoked or expired.

## 3. Read the board

Needs the \`read\` scope. Start with the structured records.

\`\`\`bash
curl -sS "$WHITEBOARD_API/api/rooms/$WHITEBOARD_BOARD_ID/semantic-context" \\
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \\
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \\
  -H "Authorization: Bearer $WHITEBOARD_TOKEN"
\`\`\`

The same headers work on \`/canvas\` (the shapes) and \`/layout\` (where everything is, in page coordinates, so you can
place new work without overlapping what is there). Read the layout before you draw.

To create a page on a board your token can edit, send \`POST /api/rooms/$WHITEBOARD_BOARD_ID/pages\`
with \`{"id":"page:lessons-learned","name":"Lessons learned"}\`. Reuse the same ID on retry; the reply says
\`created: false\` when that page already exists. Pass its \`pageId\` to later canvas, layout and action requests.

## 4. Make a change

Needs the \`write\` scope. Send a list of actions. This one creates a task. Choose your own identifier:
\`engineering_entity:\` followed by lowercase letters, digits, \`-\` or \`_\`, and keep it unique.

\`\`\`bash
curl -sS -X POST "$WHITEBOARD_API/api/rooms/$WHITEBOARD_BOARD_ID/actions" \\
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \\
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \\
  -H "Authorization: Bearer $WHITEBOARD_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"actions":[{"tool":"create_entity","id":"engineering_entity:agent-example-1","entityType":"task","title":"Review the latest test results"}]}'
\`\`\`

Your change appears on the board live and is attributed to you in History, where a person can review it and restore an
earlier version. A request that fails changes nothing.

### Add a real data chart

\`create_chart\` draws a resizable Vega-Lite chart from bounded, inline data. The agent supplies values, labels and a source;
it cannot submit raw Vega code or a data URL. Read \`/layout\` first and choose a free region. For example:

\`\`\`json
{"actions":[{"tool":"create_chart","id":"shape:trial-outcomes-chart","x":100,"y":100,"width":720,"height":500,"chart":{"kind":"bar","title":"Trial outcomes","source":"results/many_seed.json","xLabel":"Runs","data":[{"label":"Stalled","value":57},{"label":"Still progressing","value":3}]}}]}
\`\`\`

\`kind\` can be \`bar\`, \`line\`, \`scatter\` or \`pareto\`. For scatter, each data item needs numeric \`x\` and \`value\` fields.
To revise a chart, read its full \`chart\` and \`revision\` from \`/canvas\`, then send \`update_chart\` with the same ID,
a replacement chart definition and \`expectedRevision\`. A stale revision is refused without changing the board.

### Add a picture

Needs the \`write\` scope. Two steps: upload the file, then place it. Only PNG, JPEG, GIF and WebP files are accepted (not
SVG, which can carry script), up to 4 MB and 8192 pixels on a side, and a board holds at most 100 images. The server checks
the file's real bytes, so a wrong file name or content type changes nothing.

\`\`\`bash
curl -sS -X POST "$WHITEBOARD_API/api/boards/$WHITEBOARD_BOARD_ID/images" \\
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \\
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \\
  -H "Authorization: Bearer $WHITEBOARD_TOKEN" \\
  -H "Content-Type: application/octet-stream" \\
  --data-binary @picture.png
\`\`\`

A \`201\` reply gives \`image.assetId\` (a name that starts with \`img-\`), its \`width\` and \`height\`. Then place it on a page with
\`create_image\`. Give a \`width\` and the height follows from the picture's proportions. Without one the picture keeps its own
width, up to 800. Always describe it in \`altText\`.

\`\`\`json
{"actions":[{"tool":"create_image","id":"shape:share-button","assetId":"the assetId from the reply","x":100,"y":100,"width":400,"altText":"The Share button in the top bar"}]}
\`\`\`

Read \`/layout\` first and choose a free region, as for any other shape. Uploading the same bytes again costs nothing.

### Add a link

\`set_link\` puts a clickable address on a shape: \`{"tool":"set_link","id":"shape:box","url":"the https address to open"}\`. Send
\`"url": null\` to remove it. It works on rectangles, ellipses, notes and images, and not on a text box, which cannot hold a
link. \`create_image\` also takes an optional \`url\`. Only a plain address that starts with \`https\` is accepted: no \`http\`, no \`javascript:\`,
no user name or password in it, no spaces, at most 2000 characters.

## Before you say you are finished

Use this API for every change. Do not drive the website's own interface to edit a board. When you draw on the canvas,
nothing is finished until you have checked it. Run every check below, and report plainly what you checked and what
you could not.

Before you write:

- Read the canvas and the layout first, and work on the right \`pageId\`. Choose unique shape identifiers.
- Send at most 30 actions in one request. One text or box label is at most 500 characters. Give text a \`width\`.
- Change only what you created or were asked to change. Never delete or move other people's work.

Size every box for its text. A size the server reports as an estimate is a guess, so make boxes taller than you think
you need and then measure. A layout \`status\` of \`partially_unverified\` is not a pass.

Before you finish, confirm each of these:

1. Read the page back over the API: every object you meant to add exists, with the text you meant.
2. Open the page in a browser, fit it to the view, and check each box's text sits inside it with room to spare, on a
   narrow phone-sized view too. Nothing is clipped, nothing overlaps, and every arrow is attached.
3. Other pages are unchanged: compare their object counts with what you saw before you started.
4. Any test or temporary content you made is removed.
5. No token, secret or password appears on the board, in a reply or in a log.
6. Your change shows in History as an AI change.
7. Your final message says what you checked, and names anything you could not verify.

If a check fails, fix it and run the checks again. Do not report the work as done until they all pass.

## If you were set up to create boards

A board-creating token can make new whiteboards owned by the person who set you up. It has no access to boards that
existed before. Limits: 10 boards an hour per token, 20 an hour per account, 50 per token in total.

\`\`\`bash
curl -sS -X POST "$WHITEBOARD_API/api/agent-boards" \\
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \\
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \\
  -H "Authorization: Bearer $WHITEBOARD_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"name":"Gearbox test plan"}'
\`\`\`

A \`201\` reply gives the new board's \`boardId\`, its \`name\` and a \`url\` for people. The same token can use the new
board straight away.

## What you can use

| Scope | Allows |
|---|---|
| \`read\` | Read the canvas, records and layout of the boards you were given. |
| \`write\` | Create and change records, links and shapes, and use the layout actions. |
| \`history\` | Read History and checkpoints. With \`write\`, save a checkpoint. |
| \`restore\` | Restore a whole board to an earlier moment. Rarely granted. |

Ask for the least that works. You cannot sign in, manage accounts, send invitations or upload attachments. A token for
one board cannot see another: the reply is the same as for a board that does not exist.

## What the replies mean

| You see | What it usually means |
|---|---|
| \`403\` "Cloudflare Access credentials required", or an HTML page | The Cloudflare pair is missing, wrong, disabled or expired. |
| \`401\` | The whiteboard token is missing, wrong, revoked, expired, or not valid for this board. |
| \`403\` | The token is valid but lacks the scope this operation needs. |
| \`404\` | Not available to agents, or a board you have no access to. Check the path and method. |
| \`409\` | The board changed while you worked. Read it again and retry. |
| \`429\` | Too fast. Wait and retry more slowly. |
| \`400\` | Malformed request: check the board id, the record id format and the JSON. |

If you see \`401\` with a message that machine credentials are not accepted here, you sent the token to the browser
address. Use \`WHITEBOARD_API\` instead.

## For the person setting up an agent

- Open Agents from the whiteboards page, pick the whiteboard (or choose "Create new whiteboards"), name the agent and
  choose what it may do. Read only is the safest.
- Choose "Create access", then "Copy full setup". The token is shown once. If it is lost, rotate the agent.
- Give the agent the copied block through its secret store, not through a chat message.
- The two Cloudflare lines come from your administrator, who creates one service credential per agent.
- To cut an agent off, revoke its token on the Agents page. To stop it before it reaches the whiteboard at all,
  disable its Cloudflare service credential.
`
