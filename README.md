# Collaborative AI Canvas

> This repository is the public source mirror of the Collaborative AI Whiteboard project. Operational deployment history and production-specific records are maintained separately and are intentionally not included here. This mirror has its own fresh Git history and does not contain the private canonical repository's commit history.

A room-based collaborative tldraw whiteboard with local accounts, board roles, and append-oriented history. Humans use the normal canvas tools; external AI clients on their own computers use a small authenticated API to read and edit the same native records. A reference production deployment runs this on a private Node/SQLite service, which also owns user accounts, sessions, board membership, and board history. An earlier Cloudflare Workers/Durable Objects architecture ("V1") is preserved as source under `worker/` and is not the deployed path.

A reference deployment's public browser entry point looks like `https://whiteboard.example.com`, protected by Cloudflare Access and a Cloudflare Tunnel to the loopback-only Node service. Nothing about the application requires Cloudflare specifically -- any TLS-terminating reverse proxy or tunnel in front of the loopback-bound Node service works the same way.

_Screenshots/demo: none yet -- this is a self-hosted internal tool without a public demo instance. If you're evaluating it, the fastest way to see it is the local-development steps below._

## Security

See `SECURITY.md` for how to report a vulnerability, and `docs/security/`
for the threat model, the full authorization matrix (what each role and
each machine-token scope can and cannot do), and how AI/machine clients are
kept separate from human sessions.

## Architecture

- React, TypeScript, Vite, and tldraw provide the full-width human canvas.
- The browser signs in with an `HttpOnly; SameSite=Strict` session cookie and connects to same-origin `/api/connect/:roomId` over WebSocket, carrying the board role for that session.
- The Node server uses tldraw `TLSocketRoom`, `SQLiteSyncStorage`, and `NodeSqliteWrapper`.
- A central `auth.sqlite` stores users, hashed sessions, boards, memberships, invitations, and append-only account audit events.
- New uploaded assets are registered to their board and read through a membership-protected URL.
- Every board has a persistent SQLite file outside the source/build tree holding both the tldraw state and the board's immutable history events, checkpoints, and coalescing fragments.
- Viewer sessions are enforced as read-only by the server; editors and owners write; owners manage membership and invitations.
- The server serves the compiled SPA, room sync, assets, health, and the external canvas API.
- External clients use room-scoped bearer tokens with separate `read`, `write`, `history`, and `restore` permissions, stored as SHA-256 hashes outside Git.
- The history timeline records human, AI-client, and system attribution, and safe restoration is reversible.

See `ARCHITECTURE.md` for the full boundary diagram, the account/history flow, and the preserved Cloudflare design.

## Local development

Node 22+ is recommended.

```powershell
corepack pnpm install
corepack pnpm build
$env:CANVAS_DATA_DIR="$PWD\data"
corepack pnpm start
```

The server binds to `127.0.0.1` on port `8787` by default and writes `data/rooms/*.sqlite`, `data/auth.sqlite`, and `data/assets/`. The first use is at `http://127.0.0.1:8787/login`, where you create the owner account. `corepack pnpm dev:selfhost` runs the same server from TypeScript with `tsx watch`. `corepack pnpm dev` remains the Cloudflare/Vite development path.

Useful checks:

```powershell
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm build:cloudflare
corepack pnpm deploy:cloudflare:dry
```

`corepack pnpm build` is the canonical production build command. The repository pins
the pnpm version in `package.json`; provision Node with Corepack and cache/activate that
version before an offline deployment.

Production HTTPS deployments also require a valid tldraw hobby, trial, or commercial
license. Set `VITE_TLDRAW_LICENSE_KEY` in the environment that runs the build, then run
`corepack pnpm build`. The key is compiled into the browser bundle by design and is not
a secret. It must cover the deployed hostname (currently
`whiteboard.example.com`). Without it, the app displays a license setup
message instead of allowing tldraw to render briefly and disappear.

## Accounts, roles, and first use

### First use (bootstrap)

A fresh data directory has no accounts. Open `http://your-server/login` (locally `http://127.0.0.1:8787/login`), choose **Create account**, and register. The first account becomes the installation administrator.

The administrator can then adopt the legacy room databases that already exist in `data/rooms/` as owned boards. Adoption is transactional and idempotent, records ownership only, and does not read or rewrite the room files.

### Inviting collaborators

After bootstrap, registering a new account requires a one-time invitation. Account invitations (created by an administrator) let a person create an account; board invitations (created by a board owner) additionally grant `editor` or `viewer` membership on that board. Invitations cannot grant owner access, are single-use, expire by default after 7 days, may be restricted to a specific login, and can be revoked. Open registration is off by default and can only be enabled by an explicit operator flag.

