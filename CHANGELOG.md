# Changelog

This file records user-facing changes to the application. Git remains the authoritative record of code changes.

## Unreleased

### Added

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
- Per-actor rate limits on canvas actions, AI lifecycle events, checkpoints, history restores, invitation creation, and asset uploads, with independent budgets per path and a `rateLimits` build option for operators.
- A first Chibi Robo semantic layer: eight closed engineering entity types (component, interface, requirement, task, experiment, decision, risk, evidence) stored as a `engineering_entity` tldraw record, bounded one-hop relationships, seven semantic AI actions, a compact filtered `GET /api/rooms/:roomId/semantic-context` read endpoint with hard read/write budgets, and `entity.created`/`entity.updated`/`entity.deleted` history event types. Rides the existing sync/checkpoint/restore/authorization/rate-limiting machinery; no second persistence or history subsystem. See `docs/chibi-robo/whiteboard-integration-plan.md`.

### Changed

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
