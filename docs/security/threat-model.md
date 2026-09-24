# Threat model

This describes the trust boundaries as implemented, not as aspired to. Where
a boundary is enforced by code, this document says what enforces it and
where. Where a boundary depends on an operational choice (a firewall rule, a
Cloudflare Access policy), it says so explicitly rather than implying the
application enforces something it does not.

## Trust boundaries

```
Internet
  |
  v
public reverse proxy / tunnel        <- operational boundary, not this codebase
  |  (Cloudflare Access + Cloudflare Tunnel in the reference deployment;
  |   any TLS-terminating reverse proxy works. The application does not
  |   know or care which one fronts it.)
  v
Fastify application (server/app.ts)  <- everything below this line is
  |                                     enforced by this repository's code
  |-- human sessions        (server/auth.ts, server/security.ts)
  |-- board RBAC             (server/app.ts: resolveBoardAccess, userRoleHasWrite)
  |-- WebSocket authorization (server/app.ts: /api/connect/:roomId upgrade handler)
  |-- uploads/assets          (server/app.ts: board-scoped upload/asset routes)
  |-- history/restore         (server/history.ts, server/rooms.ts: restoreRoomVersion)
  |-- AI bearer-token API     (server/tokens.ts, server/app.ts: bearerPermissions)
  v
Per-board SQLite (state + history) + central auth.sqlite
```

## What each boundary actually enforces

### 1. Reverse proxy / tunnel (operational, not application code)

The reference deployment puts Cloudflare Access in front of the application
as an *additional*, optional outer gate. **The application does not trust
this boundary for authorization** -- every route re-checks session and board
membership independently, specifically so that self-hosting this project
without Cloudflare Access (or with it later disabled) does not silently
remove any security property. Access is deny-by-default and denies
unapproved identities before the origin is ever reached, which is valuable
defense-in-depth, but it is documented here as what it is: an operational
choice, not a substitute for application authorization. See
`docs/decisions/004-cloudflare-whiteboard-access.md` for that specific
deployment's Access configuration.

The origin process binds to loopback only (`127.0.0.1`) and is never
directly reachable from outside the host. There is no router port
forwarding for this application.

### 2. Human sessions

- Passwords are hashed with parameterized scrypt (`server/auth.ts`).
- Session tokens are high-entropy random values; only their SHA-256 hash is
  stored (`server/auth.ts`, `server/auth-db.ts`). A stolen database dump
  does not yield usable session tokens.
- Session cookies are `HttpOnly` always, `SameSite=Strict` always, and
  `Secure` whenever the deployment is reachable over externally-terminated
  HTTPS (`server/security.ts`). A plain-HTTP private deployment (e.g. over a
  WireGuard/Tailscale-only network) intentionally omits `Secure`, since
  requiring HTTPS-only cookies on an HTTP-only transport would break the
  cookie entirely -- this is a deliberate tradeoff for that deployment
  shape, not an oversight, and is why that shape is restricted to an
  encrypted private network.
- Every mutating request checks the request `Origin` header against an
  explicit allowlist (`CANVAS_ALLOWED_ORIGINS`); a request from an
  unexpected origin is refused before authentication is even considered.
- Login failures return a generic error and do not distinguish "unknown
  login" from "wrong password" (checked in
  `tests/server-app.test.ts`/`tests/auth.test.ts`).
- Authenticated write paths carry per-actor rate limits keyed by the
  already-authorized identity (`user:<id>` or `token:<client>`), never by a
  client-supplied value.

### 3. Board RBAC (owner / editor / viewer / non-member)

Every board-scoped route independently resolves the caller's membership and
role from `auth.sqlite` on each request (`resolveBoardAccess` in
`server/app.ts`) -- there is no cached or client-asserted role. A
client-supplied user ID is never trusted as proof of identity: identity is
always derived from the session token or bearer token, never from a request
parameter. See `docs/security/authorization-matrix.md` for the full
per-operation matrix.