### Roles

- **owner** — full control: renames, soft-deletes/restores boards, manages members, and creates board invitations.
- **editor** — reads and writes the canvas.
- **viewer** — read-only. The server opens viewer WebSocket sessions with tldraw read-only and object-store read access, and membership changes close affected live sessions so authorization is re-evaluated.

### Sessions

Logins create an opaque high-entropy session token that is stored only as a SHA-256 hash in `auth.sqlite` and delivered in the `canvas_session` cookie (`HttpOnly; SameSite=Strict`). Sessions are revocable (sign out, or an administrator disabling an account), expire by default after 30 days, and receive the `Secure` flag once HTTPS is configured. On the current HTTP-only tailnet deployment the cookie is **not** `Secure`, so the service must remain reachable only inside the encrypted Tailscale network. Opening an arbitrary room URL no longer creates an unauthenticated room; unauthenticated visitors are sent to `/login`.

When a loopback reverse proxy reports external HTTPS, the cookie receives `Secure` and the response receives HSTS. Forwarded protocol and client-address headers are ignored from non-loopback peers. The public hostname therefore receives secure cookies while `http://your-server` remains a private recovery path with a separate host-scoped cookie.

### Rate limits

Authenticated write paths carry bounded per-actor budgets enforced by the same sliding
window used for sign-in. A budget key is built from the already-authorized identity
(`user:<id>` or `token:<client>`) and the board, never from a client-supplied value, and
each path has its own window so exhausting one does not disable another:

| Path | Budget | Key |
| --- | --- | --- |
| `POST /api/auth/login` | 10 / 15 min | login + client address |
| `POST /api/auth/register` | 10 / 15 min | client address |
| `POST /api/rooms/:id/actions` | 120 / min | actor + board |
| `POST /api/rooms/:id/ai/events` | 120 / min | actor + board |
| `POST /api/boards/:id/checkpoints` | 20 / 5 min | actor + board |
| `POST /api/boards/:id/restore` (history) | 20 / 5 min | actor + board |
| `POST /api/invitations` | 30 / hour | user |
| `POST /api/boards/:id/uploads/:name` | 60 / 15 min | user + board |
| `GET /api/boards/:id/assets/:name` | 600 / min | user + board |

Exceeding a budget returns HTTP 429 with a generic message. Checkpoint and restore copy a
whole board snapshot, so they are deliberately tighter than ordinary canvas writes. The
limits are in-process and reset when the service restarts. `buildApp` accepts a
`rateLimits` override for tests and for operators who need different production numbers.

## Cloudflare public access

The public route is `Cloudflare Access → Cloudflare Tunnel → http://127.0.0.1:8787`.
Access is deny-by-default and is created before the published Tunnel route. The route
uses Protect with Access. The Node service remains bound to loopback; do not forward
port 8787 on the router and do not enable Tailscale Funnel.

Cloudflare Access and whiteboard accounts are independent gates. Passing Access only
allows someone to reach the login page. The person still needs an invited whiteboard
account and an owner/editor/viewer membership. Removing a board member closes their
live board session; removing an Access identity blocks the outer route when Access
revalidates it.

Keep machine AI clients on the private Tailnet endpoint initially. Publishing them
requires a separate Cloudflare Access service-token policy in addition to the existing
room-scoped whiteboard bearer token.

Monitoring locations:

- app: `journalctl --user -u collaborative-ai-canvas`
- tunnel: `systemctl --user status cloudflared-whiteboard` and its journal
- Cloudflare: Tunnel health and Access authentication logs in Zero Trust
- private fallback: `tailscale serve status`

The host must permit outbound TCP or UDP traffic to Cloudflare on port `7844`.
If the public URL reports Tunnel Error 1033 while the app and Tailscale route are
healthy, test that egress before changing application configuration. This deployment
uses the per-user `cloudflared-whiteboard` service. A legacy root-level
`cloudflared.service` is obsolete and should remain disabled to avoid retry noise:

```bash
sudo systemctl disable --now cloudflared.service
sudo systemctl reset-failed cloudflared.service
```

## History, checkpoints, and restore

Every board records an append-only timeline inside its own SQLite file:

