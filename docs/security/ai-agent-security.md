# AI agent security

How external AI/machine clients are kept separate from human accounts, what
they can and cannot do, and why the canvas API does not become a general
execution surface just because an AI is driving it.

## Human and machine identity are structurally separate

There is no such thing as an AI "logging in as" a human, and no such thing
as a human session being reinterpreted as a machine token. They are two
entirely different code paths in `server/app.ts`'s `resolveBoardAccess`:

- A **human identity** comes from the `canvas_session` cookie, resolved
  against `auth.sqlite`'s session table, and carries a board **role**
  (`owner`/`editor`/`viewer`).
- A **machine identity** comes from an `Authorization: Bearer <token>`
  header, resolved against a local JSON file of token hashes
  (`server/tokens.ts`), and carries a set of **scopes**
  (`read`/`write`/`history`/`restore`) explicit per board.

A bearer token is never accepted in place of a session, and a session
cookie is never accepted in place of a bearer token (`tests/server-app.test.ts`
covers a forged bearer header being rejected on a route that expects a
session, and vice versa). This means a compromised AI credential cannot be
used to act as any human, and a compromised human session cannot be used to
mint or extend machine-token scope -- there is no privilege bridge between
the two.

## Bearer-token scopes are independent, not hierarchical

`server/tokens.ts`'s `authorizeApiToken` checks a specific
`(token, roomId, permission)` triple against the configured client list.
The four permissions -- `read`, `write`, `history`, `restore` -- are
independent grants:

- A `write`-only token can mutate the canvas but cannot read board history
  or restore an earlier version.
- A `read`-only token can read the canvas and compact semantic context but
  cannot write anything, including semantic entities.
- Tokens are scoped to specific room/board IDs -- a token valid for board
  `demo` has no access to board `other-project`, even with matching
  permissions.

Token values themselves are never stored in plaintext: `scripts/manage-api-tokens.mjs`
prints a token exactly once at creation time and persists only its SHA-256
hash. A leaked token file (e.g. a misconfigured backup) does not, by itself,
yield usable tokens -- the same property session tokens have.

## Validated actions, not arbitrary execution

An AI client never gets a code-execution surface, a shell, or direct
filesystem/database access. Every mutation an AI can request -- visual
(`create_shape`, `create_text`, `create_arrow`, `update_text`, `move_shape`,
`resize_shape`, `delete_shape`, `connect_shapes`) or semantic
(`create_entity`, `update_entity`, `link_entities`, `unlink_entities`,
`record_experiment_result`, `attach_evidence`, `update_status`) -- is a
closed, Zod-validated action type (`shared/ai.ts`, `shared/entities.ts`).
There is no "run this script," "fetch this URL," or "read this file" action
in the schema, and there never has been. Adding a new action type is a
deliberate, reviewed schema change, not something a client can request at
runtime.

This extends to evidence references in the Chibi Robo semantic layer: an
evidence record can *point at* a Git commit, file path, CAD file, image,
document, or URL, but the server never dereferences, fetches, previews,
checksums, or executes any of those references. They are opaque, validated
strings (bounded length, no control characters, `https://`-only for
URL-shaped references) stored purely for a human or another tool to follow
manually. There is no code path anywhere in the server that opens a local
path or issues an outbound request based on an evidence reference.

Every action batch is applied inside one atomic room transaction
(`room.storage.transaction` in `server/canvas-api.ts`): either every action
in the batch succeeds, or none of them are persisted or broadcast. An
invalid reference partway through a batch rolls the whole batch back, so an
AI client cannot leave a board in a partially-applied state by sending a
malformed request.

## Every AI action is board-authorized, exactly like a human's

A bearer token still has to pass `resolveBoardAccess` and the specific
scope check for the route it's calling -- there is no separate,
less-scrutinized code path for machine callers. AI writes go through the
same `/api/rooms/:roomId/actions` endpoint, the same rate limiter
(`writeLimiter`, keyed by `token:<client>` + board, independent from any
human's budget on the same board), and the same schema validation as a
human editor's writes.

## History attribution

Every event an AI causes is recorded with `source: 'ai'` and
`actorUserId: token:<client-name>` (`server/history-storage.ts`,
`server/app.ts`'s `historyActor`), so the board timeline always shows which
actions were human and which were machine-originated, and which specific
named client did it -- not a generic "AI" bucket. This is the same generic
history/checkpoint/restore machinery every other change uses; there is no
separate, weaker audit trail for machine actions.

## Restore protections apply equally

A machine token needs the specific `restore` scope (separate from `write`)
to restore a board version. Restore is optimistic-concurrency-protected
(`expectedClock`, HTTP 409 on a stale view) and always checkpoints the live
head first, regardless of whether the caller is human or machine -- an AI
client cannot silently discard history by restoring, only create a new head
with the prior state preserved and checkpointed.

## What is explicitly out of scope for V1

- No autonomous background agents; every action is a synchronous request an
  external process chose to send.
- No arbitrary graph queries or generalized query language over semantic
  entities -- compact context reads are bounded filters (entity type,
  status, IDs, one-hop relations for a specific entity), not a database
  query interface.
- No AI-initiated account, invitation, or board-membership management --
  those remain human-session-only operations regardless of bearer-token
  scope.
- Live, public-path verification that scope enforcement holds under real
  network conditions is a currently-open acceptance item (production has
  zero configured machine clients as of this writing) -- see
  `docs/development/current-state.md` and
  `docs/reviews/2026-09-22-chibi-entity-design-deepseek.md` finding 1.
