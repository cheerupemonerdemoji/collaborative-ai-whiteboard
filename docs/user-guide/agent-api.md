# Agent API

An approved AI agent can read and work on a whiteboard over ordinary HTTPS, from any machine on the Internet. It needs no VPN, no remote shell, no browser session, and no human account. This guide is for the person setting an agent up, and for the agent's author.

Changes an agent makes use the same checks as changes a person makes. They appear on the board live, they are attributed to the agent in History, and they can be reviewed and restored like any other change.

## What an agent needs

Four values, supplied to the agent as environment variables or from its secret store:

| Name | What it is |
|---|---|
| `WHITEBOARD_API_BASE` | The address of the agent API, for example the `https://` address your administrator gives you. It is **not** the address people use in their browser. |
| `CF_ACCESS_CLIENT_ID` | The first half of the service credential that lets this agent reach the API at all. |
| `CF_ACCESS_CLIENT_SECRET` | The second half of that service credential. |
| `WHITEBOARD_TOKEN` | The whiteboard token that says which boards, and which operations, this agent may use. |

These are two separate layers, and both are required:

1. **The service credential** (`CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`) answers "may this machine reach the API at all?" Without it a request is refused before it reaches the whiteboard.
2. **The whiteboard token** (`WHITEBOARD_TOKEN`) answers "what may this agent do, and on which boards?" Having the service credential alone gives access to nothing.

You do not ask the agent to log in. You give it these values and nothing else.

## Getting a token

If you own the whiteboard, you create the whiteboard token yourself. Open **Agents** from the whiteboards page (or choose **Agents** on a whiteboard you own), pick the whiteboard, and:

1. Give the agent a name you will recognise. It appears in the Agents list. The whiteboard's History lists the agent's changes under a generated identifier (`agent-` followed by twelve letters and digits), not under this name.
2. Choose what it may do. **Read only** is the safest. **Read and edit** lets it change the whiteboard. **Full access** adds the power to restore the whole whiteboard to an earlier moment, so the page asks you to confirm before it creates one.
3. Choose how long it should last. The page suggests 90 days; you can pick another length, a date, or no expiry at all.
4. Select **Create access**. The token is shown **once**. Copy it straight into the agent's secret store, then close the box. It cannot be shown again.

If you do not own the whiteboard, ask its owner. The Cloudflare service credential comes from your administrator, not from this page.

### An agent that creates its own whiteboards

On the same page, choose **Create new whiteboards** instead of an existing one. The page says what this means: *the agent can create new boards owned by your account, and it does not get access to your existing boards.* Choose its permissions (`Read, edit and view history` is suggested; restore stays behind the same confirmation), a lifetime and a name, then create it. You are not asked to pick a whiteboard, and no whiteboard is created for you. The permissions you choose apply to every board that agent creates, and only to those boards.

## Your first request

Read the structured engineering records on a board. Replace `BOARD_ID` with the board's identifier (your administrator or the board owner gives you this):

```bash
curl -sS "$WHITEBOARD_API_BASE/api/rooms/BOARD_ID/semantic-context" \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  -H "Authorization: Bearer $WHITEBOARD_TOKEN"
```

A successful reply is a JSON document listing the board's records and the links between them. The two service-credential headers and the `Authorization` header are always sent together, on every request.

## What an agent can do

What an agent can do depends on the scopes its token was issued with. Ask for the least that works.

| Scope | What it allows |
|---|---|
| `read` | Read the canvas and the structured records on the boards it is limited to. |
| `write` | Create and change records, links, and canvas shapes, and record agent activity. |
| `history` | Read History, snapshots of earlier moments, and the list of checkpoints. Together with `write`, it can also save a checkpoint. |
| `restore` | Restore a board to an earlier moment. Grant this rarely. |

The operations an agent can reach are:

| Operation | Needs |
|---|---|
| `GET /api/health` | nothing beyond the service credential |
| `GET /api/rooms/BOARD_ID/canvas` | `read` |
| `GET /api/rooms/BOARD_ID/semantic-context` | `read` |
| `POST /api/rooms/BOARD_ID/actions` | `write` |
| `POST /api/rooms/BOARD_ID/ai/events` | `write` |
| `GET /api/boards/BOARD_ID/history` | `history` |
| `GET /api/boards/BOARD_ID/history/EVENT_ID/snapshot` | `history` |
| `GET /api/boards/BOARD_ID/checkpoints` | `history` |
| `POST /api/boards/BOARD_ID/checkpoints` | `history` and `write` |
| `POST /api/boards/BOARD_ID/restore` | `restore` |
| `POST /api/agent-boards` | a board-creating token (see below) |

Everything else is closed to agents: signing in, accounts, invitations, board lists and sharing, uploads and attachments, structured evidence tables, live editing sessions, and the web app itself. An agent works with evidence through the ordinary records only; it cannot create evidence tables.

## Creating a whiteboard

A board-creating token can make a new whiteboard. This is the only operation that is not tied to a board you name, because the board does not exist yet:

