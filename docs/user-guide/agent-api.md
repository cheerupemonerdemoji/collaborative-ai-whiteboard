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
| `GET /api/rooms/BOARD_ID/layout` | `read` |
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

## Laying out a board

An agent that draws on the canvas should place things where they fit, and check that they do. Two things make that possible: a layout read that says where everything really is, and layout actions that place shapes and report what they achieved.

### Reading the layout

```bash
curl -sS "$WHITEBOARD_API_BASE/api/rooms/BOARD_ID/layout" \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  -H "Authorization: Bearer $WHITEBOARD_TOKEN"
```

This needs the `read` scope. Unlike the canvas read (which lists only top-level shapes), the layout read includes shapes nested inside frames and groups, with everything in **page coordinates**. Each shape has its `id`, `type`, `bounds` (`x`, `y`, `w`, `h`), `rotation`, `parentId`, `index` and `zIndex`, and arrows add their endpoints and what they connect. It never returns text or other properties. Narrow it with `?ids=shape:a,shape:b`, `?types=geo,text` or `?pageId=page:...`; a page too large to return whole is refused with a message rather than cut short.

The response also gives the default `gap` (64) and counts of how many bounds are measured, declared and estimated.

### How far to trust a size

Every shape says where its size came from and whether it is verified:

| `boundsSource` | Meaning | `verification` |
|---|---|---|
| `measured` | A browser reported the size it actually drew, for content that has not changed since. | `verified` |
| `declared` | The shape's own width and height, as boxes, frames and images carry. | `verified` (see below) |
| `estimated` | Worked out from the text, because nothing better exists. Text wraps and fonts differ, so it can be wrong. | `unverified` |

Text and notes are estimated until someone with the board open in a browser has measured them. A box whose label may not fit in it is declared but `unverified`. Treat an estimate as a good guess that leans toward taking more room, never as exact. A measurement is dropped automatically when the text changes (the shape then shows `measurementStale`).

### Layout actions

Send these in the same `actions` list as everything else; they use the same `write` scope, rate limits and History as any other change, and a request that fails changes nothing.

| Action | What it does |
|---|---|
| `place_below` | `{id, targetId, gap?, align?}` puts a shape under another, then slides it further down if something is in the way. `align` is `start`, `center` or `end`. |
| `place_right_of` | The same, to the right of the target. |
| `find_free_region` | `{width, height, near?, direction?, gap?}` finds clear space and **changes nothing**. `direction` is `below`, `right` or `any`. |
| `align` | `{ids, axis}` aligns shapes on `left`, `center-x`, `right`, `top`, `center-y` or `bottom`. |
| `distribute` | `{ids, direction, gap?}` spaces three or more shapes evenly, `horizontal` or `vertical`. |
| `row` | `{ids, gap?, align?, x?, y?, avoidCollisions?}` lines shapes up left to right in the order given. |
| `stack` | The same top to bottom. |
| `grid` | `{ids, columns, gap?, columnGap?, rowGap?, x?, y?, avoidCollisions?}` arranges shapes row by row. |

The default spacing is 64 px everywhere unless you pass a `gap`. A block placed by `row`, `stack` or `grid` is moved as a whole past anything it would land on, unless you set `avoidCollisions` to `false`. Layout actions refuse locked shapes, arrows (an arrow follows the shapes it connects), and a container together with its own child.

`create_text` accepts an optional `width`. With it, the text wraps at that width, which makes its size far more predictable; without it, each line stays on one line however long it is. A single text is limited to 500 characters.

### What comes back

When a request contains layout actions, the reply gains a `layout` object:

```json
{
  "layout": {
    "status": "partially_unverified",
    "gap": 64,
    "results": [{ "index": 1, "tool": "place_below", "moved": [{ "id": "shape:todo", "dx": 0, "dy": 480 }],
      "verification": { "status": "partially_unverified", "items": [], "overlaps": [], "tooClose": [],
        "spacing": { "requested": 64, "minimum": 64, "ok": true },
        "alignment": { "axis": null, "maxDeviation": null, "ok": true },
        "unverified": [{ "id": "shape:todo", "reason": "estimated" }] } }],
    "final": {},
    "arrows": [{ "id": "shape:link", "bound": true, "attached": true, "startGap": 0, "endGap": 0 }]
  }
}
```

- `items` lists each touched shape's resulting bounds, `boundsSource` and `verification`.
- `overlaps` and `tooClose` list anything that intersects, or sits closer than asked. Containers and their children, and arrows attached to their shapes, are not counted.
- `spacing` and `alignment` say whether the gap and alignment you asked for were actually achieved.
- `unverified` names shapes whose placement depends on an estimate (`estimated`), a label that may overflow (`label-may-overflow`), or a measurement that no longer matches (`measurement-stale`).
- `final` repeats the check for the whole request, and `arrows` reports whether each arrow touching a moved shape still meets it.

`status` is the worst of these: `overlaps`, then `partially_unverified`, then `verified`. **`partially_unverified` is not a pass.** It means nothing overlapped according to the sizes known, but at least one of them is an estimate, so a clean result cannot be promised. Prefer boxes with declared sizes, give text a `width`, and leave a generous gap around estimated text. Once someone opens the board in a browser the sizes become measured, and asking for the same placement again reports `verified`. A measurement never moves anything by itself, and your layout is not changed behind your back.

### Arrows

`connect_shapes` now draws a real tldraw arrow attached to both shapes, so it follows them when a person drags one in the browser. Arrows created before this change are static, but when a layout action (or `move_shape` or `resize_shape`) moves a box they connect, the server redraws them. Arrows a person drew, and their attachments, are never altered.

### Sizes the server cannot see

If a person adds a large block of text in their browser, the server has no way to know its drawn size until a browser reports it. Run `find_free_region` or a layout action and read `unverified` rather than assuming. Prefer placing new work in free space (`find_free_region`) over placing it next to content you did not make.

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
