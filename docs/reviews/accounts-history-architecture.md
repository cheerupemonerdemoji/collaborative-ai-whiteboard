# Accounts and history architecture review

Date: 2026-09-14

Five independent read-only OpenCode reviews using Cloudflare Workers AI inspected the existing repository before implementation. Codex checked their claims against the repository and the installed tldraw 5.4.1 source before selecting the design below.

## Reviewer findings

1. **Existing architecture:** the active deployment is a single Node/Fastify process. One sanitized room ID maps to one `TLSocketRoom`, one `SQLiteSyncStorage`, and one persistent SQLite file. Browser WebSockets had no identity or authorization. Room-scoped bearer tokens protected only the external canvas API.
2. **Accounts:** use stable server-generated user IDs, password-specific hashing, opaque revocable server-side sessions, stable board records, and server-enforced owner/editor/viewer membership. A same-origin cookie is the least disruptive way to authenticate browser WebSocket upgrades.
3. **History:** keep board history in the same per-board SQLite file as tldraw state, use immutable events and periodic full checkpoints, and restore by creating a new head rather than rewriting old history.
4. **UI:** place history in an application-owned right panel, retain a visibly separate read-only historical canvas, and require an explicit confirmation before restoring.
5. **Security/data integrity:** authorize before loading a room; require matching browser origins; close active sockets after membership changes; keep machine and human principals distinct; and make the canvas mutation plus its history journal one SQLite transaction.

## Disagreements and corrections

- One review proposed attributing human changes from `onCommittedChanges`. Inspection of `@tldraw/sync-core@5.4.1` showed that callback provides a diff and clock but no session identity, runs after the transaction in a microtask, and omits server-originated mutations. It is not used as the authoritative history boundary.
- A review suggested short-lived WebSocket tickets. Same-origin `HttpOnly` sessions are simpler for this private Node-only deployment and do not place credentials in URLs. The tldraw-generated `sessionId` remains a non-secret transport identifier and is never treated as identity.
- A review suggested placing all account and board metadata in each room database. A central `auth.sqlite` is selected for users, sessions, invitations, board listings, and memberships; board-specific content history stays beside that board's tldraw state. This gives efficient dashboards without weakening per-board backup integrity.
- Full snapshots for every event would simplify viewing but grow quickly. Immutable net-effect record changes plus periodic checkpoints are selected instead.

## Selected design

- `auth.sqlite` lives under `CANVAS_DATA_DIR`, uses WAL and foreign keys, and contains users, hashed sessions, boards, memberships, invitations, and account audit events.
- Passwords use salted, parameterized `scrypt`; high-entropy session and invitation tokens are stored only as SHA-256 hashes. Sessions are sent only in an `HttpOnly; SameSite=Strict` cookie. The cookie becomes `Secure` when HTTPS is configured.
- The first account safely adopts discovered legacy boards. Later registration requires a one-time invitation unless the operator explicitly enables open registration.
- Browser room, history, membership, and upload mutations require an authenticated board role. Viewers connect with both canvas and object-store writes disabled. Membership changes disconnect affected live sessions so authorization is re-evaluated.
- External bearer clients remain separate `token:<name>` AI principals. Read/write canvas scope does not automatically grant history reading or restoration.
- A history-aware storage boundary captures the authenticated principal synchronously and records the committed net record changes. API actions and restores explicitly supply their verified actor.
- User-facing history events are immutable. Rapid consecutive record fragments from one actor are combined without crossing checkpoint, restore, actor, or session boundaries.
- Reconstruction loads the nearest checkpoint and replays validated full before/after record changes. Restore checks the current document clock, saves the live state first, applies the target, and appends restore events in one transaction.
- The preserved Cloudflare Durable Object implementation remains a rollback target; this phase applies to the canonical Node/SQLite deployment only.

## Consequences

- Existing room files and token hashes can be upgraded in place; no database deletion is required.
- A single Node process remains the supported write boundary for SQLite rooms.
- Plain HTTP is acceptable only inside the encrypted tailnet. Public exposure would require HTTPS, secure cookies, stronger rate limiting, and a fresh security review.