```bash
curl -sS -X POST "$WHITEBOARD_API_BASE/api/agent-boards" \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  -H "Authorization: Bearer $WHITEBOARD_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Gearbox test plan"}'
```

The body holds a `name` and nothing else; you cannot choose the board's identifier. A successful reply is `201` with the new board's `boardId`, its `name` and a `url` for people to open it. The reply never contains a token. The new board belongs to the person who set the agent up, and the same token can read and change it straight away, with the permissions it was issued with and no others.

What this does **not** do:

- It gives no access to any board that already existed, including that person's own boards.
- An ordinary board token cannot do it (`403`), and neither can anyone using a browser session: it is a machine-only operation on the agent API address.
- It is limited. One token can create 10 boards an hour, all of one person's tokens together 20 an hour, and one token can hold at most 50 boards in its lifetime (deleted boards still count). Past a limit the reply is `429`, or `409` for the 50-board limit, and nothing is created.

If something goes wrong after the board is made but before the token can be given it, the new board is removed and the reply is an error, so you are not left with a board the agent cannot use.

## Writing a record

Send a list of actions. This creates one task:

```bash
curl -sS -X POST "$WHITEBOARD_API_BASE/api/rooms/BOARD_ID/actions" \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  -H "Authorization: Bearer $WHITEBOARD_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"actions":[{"tool":"create_entity","id":"engineering_entity:agent-example-1","entityType":"task","title":"Review the latest test results"}]}'
```

Record identifiers always look like `engineering_entity:` followed by lowercase letters, digits, `-` or `_`. Choose your own and keep them unique. The other record actions are `update_entity`, `link_entities`, `unlink_entities`, `record_experiment_result`, `attach_evidence`, and `update_status`. To remove a record from view, set its status to `archived`; nothing is permanently deleted, and History still shows it.

Open the board's History as a person and you will see the change listed under the agent's identifier (for an agent created on the Agents page, a generated name that is `agent-` followed by twelve letters and digits), marked as an AI change.

## Boards stay separate

A token is tied to specific boards when it is issued.

- A token for Board A cannot read or change Board B. The reply is the same as for a board that does not exist, so an agent cannot discover which other boards are there.
- A board-creating token starts with no boards, and gets exactly the boards it creates itself. Permission to create boards is never permission to use the owner's other boards.
- A token never grants more than its scopes. A read-only token cannot write, a token without `history` cannot read History, and a token without `restore` cannot restore.
- Records on one board cannot refer to evidence or attachments from another board.

## Handling the credentials

- Treat all four values as secrets. Put them in the agent's environment or secret store, never in a prompt, a chat message, a ticket, a document, a repository, a screenshot, or a log.
- Give each agent its own pair of credentials, named for the agent. Never share one set between agents. That way a single agent can be switched off without touching the others.
- Ask for the fewest boards and the fewest scopes that work.
- Service credentials are issued with an expiry. Plan to replace them before they lapse.
- If a value might have been exposed, tell your administrator straight away. Do not wait to see whether it was misused.

## Rotating and revoking an agent

On the same **Agents** page you can **Rotate token** to give an agent a fresh token (the old one stops working immediately, so update the agent straight away) or **Revoke** to cut it off for good. An expired agent can be rotated with a new expiry to bring it back.

Either layer can also be switched off on its own, and either one stops the agent immediately:

- **Revoke the whiteboard token.** The agent can still reach the API but is refused everywhere.
- **Disable the service credential.** The agent is refused before it reaches the whiteboard at all.

Revoking one agent does not affect any other agent or any person using the whiteboard.

## Common replies

| What you see | What it usually means |
|---|---|
| `403` with "Cloudflare Access credentials required" | The service credential is missing, wrong, disabled, or expired. Check `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`. |
| Cloudflare's own sign-in or "access denied" page (HTML) | The request was stopped before the whiteboard. The service credential is missing or not accepted. |
| `401` | The whiteboard token is missing, wrong, revoked, or not valid for this board. |
| `403` | The token is valid for this board but does not carry the scope this operation needs. |
| `403` with "Origin not allowed" | A `POST` carried a token the server does not accept (wrong, revoked, expired, or not valid for this board or operation). Check the token; the same request with a good token is not affected. |
| `404` with "Not found" | This operation is not available to agents. Check the path and method against the table above. |
| `429` | The agent is going too fast. Wait and retry more slowly. |
| `409` | The board changed while the agent was working. Read it again and retry. |
| `400` | The request was malformed: check the board identifier, the record identifier format, and the JSON. |

If you are sending the whiteboard token to the browser address instead of the agent address, you will see `401` with a message that machine credentials are not accepted there. Use `WHITEBOARD_API_BASE`.

## Related guides

- [History & Restore](history-and-restore.md) explains how an agent's changes are recorded and how to review them.
- [Roles & Sharing](roles-and-sharing.md) explains what people on the board can do.
- [Troubleshooting & FAQ](troubleshooting.md) covers everyday problems.