- Immutable events hold complete before/after values for each changed tldraw record.
- Rapid human edits from one session are combined into a single semantic event without crossing actor, session, checkpoint, or restore boundaries.
- Periodic full checkpoints (every 50 events or 15 minutes) and explicit checkpoints bound reconstruction cost.
- The first time a pre-existing room is opened, a `legacy_import` checkpoint is created automatically so older boards have a baseline.
- Events carry `human`, `ai`, or `system` attribution; the shared vocabulary includes the AI lifecycle (`ai.requested`, `ai.suggestion_generated`, `ai.suggestion_accepted`, `ai.suggestion_rejected`, `ai.request_cancelled`, `ai.object_created`).

A historical version is reconstructed from the nearest checkpoint plus validated events and is shown in a visibly separate, read-only canvas. Restoring is safe and reversible: it requires an explicit confirmation, compares the current document clock (a stale view returns HTTP 409), checkpoints the live head first as `pre_restore`, applies the target, and appends `restore.started`/`restore.completed` events. Earlier history is never rewritten.

## Relevant routes

Browser pages (same-origin, session cookie):

- `GET /login` — sign in and first-account bootstrap (`http://your-server/login`)
- `GET /boards` — dashboard of the boards the signed-in user can open
- `GET /room/:roomId` — the collaborative canvas; legacy `/:roomId` links still resolve

Cookie-authenticated API used by the SPA:

- `POST /api/auth/login`, `POST /api/auth/register`, `GET /api/auth/me`, `POST /api/auth/logout`
- `GET /api/boards`, `POST /api/boards`
- `GET /api/boards/:boardId/history`, `GET /api/boards/:boardId/history/:eventId/snapshot`
- `POST /api/boards/:boardId/restore`, `POST /api/boards/:boardId/checkpoints`
- `POST /api/boards/:boardId/uploads/:uploadId`; asset reads use the authenticated `GET /api/boards/:boardId/assets/:uploadId` route
- `GET /api/health`

Machine API (room-scoped bearer tokens):

- `GET /api/rooms/:roomId/canvas`
- `POST /api/rooms/:roomId/actions`

Realtime:

- `GET /api/connect/:roomId` — WebSocket sync, authorized against board membership

## Self-hosting (reference deployment)

This section walks through one concrete self-hosting setup (systemd user
service + Tailscale + Cloudflare Tunnel) as a worked example. None of those
specific tools are required -- the application only needs a loopback-bound
Node process behind whatever reverse proxy or tunnel you prefer. Paths below
are illustrative; substitute your own deployment user and directory.

Installed layout:

- Git deployment checkout: `/home/app/collaborative-ai-canvas`
- Persistent data: `/home/app/.local/share/collaborative-ai-canvas`
- Central account database: `/home/app/.local/share/collaborative-ai-canvas/auth.sqlite`
- Room databases (tldraw state + board history): `/home/app/.local/share/collaborative-ai-canvas/rooms/*.sqlite`
- Uploaded assets: `/home/app/.local/share/collaborative-ai-canvas/assets/`
- Private environment: `/home/app/.config/collaborative-ai-canvas/environment`
- API token hashes: `/home/app/.config/collaborative-ai-canvas/api-tokens.json`
- User service: `/home/app/.config/systemd/user/collaborative-ai-canvas.service`

The server keeps its existing `/usr/bin/node` Node 22 installation. Corepack supplies pnpm; no second Node runtime is required.

Deployment/update commands on the server:

```bash
cd /home/app/collaborative-ai-canvas
git pull --ff-only
corepack pnpm install --frozen-lockfile
corepack pnpm run build:selfhost
systemctl --user restart collaborative-ai-canvas
systemctl --user status collaborative-ai-canvas
```

Upgrades are additive and do not delete data. The central auth database and per-board history tables are created by versioned migrations; existing room files, board content, and API token hashes are preserved in place.

The user has systemd lingering enabled, so the user service starts at boot without an interactive login. After Tailscale Serve has been enabled once for the tailnet, publish the localhost listener with:

```bash
tailscale serve --bg --yes --http=80 8787
```

The private room URL is `http://your-server/room/<room-id>` and the first-use URL is `http://your-server/login`. Traffic is still encrypted by Tailscale/WireGuard and remains inside the tailnet. HTTP Serve is used because the installed Tailscale HTTPS reverse proxy does not reliably carry this application's long-lived WebSocket connection. Do not enable Tailscale Funnel — the account cookie is not `Secure` on this plain-HTTP tailnet deployment.

## External AI API

The server no longer runs an AI model or needs an OpenAI key. Each person can use a local AI of their choice to decide which actions to send. Only the eight supported canvas action types are accepted: `create_shape` (rectangle or ellipse), `create_text`, `create_arrow`, `connect_shapes`, `move_shape`, `update_text`, `resize_shape`, and `delete_shape`.

