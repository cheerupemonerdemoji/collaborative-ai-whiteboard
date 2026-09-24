# Architecture

## Self-hosted production

```text
Browser A ─┐
Browser B ─┼──── private Tailscale network ── your-server
Local AI ──┘                                    │
                                                ├─ Tailscale Serve → 127.0.0.1:8787
                                                ├─ Node 22 / Fastify
                                                ├─ HttpOnly session cookie (canvas_session)
                                                ├─ auth.sqlite (users, sessions, boards, memberships, invitations, audit)
                                                ├─ per-board SQLite (tldraw state + history)
                                                ├─ token-checked read/action API
                                                ├─ tldraw TLSocketRoom
                                                └─ persistent rooms + assets
```

One sanitized board ID maps to one live `TLSocketRoom` and one SQLite file. `NodeSqliteWrapper` adapts `better-sqlite3` to tldraw's sync storage. Browser WebSocket upgrades carry the authenticated session, and the board role on that session decides whether the connection is read-only or read-write. When the final session leaves, the room and database handles close; the SQLite file remains and is reopened on the next connection.

Tailscale Serve proxies the tailnet-only HTTP endpoint to the application bound exclusively to `127.0.0.1:8787`. The tailnet transport is encrypted by WireGuard. The `jam` user service owns the application and persistent data; systemd lingering starts it at boot. Plain HTTP and the `HttpOnly` account cookie are acceptable only because traffic never leaves the tailnet.

## Accounts, sessions, and roles

```text
first registration ──► bootstrap (administrator) ──► adopt legacy boards
administrator ──► account invitations            board owner ──► board invitations
register (with invitation) ──► user + membership
login ──► opaque session token (SHA-256 hash stored, HttpOnly SameSite=Strict cookie)
board role = owner | editor | viewer
```

- `auth.sqlite` is the central account database: WAL, foreign keys, and a versioned migration ledger. It holds users, hashed sessions, stable boards, memberships, invitations, and append-only account audit events.
- The first registration bootstraps the installation administrator. Later registration needs a one-time invitation unless open registration is explicitly enabled by the operator.
- Board roles are `owner`, `editor`, and `viewer`. Viewer WebSocket sessions are opened with tldraw read-only and object-store read access; membership changes close affected live sessions so authorization is re-evaluated.
- Sessions expire by default after 30 days and can be revoked immediately. The cookie receives the `Secure` flag when HTTPS is configured; on the current HTTP tailnet deployment it must not be.
- Passwords use salted, parameterized scrypt. Session and invitation tokens are high-entropy values stored only as SHA-256 hashes.

## Board history

```text
human edits ──► per-session coalescing fragments ──► immutable events
AI/bearer actions, restores ──► verified actor ──► immutable events
periodic / explicit / pre_restore / restore_completed checkpoints (full snapshots)
view a version = nearest checkpoint + validated events (read-only canvas)
restore = clock check + checkpoint live head + apply target + append events
```

- History events and checkpoints live in the same SQLite file as the board's tldraw state and share the same backup unit.
- Finalized events and checkpoints are append-only at the database boundary (SQLite triggers). Rapid consecutive record fragments from one authenticated session are combined into a single semantic event without crossing actor, session, checkpoint, or restore boundaries.
- A history-aware storage boundary captures the verified principal synchronously inside tldraw's existing transaction, so the canvas mutation and its durable history fragment commit together and roll back together.
- A `legacy_import` checkpoint is created automatically the first time a pre-existing room opens, giving older boards a baseline.
- Reconstruction starts from the nearest checkpoint and replays validated full before/after record changes. Restore performs an optimistic clock check (409 on conflict), checkpoints the live head first, applies the target, and appends restore events; earlier history is never rewritten, so restores are reversible.
- Attribution is `human`, `ai`, or `system`, including the AI lifecycle vocabulary.

## External AI path

```text
Local AI → GET room canvas → generate actions locally
                              │
              room-scoped bearer token
                              │
              POST room actions (optional clock)
                              │
                Zod + tldraw validation
                              │
               atomic SQLite transaction
                              │
                 live WebSocket fan-out
                              │
                 human tldraw canvases
```

The server never receives an AI model key. Client bearer tokens are hashed in a server-only file; each names allowed rooms and grants separate `read`, `write`, `history`, and `restore` permissions. Supported tools are `create_shape`, `create_text`, `create_arrow`, `update_text`, `move_shape`, `resize_shape`, `delete_shape`, and `connect_shapes`. The API does not accept arbitrary executable output. Machine principals stay distinct from human principals, and read/write canvas scope does not automatically grant history reading or restoration.

## Preserved Cloudflare V1

Tag `cloudflare-v1-working` points to the verified Durable Object implementation:

```text
Browsers ── WebSocket/useSync ── Cloudflare Worker
                                      │
                                      ├─ room Durable Object
                                      ├─ Durable Object SQLite
                                      ├─ R2 assets
                                      └─ server-side OpenAI endpoint
```

`worker/`, `wrangler.jsonc`, and the Cloudflare build command remain in the current repository. This makes rollback possible without weakening the new production path. The accounts/history phase applies to the canonical Node/SQLite deployment only.

## Persistence and recovery

Production state lives under `/home/app/.local/share/collaborative-ai-canvas`, never under `dist`, `/tmp`, or the Git checkout:

- `auth.sqlite` — accounts, sessions, boards, memberships, invitations, account audit events.
- `rooms/*.sqlite` — per-board tldraw state plus that board's history events, checkpoints, and fragments.
- `assets/` — uploaded media.

`CANVAS_AUTH_DB_FILE` overrides the account database location; it defaults to `$CANVAS_DATA_DIR/auth.sqlite`. Backups archive the data directory while the service is stopped, which captures accounts, boards, history, and assets together. The token-hash file and environment live under `/home/app/.config/collaborative-ai-canvas/` and are separate configuration. Code recovery uses Git; Cloudflare baseline recovery uses the protected tag. Upgrades are additive, versioned migrations; existing room files and token hashes are never deleted.

## Trust boundaries

- Tailscale membership gates initial network access.
- Node is not exposed on LAN or public interfaces; do not enable Tailscale Funnel.
- Browser access requires an account and board membership; viewer sessions are read-only server-side and membership changes disconnect live sessions.
- The session cookie is `HttpOnly; SameSite=Strict` and becomes `Secure` only under HTTPS. On the current HTTP tailnet deployment it is not `Secure`, so the service must remain tailnet-only.
- Application token hashes and session token hashes are outside Git with mode `600`; bearer and session tokens are shown only once at issuance.
- Account and board metadata live in the central `auth.sqlite`; board content history lives beside that board's tldraw state.
- Room IDs, board IDs, and asset IDs reject traversal characters.
- Upload type, size, and immutable filenames are constrained.
- External action requests are schema validated before and during the room transaction; multi-action writes are atomic.
- External AI clients receive no operating-system capabilities from the whiteboard API.
- History and checkpoints are append-only with no retention policy; long-lived boards grow without bound and reconstruction cost grows with the number of events since the nearest checkpoint.