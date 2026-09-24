# Authorization matrix

What each identity can do, as implemented in `server/app.ts` and exercised by
`tests/server-app.test.ts`, `tests/chibi-semantics.test.ts`, and
`scripts/public-acceptance.mjs`. "Denied" means the server refuses the
operation regardless of what a client UI does or does not expose -- these
are server-side checks, not UI-only restrictions.

Identities:

- **anonymous** -- no session cookie, no bearer token (may still be behind
  an outer Cloudflare Access gate in the reference deployment; that gate is
  a separate, optional layer -- see `docs/security/threat-model.md`).
- **authenticated nonmember** -- a valid application session, but no
  membership row for the board in question.
- **viewer** / **editor** / **owner** -- a valid application session with
  that board-membership role.
- **machine read / write / history / restore** -- a bearer token
  (`server/tokens.ts`) scoped to the board and holding that one permission.
  A token's permissions are independent and not implied by each other:
  holding `write` does not grant `read`, `history`, or `restore`.

| Operation | anonymous | nonmember | viewer | editor | owner | token: read | token: write | token: history | token: restore |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `GET /api/health` | allowed | allowed | allowed | allowed | allowed | allowed | allowed | allowed | allowed |
| `GET /api/boards` (list own) | denied (401) | n/a (lists only own memberships) | allowed | allowed | allowed | n/a | n/a | n/a | n/a |
| `POST /api/boards` (create) | denied (401) | allowed (creator becomes owner) | -- | -- | -- | n/a | n/a | n/a | n/a |
| `GET /api/boards/:id` (metadata) | denied (401) | denied (404) | allowed | allowed | allowed | n/a | n/a | n/a | n/a |
| `PATCH /api/boards/:id` (rename) | denied | denied | denied | denied | allowed | n/a | n/a | n/a | n/a |
| `DELETE /api/boards/:id` | denied | denied | denied | denied | allowed | n/a | n/a | n/a | n/a |
| `GET /api/boards/:id/members` | denied | denied (404) | allowed | allowed | allowed | n/a | n/a | n/a | n/a |
| `PUT /api/boards/:id/members/:userId` (set role) | denied | denied | denied | denied | allowed | n/a | n/a | n/a | n/a |
| `POST /api/invitations` (no boardId -- account invite) | denied | denied unless admin | denied unless admin | denied unless admin | denied unless admin | n/a | n/a | n/a | n/a |
| `POST /api/invitations` (boardId + role -- board invite) | denied | denied | denied | denied | allowed (owner only; `role: 'owner'` always refused, schema + business rule) | n/a | n/a | n/a | n/a |
| `POST /api/invitations/consume` | allowed (creates account or membership) | -- | -- | -- | -- | n/a | n/a | n/a | n/a |
| `POST /api/invitations/revoke` | denied | denied | denied | denied (unless invitation creator) | allowed | n/a | n/a | n/a | n/a |
| `GET /api/connect/:roomId` (WebSocket) | denied (closes 1008 after upgrade) | denied (closes 1008) | allowed, `isReadonly: true` | allowed, read+write | allowed, read+write | n/a (tokens do not open sockets) | n/a | n/a | n/a |
| `GET /api/rooms/:id/canvas` | denied (401) | denied (404) | allowed | allowed | allowed | allowed | denied (no `read` scope) | denied | denied |
| `POST /api/rooms/:id/actions` (visual actions) | denied | denied | denied (403) -- server-enforced, not just UI | allowed | allowed | denied (no `write` scope) | allowed | denied | denied |
| `POST /api/rooms/:id/actions` (semantic actions: create/update/link/unlink/record_experiment_result/attach_evidence/update_status) | denied | denied | denied (403) | allowed | allowed | denied | allowed | denied | denied |
| `GET /api/rooms/:id/semantic-context` | denied | denied | allowed | allowed | allowed | allowed | denied | denied | denied |
| `POST /api/rooms/:id/ai/events` | denied | denied | denied | allowed | allowed | denied | allowed | denied | denied |
| `GET /api/boards/:id/history` | denied | denied | allowed | allowed | allowed | denied | denied | allowed | denied |
| `GET /api/boards/:id/history/:eventId/snapshot` | denied | denied | allowed | allowed | allowed | denied | denied | allowed | denied |
| `GET /api/boards/:id/checkpoints` | denied | denied | allowed | allowed | allowed | denied | denied | allowed | denied |
| `POST /api/boards/:id/checkpoints` (create) | denied | denied | denied (403) | allowed | allowed | denied | denied | denied | denied |
| `POST /api/boards/:id/restore` | denied | denied | denied (403) | allowed | allowed | denied | denied | denied | allowed |
| `POST /api/boards/:id/uploads/:uploadId` | denied | denied | denied (403) | allowed | allowed | denied | allowed | denied | denied |
| `GET /api/boards/:id/assets/:uploadId` | denied | denied (404) | allowed | allowed | allowed | allowed | denied | denied | denied |
| Cross-board asset read (asset ID from a different board) | denied | denied | denied | denied | denied | denied | denied | denied | denied |

Notes:

- "n/a" means the operation has no meaningful concept of that identity
  (e.g. a bearer token cannot open a browser WebSocket session; account
  invitations are meaningless for an unauthenticated caller since they
  don't yet have an account to check admin status against).
- Verified directly against `resolveBoardAccess`/`denyAccess` in
  `server/app.ts`: no session at all is always `401`. A *member* with the
  wrong role (e.g. a viewer attempting an owner-only action) is always
  `403`. An *authenticated nonmember* -- a real session, but no membership
  row for that specific board -- is always `404`, deliberately identical to
  "board doesn't exist," so a non-member's request cannot be used to
  confirm a private board exists (see `tests/server-app.test.ts`, `E9`-`E15`
  in `scripts/public-acceptance.mjs`). An insufficiently-scoped bearer token
  is `403`; a token that doesn't match any configured client at all is
  treated as anonymous (`401`), not `403` -- it never reveals whether a
  board or token name exists.
- Owner-role invitations are refused at two independent layers: the request
  schema's `role` enum does not include `'owner'` (so it fails schema
  validation, HTTP 422), and even if that were bypassed, the business logic
  in `server/auth.ts` separately rejects it. See
  `docs/reviews/2026-09-22-public-acceptance-harness-deepseek.md` finding 3
  for the exact status-code discovery.
- A machine token's four permissions (`read`, `write`, `history`,
  `restore`) are independent grants, not a hierarchy -- a `write`-only
  token cannot read history or restore a board even though it can mutate
  the canvas. This specific claim -- that scopes are enforced
  independently and not just documented as independent -- has automated
  local-integration coverage (`server/tokens.ts`,
  `tests/canvas-api.test.ts`) but **no live public-path verification yet**;
  see `docs/development/current-state.md`'s open items.