Create one token per external client on the server. The command prints the token once; only its hash is stored. Keep it private and do not put it in browser JavaScript or Git:

```bash
cd /home/app/collaborative-ai-canvas
node scripts/manage-api-tokens.mjs create alice-ai demo read-write
node scripts/manage-api-tokens.mjs list
node scripts/manage-api-tokens.mjs revoke alice-ai
```

Access modes are `read` (canvas snapshots), `write` (actions), `read-write` (both), `read-history` (canvas read plus board history), and `full` (read, write, history, and restore). History reading and restoration are separate permissions and are **not** implied by a read/write token.

The client must be on the tailnet. From its own computer it sends `Authorization: Bearer <token>` to:

- `GET http://your-server/api/rooms/demo/canvas` — returns `roomId`, `pageId`, available pages, `clock`, and compact `objects`. Arrows include absolute start/end coordinates; API-created connections also include `fromId` and `toId`.
- `POST http://your-server/api/rooms/demo/actions` — submits an `actions` array. Optional `pageId` targets a specific page; optional `expectedClock` rejects a stale snapshot with HTTP 409. The response reports `applied` and the new `clock`.

Example request body for three native circles and connecting arrows:

```json
{
  "actions": [
    {"tool":"create_shape","id":"shape:ai_one","type":"ellipse","text":"One","x":100,"y":100,"width":120,"height":120},
    {"tool":"create_shape","id":"shape:ai_two","type":"ellipse","text":"Two","x":400,"y":100,"width":120,"height":120},
    {"tool":"create_shape","id":"shape:ai_three","type":"ellipse","text":"Three","x":250,"y":350,"width":120,"height":120},
    {"tool":"connect_shapes","id":"shape:ai_link_one_two","fromId":"shape:ai_one","toId":"shape:ai_two"},
    {"tool":"connect_shapes","id":"shape:ai_link_two_three","fromId":"shape:ai_two","toId":"shape:ai_three"}
  ]
}
```

The standard-library [Python bridge](examples/canvas_client.py) exposes `get_canvas(room)` and `apply_actions(room, actions, expected_clock)`. Set `CANVAS_API_TOKEN` in that local process's environment, then import those functions into the person's AI program. Native WebSocket room sync updates human browsers automatically. The API is not a general command-execution or model-hosting endpoint.

## Chibi Robo semantic layer

On top of the plain visual canvas, boards can optionally hold a small,
closed set of engineering-semantic records -- `component`, `interface`,
`requirement`, `task`, `experiment`, `decision`, `risk`, `evidence` -- so
humans and AI agents can reason about "this is a requirement satisfied by
that experiment," not just "these are some shapes." A board with none of
these records behaves exactly like an ordinary whiteboard; nothing about
this layer changes existing visual-canvas behavior.

Seven additional AI actions (`create_entity`, `update_entity`,
`link_entities`, `unlink_entities`, `record_experiment_result`,
`attach_evidence`, `update_status`) ride the same authenticated,
rate-limited, schema-validated `/api/rooms/:roomId/actions` endpoint as the
visual actions above, and a `GET /api/rooms/:roomId/semantic-context`
endpoint returns a compact, filtered, budget-capped view instead of the raw
document. See `docs/chibi-robo/whiteboard-integration-plan.md` for the
design and `docs/security/ai-agent-security.md` for what an AI client can
and cannot do with it. This layer is a deliberately small addition, not a
project-management or database system -- see that plan document's
"Explicitly deferred" section for what was intentionally left out.

## Operations

```bash
systemctl --user status collaborative-ai-canvas
journalctl --user -u collaborative-ai-canvas -n 100 --no-pager
systemctl --user restart collaborative-ai-canvas
tailscale serve status
curl http://127.0.0.1:8787/api/health
```

### Backup and restore

For a consistent simple backup, stop the service briefly and archive the data directory. This now includes the central `auth.sqlite` alongside the room databases and uploads, so accounts, sessions, boards, and history are captured together:

```bash
systemctl --user stop collaborative-ai-canvas
tar -C /home/app/.local/share -czf "$HOME/collaborative-ai-canvas-$(date +%F-%H%M).tgz" collaborative-ai-canvas
systemctl --user start collaborative-ai-canvas
```

Copy backups off the server periodically. Restoring means stopping the service, replacing the data directory from a trusted backup, correcting file ownership to the service account, and starting the service. For a complete restore that also preserves machine API access, restore the token-hash and environment files under `/home/app/.config/collaborative-ai-canvas/` as well.

