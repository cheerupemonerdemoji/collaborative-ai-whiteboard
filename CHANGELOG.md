# Changelog

This file records user-facing changes to the application. Git remains the authoritative record of code changes.

## Unreleased

### Added

- **Agent images and links (not deployed).** An agent with write access can upload a PNG, JPEG, GIF or WebP (`POST /api/boards/:board/images`, at most 4 MB and 8192 pixels, 100 per board; SVG is refused), place it with `create_image`, and give a rectangle, ellipse, note or image a clickable `https` link with `set_link`. Files are checked by their real bytes, stored under their hash and served only to board members as exactly their own type. See ADR 014 and the Agent API reference.
- CAD exploded view: a recorded layout for the TurtleBot3 Burger Level A assembly file (20 inferred groups), so its exploded view keeps the plates, boards and lidar in one column, sends each motor-sized block outward with its tire further out, and draws the standoffs beside the column, instead of dropping the motors far below the base. It applies only to a file with exactly those group names at those positions; every other file keeps the automatic layout. Display only: nothing stored changes, and the directions are not assembly or removal paths. See `the TurtleBot explode plan review record`.
- **Machine CAD upload.** A token the operator mints with the new `cad-upload` capability (`manage-api-tokens.mjs create <name> <board> read-write --cad-upload --expires 7d`) can store validated CAD files (STL, GLB, STEP, thumbnail) and add a CAD model entry with its card to its one board, through two machine routes. The capability needs write access, exactly one board and an expiry of at most 365 days (30 until 2026-11-08), checked when it is minted, rotated and used; the human CAD routes are unchanged and review and approval stay with people. The Agents page shows an "Uploads CAD files" badge and offers such an agent only expiries within that limit, and `list` shows the capability. Rotating such an agent to an access level without write removes the capability for good. See ADR 013.
- **A public guide for agents.** `GET /agent-guide.md` explains, in plain text and with no sign-in, how an agent connects: the values it is given, four copyable checks, how to create boards, and what each reply means. The Agents page's **Copy full setup** block now begins with its address, so an agent handed the block knows where to read how to use it. It names no secret, and it is a 404 on the Cloudflare-gated agent hostname. See ADR 012.
- **One-block agent setup.** After you create or rotate an agent, the one-time dialog now has a **Copy full setup** button that copies the agent's address, whiteboard ID, token and a first-check command as one block, ready to paste into the agent's secret store. If the agent reaches the whiteboard through Cloudflare, the block also has two empty Cloudflare lines for your administrator to fill in; this page never sees those. `GET /api/agent-access/config` (signed-in only) tells the page which address to use.
- CAD exploded view: the two motor models that sit in the same place in the grouped Otto file (SG90 and MG90S) are now identified as unverified, with a control to draw both as the file supplies them (the default), the SG90 only, or the MG90S only. Display only: neither motor is removed or moved, nothing stored changes, and the file does not say which one is fitted. See `the CAD exploded layout review record`.
- CAD exploded view layout (not deployed): the groups of the grouped Otto DIY file now move along planned straight lines until they are clear of each other, instead of straight out from the centre, and any other file gets an automatic layout that also keeps a gap between groups. A **Fit exploded view** button frames the exploded parts without turning the view (**Fit / reset view** still returns to the assembled framing), a **Component groups** list selects, hides and shows the groups, the parts tree is taller, and a note says the picture is a visualization, not mates, fit, clearance or disassembly. Nothing stored changes. See `the CAD exploded layout review record`.
- Read-only machine telemetry, phase 1 (not deployed): a `telemetry-card` shape shows a machine name, its readings, the last update and a Fresh / Stale / Offline badge. Readings come from a protected server-side reader that validates a strict telemetry contract, keeps the last good snapshot, times out hung reads and reports failures as categories only; a source is bound to specific boards and answers only to signed-in board members. The only provider is a simulated sensor, there is no Viam connection and no command path. See [Read-only Viam telemetry](the telemetry design note).
- CAD exploded view now moves complete component groups instead of single meshes (not deployed). A GLB marks a group with `extras.explodeGroup: true`; the server records the groups only when every mesh is covered, and without verified grouping the slider is disabled with an explanation. Review-only: no stored file, revision or approval changes. See [CAD assembly review](the CAD assembly review design note).
- CAD assembly review (first slice, not deployed): a GLB with several named parts gets a parts tree (stable identities only where the file supplies them), select/hide/isolate/reset, a review-only exploded view that returns exactly to the original transforms, a bill of materials copied only from explicit file metadata, and links from an assembly revision to exact component revisions. Assembly and component approval are separate. Parts, BOM and links are read or written by the server only, links freeze once a revision leaves draft, and AI cannot link or approve. Mates and STEP validation are not done; see `the CAD assembly review design note`.
- Browser CAD review (first slice, not deployed): a lightweight `cad-review` card on the canvas that opens a large interactive Three.js viewer (rotate, pan, zoom, fit/reset) for a GLB or STL preview, with the STEP file kept as the manufacturing source. Model, revisions, comments, evidence links and Draft / In review / Approved / Rejected status live in a `cad_model` record that only the server can write; files are content-addressed board assets served by the existing authenticated asset route. Approved revisions are final, AI clients cannot decide, comment or delete a CAD card, and nothing under `public/` carries a model. See `the CAD review design note`.
- **Site-owner access.** The installation administrator can now open, edit, restore and manage every board, not only boards they were invited to, with their real role shown as `site owner`. The recorded owner and the membership list are not changed by it. The whiteboards page has an **All boards (site owner)** checkbox for administrators; `GET /api/boards?scope=all` is the same view and is refused for everyone else. Management actions taken this way are marked in the audit trail, and sockets, uploads and restores are recorded as `admin.board_accessed`. The administrator can also list, rotate and revoke any agent credential, so a lost token can always be replaced; no one can read an existing token, since only hashes are stored. See ADR 011.
- **Agent layout.** Agents can now see where everything on a board actually is and place new work without overlapping it. `GET /api/rooms/BOARD_ID/layout` (read scope) returns page-space bounds for every shape, nested ones included, each marked `measured`, `declared` or `estimated` and `verified` or `unverified`. New layout actions on `/actions` (`place_below`, `place_right_of`, `find_free_region`, `align`, `distribute`, `row`, `stack`, `grid`; 64 px default gap) move shapes, re-route the arrows the API drew, and reply with a verification report: resulting bounds, overlaps, spacing, alignment and any text whose size is only estimated, which is reported as `partially_unverified` rather than as a clean result. `connect_shapes` now draws real tldraw arrows attached to both shapes, and `create_text` takes an optional `width`. When someone who can edit has the board open, their browser reports the sizes it measured for text and notes, which upgrades those shapes to `measured`; it never moves anything. See ADR 008 and the Agent API guide.
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