### 4. WebSocket authorization

Fastify completes the WebSocket protocol upgrade before the application's
own authorization can run (a Fastify/`ws` characteristic, not a choice this
project made). The practical consequence: a socket for an unauthorized
caller briefly *opens* and is then immediately closed by the application
with policy code `1008`, rather than being refused at the HTTP-upgrade
level. Any client integration (including this project's own acceptance
harness, `scripts/public-acceptance.mjs`) must treat "opened, then closed
with 1008" as a refusal, not a success -- treating the bare upgrade as
authorization is a known trap, documented at the point it bit the
acceptance harness itself (`docs/reviews/2026-09-22-public-acceptance-harness-deepseek.md`).
Viewer sessions are connected with `isReadonly: true` at the tldraw
sync-core level (`server/rooms.ts`), so a viewer's socket can receive
updates but the server-side sync engine itself refuses to apply a viewer's
write, independent of anything the browser UI does or does not allow.

### 5. Uploads / assets

Uploads are scoped to the board they were uploaded to and require write
authorization on that board; reads require membership on that board.
Upload IDs are validated against path traversal. An upload ID cannot be
reused to overwrite an existing asset (`server/app.ts`,
`tests/server-app.test.ts`).

### 6. History / restore

History and restore share the authorization check used for canvas writes
(membership + write role, or a token with the specific `history`/`restore`
scope). Restore is optimistic-concurrency-protected (`expectedClock`, HTTP
409 on a stale view), always checkpoints the live head before applying a
restore (`pre_restore` reason), and never rewrites earlier history -- a
restore creates a new head. See `docs/decisions/` for the underlying ADRs.

### 7. AI bearer-token API

Machine identities are structurally separate from human sessions: a bearer
token is matched against a local JSON file of SHA-256 token hashes
(`server/tokens.ts`), each entry scoped to specific board IDs and specific
permissions (`read`, `write`, `history`, `restore`). A token never
authenticates as a human session and cannot be used to bypass board
membership -- it has its *own* scoped grant instead. See
`docs/security/ai-agent-security.md`.

### 8. Engineering-entity semantic layer

The Chibi Robo semantic actions (`create_entity`, `update_entity`,
`link_entities`, `unlink_entities`, `record_experiment_result`,
`attach_evidence`, `update_status`) ride the exact same authorization,
transaction, rate-limiting, and history path as the pre-existing visual
canvas actions (`server/app.ts`'s `/api/rooms/:roomId/actions`) -- there is
no separate, less-scrutinized write path for semantic data. Evidence
references are stored as opaque strings and are never dereferenced,
fetched, previewed, checksummed, or executed by the server
(`shared/entities.ts`). Compact semantic-context reads are hard-capped
(entity count, relationship-edge count, referenced-summary count,
serialized bytes) and fail explicitly rather than silently truncating; the
server never sends the entire raw tldraw document merely because semantic
metadata exists.

## Explicit non-goals / accepted risk

- **Denial of service from network-layer volume** (not authenticated
  request-rate abuse, which the rate limiters cover) is an operational
  concern for whatever sits in front of the origin, not something this
  application defends against itself.
- **A compromised admin account** can create account invitations and adopt
  legacy boards. There is currently no secondary approval step for
  administrator actions. This is accepted for the current single-operator
  deployment shape.
- **A compromised machine bearer token** can act with exactly the
  permissions and rooms it was scoped to -- token scoping is the mitigation,
  not detection. There is no automatic token revocation on suspected
  compromise beyond the existing manual `revoke` command
  (`scripts/manage-api-tokens.mjs`).
- **History and checkpoints are currently unbounded** for a given board
  (ADR 005 designs retention; it is implemented and tested but has never
  been run against production -- see `docs/decisions/005-history-retention.md`).
  This is a growth/storage concern, not a confidentiality or integrity one.