### Cloudflare V1 (Workers/Durable Objects)

An earlier architecture built on Cloudflare Workers and Durable Objects is
preserved as source under `worker/` and `wrangler.jsonc` as an alternate
deployment target. It is not the path this README's setup instructions
build or deploy. In the private canonical repository this history point is
also tagged for exact recovery; this mirror doesn't carry that tag history,
but the same source is present under `worker/`.

```bash
corepack pnpm build:cloudflare
```

## Acceptance procedure

1. Open `http://your-server/login` in an authorized client and register the first account; adopt the existing legacy room as an owned board.
2. Create an invitation for a second person; register that account with the invitation and confirm the granted board role.
3. Open the private room URL in two authorized clients; create/move a rectangle in A, confirm B updates, and confirm a viewer client cannot edit.
4. Issue a client token and GET the room canvas; verify unauthenticated and wrong-room requests fail.
5. POST rectangles/circles and connectors; confirm both browser clients see native, editable shapes.
6. POST move/rename/resize and verify live sync. Confirm stale `expectedClock` returns 409 with no partial changes.
7. Open the board history, view an earlier version, and confirm the historical canvas is read-only.
8. Restore an earlier version with a stale clock (expect 409), then with the current clock; confirm the board returns to the target and the prior head remains checkpointed in history.
9. Reload both clients.
10. Restart the user service and reconnect.
11. Reboot the server when safe and verify service, Tailscale Serve, and room persistence.

## Security and limitations

- Node listens only on localhost; Tailscale is the initial identity/network boundary.
- Browser access now requires an account and board membership. Viewers are read-only server-side; membership changes disconnect live sessions.
- Registration after bootstrap is invitation-only; open registration is disabled unless an operator explicitly enables it.
- The session cookie is `HttpOnly; SameSite=Strict` but not `Secure` on the current HTTP tailnet deployment; keep the service tailnet-only and do not enable Tailscale Funnel.
- Passwords use salted, parameterized scrypt; session and invitation tokens are stored only as SHA-256 hashes.
- Machine bearer tokens are separate principals with room-scoped `read`/`write`/`history`/`restore` permissions; history and restore are granted explicitly and never implied by read/write.
- API clients cannot execute JavaScript, shell, filesystem, or backend commands through the action schema.
- Request bodies, actions, IDs, references, text, coordinates, dimensions, and batch size are bounded; multi-action writes are atomic.
- `expectedClock` detects concurrent edits when a client chooses to use it.
- History events and checkpoints are append-only with no automatic retention or compaction. Checkpoints store full room snapshots and events store full before/after records, so long-lived boards grow without bound; reconstruction replays every event since the nearest checkpoint.
- The former unauthenticated `/api/uploads/<random-id>` compatibility route is disabled. Production had no legacy asset files when this change was deployed; all new assets use board-authorized routes.
- The compact API currently targets top-level shapes on a page; grouped/rotated shape geometry is not fully represented.
- `connect_shapes` creates a native unbound arrow between shape edges; moving a connected shape later does not automatically reattach that arrow.
- Bookmark unfurling is intentionally a no-op in the self-host server for now.
- The production build requires `VITE_TLDRAW_LICENSE_KEY`; obtain the appropriate tldraw
  license and rebuild whenever the key or its allowed hostname changes.

## License

This project's own original code (`server/`, `shared/`, the
application-specific parts of `client/`, `scripts/`, and this
documentation) is licensed under **Apache License 2.0** -- see `LICENSE`.

This project depends on the **tldraw SDK**, which is **separately licensed
by tldraw Inc. and is not covered by this repository's Apache-2.0 license**.
Parts of the tldraw SDK are MIT-licensed; the parts that actually render
and synchronize the canvas (`tldraw`, `@tldraw/editor`, `@tldraw/sync`,
`@tldraw/sync-core`) are under tldraw's own **source-available** license,
not a permissively open-source one -- production use requires a valid
tldraw license key, which this repository's build tooling already enforces
(`scripts/license-preflight.ts`) and does not itself provide. **This
repository does not redistribute or grant any tldraw production license**;
obtain your own directly from tldraw for any production deployment.

See `THIRD_PARTY_NOTICES.md` for the full breakdown, the required
upstream MIT notice, and a point-in-time audit of every other dependency's
license.

## Next step

Add more action types or an MCP adapter if a particular local AI tool needs them. Do not broaden token permissions unnecessarily.
