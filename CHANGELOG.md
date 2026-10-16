# Changelog

This file records user-facing changes to the application. Git remains the authoritative record of code changes.

## Unreleased

### Added

- **Agent layout.** Agents can now see where everything on a board actually is and place new work without overlapping it. `GET /api/rooms/BOARD_ID/layout` (read scope) returns page-space bounds for every shape, nested ones included, each marked `measured`, `declared` or `estimated` and `verified` or `unverified`. New layout actions on `/actions` (`place_below`, `place_right_of`, `find_free_region`, `align`, `distribute`, `row`, `stack`, `grid`; 64 px default gap) move shapes, re-route the arrows the API drew, and reply with a verification report: resulting bounds, overlaps, spacing, alignment and any text whose size is only estimated, which is reported as `partially_unverified` rather than as a clean result. `connect_shapes` now draws real tldraw arrows attached to both shapes, and `create_text` takes an optional `width`. When someone who can edit has the board open, their browser reports the sizes it measured for text and notes, which upgrades those shapes to `measured`; it never moves anything. See the Agent API guide.
- **Machine board creation.** An agent with a board-creating credential can create new whiteboards owned by your account with `POST /api/agent-boards` on the agent API address, and the same token can use each new board straight away. On the Agents page choose **Create new whiteboards** when you register the agent: it gets no access to your existing boards, you choose the permissions it will have on the boards it creates, and `Restore` keeps its confirmation. Limits: 10 boards an hour per credential, 20 an hour per account, 50 per credential for life. If the new board cannot be handed to the agent, it is removed and the request fails.
- A new access mode, `read-write-history` (read, edit and view History; no restore), available for every agent and suggested for ones that create whiteboards.
- An **Agents** page (`/agents`, linked from the whiteboards page and from each whiteboard you own) for whiteboard owners: pick a whiteboard, see which agents can reach it, create an agent (name, what it may do, how long it lasts), rotate its token, or revoke it. The token is shown once in a dialog that holds it in memory only (never in storage, the address bar or the console) and drops it when closed. Full access, which includes restore, needs an explicit confirmation. A setup checklist covers the agent's side, and it links to the Agent API guide.
- Owner-only agent management over the signed-in session, on `/api/agent-access`: list the agents that can reach a board, create a one-board agent token (shown once, optional expiry), rotate a token, and revoke it. Machine tokens cannot call these routes, and an owner cannot touch an agent that also reaches a board they do not own. An agent is addressed by a reference that pins the exact credential, so an action can never land on a different agent that reuses its name. Creation, rotation and revocation are written to the account audit trail.
- The token store now refuses to grow past 100 clients (the limit the request-time reader can parse), for the command-line tool and the routes alike, instead of silently locking every agent out.
- Optional per-token metadata and expiry: every new client records when it was created, and may carry an expiry after which the server refuses it. See `--expires` and `list --long` in the README.
- A public machine API: AI agents reach the existing board-scoped API over HTTPS on a separate hostname with no VPN, using two independent layers (a Cloudflare Access service token and the existing scoped bearer token). The origin re-verifies the signed Access assertion, the hostname serves only the machine routes, and it has a 3000 requests/minute ceiling. Opt-in through `CANVAS_PUBLIC_HOST`, `CANVAS_MACHINE_API_HOST`, `CANVAS_ACCESS_TEAM_DOMAIN` and `CANVAS_ACCESS_AUD`.
- An Agent API user guide (Help page) and `scripts/agent-api-smoke.sh`, a credential-safe curl check for a new agent.
- Production-hostname support for `whiteboard.example.com` through Cloudflare Access and Tunnel.
- Loopback-restricted proxy awareness for secure cookies, HSTS, and per-client login throttling.
- Persistent local accounts, sign-in sessions, account settings, and invitation-based registration. The first account bootstraps the installation administrator and can adopt legacy room databases as owned boards.
- Stable boards with `owner`, `editor`, and `viewer` membership roles; server-side authorization for board APIs and collaborative WebSocket connections.
- Same-origin `HttpOnly; SameSite=Strict` cookie sessions with opaque SHA-256-hashed tokens, revocable sessions, and a `Secure` cookie flag once HTTPS is configured.
- Append-oriented board history in each board's SQLite file: immutable before/after record events, per-session semantic grouping, periodic and explicit checkpoints, read-only historical viewing, and safe restoration that checkpoints the live head and compares the document clock before applying.
- Human, AI-client, and system attribution in the board timeline, including AI lifecycle event types.
- A board dashboard, account controls, collaborator controls, a history panel, and a read-only historical canvas.
- Machine bearer-token permissions extended to `read`, `write`, `history`, and `restore`, with new `read-history` and `full` access modes in the token management script.
- Explicit application-owned SQLite migrations (central `auth.sqlite` and per-board history) and architecture decision records.
- Board-scoped authenticated URLs for uploaded assets.
- Per-actor rate limits on canvas actions, AI lifecycle events, checkpoints, history restores, invitation creation, asset uploads, and authenticated asset reads, with independent budgets per path and a `rateLimits` build option for operators.
- A first Chibi Robo semantic layer: eight closed engineering entity types (component, interface, requirement, task, experiment, decision, risk, evidence) stored as a `engineering_entity` tldraw record, bounded one-hop relationships, seven semantic AI actions, a compact filtered `GET /api/rooms/:roomId/semantic-context` read endpoint with hard read/write budgets, and `entity.created`/`entity.updated`/`entity.deleted` history event types. Rides the existing sync/checkpoint/restore/authorization/rate-limiting machinery; no second persistence or history subsystem. See `docs/chibi-robo/whiteboard-integration-plan.md`.

### Changed

- When `CANVAS_PUBLIC_HOST` is set, the browser hostname refuses requests that carry an `Authorization` header under `/api/`, so a bearer token can no longer be used there. Local and private-network access with tokens is unchanged.
- The public HTTPS hostname uses `Secure; HttpOnly; SameSite=Strict` application session cookies while the private Tailscale fallback remains available.
- Opening an arbitrary room URL no longer creates an unauthenticated room; the first-use entry point is now `http://your-server/login`.
- Viewer WebSocket sessions are enforced as read-only by the server.
- Existing room-scoped AI tokens remain supported, with distinct AI attribution.
- The session cookie is `HttpOnly; SameSite=Strict` but not `Secure` on the current HTTP Tailnet deployment; the service must remain tailnet-only.
- Removed the unauthenticated legacy asset-download route after confirming production contained no legacy asset files.
- Added anti-framing, MIME-sniffing, and referrer security headers to application responses.

### Notes

- History events and checkpoints are append-only with no automatic retention or compaction; full-snapshot checkpoints and full record changes grow a long-lived board's database without bound, and reconstruction replays every event since the nearest checkpoint.

## 2026-09-13

### Added

- An authenticated, room-scoped API for external AI clients to read the canvas and apply bounded native tldraw actions.
- Absolute arrow endpoint coordinates in compact canvas snapshots.

## 2026-09-09

### Added

- The Node.js, Fastify, tldraw sync, and per-room SQLite self-hosting path used by `your-server`.
- Private Tailscale Serve deployment and recovery documentation.
- Shared validated AI canvas commands.

### Changed

- Pinned the production package-manager version.
- Documented HTTP-over-Tailscale as the reliable WebSocket route for this installation.

## Earlier history

Earlier commits are primarily upstream tldraw version updates. They remain available in Git; this changelog does not infer additional user-facing changes that the repository cannot establish.
