# ADR 005: Board history retention and compaction

- Status: **Accepted** 2026-09-20. Implemented in `scripts/compact-history.ts`
  and migration `history:0006-retention-gate`. The first destructive production
  run remains gated on the checklist in "Production gate" below.
- Date: 2026-09-20
- Extends ADR 003 (append-oriented board history)

## Context

The CHANGELOG already flags the consequence of ADR 003: history is append-only
with no retention, so full-snapshot checkpoints and full record changes grow a
long-lived board without bound. This ADR measures that and proposes a response.

### How history is stored

Each board is one SQLite file holding live state and its own history:
`documents` (live tldraw records), `tombstones`, `history_events` (each with
`changes_json` — before/after for every record the event touched),
`history_event_fragments` (a 900 ms coalescing buffer) and
`history_checkpoints`, where **each row is a full board snapshot**.

Checkpoints are written explicitly, before a restore (`pre_restore`), once at
legacy import, and automatically every **50 events or 15 minutes** of activity
(`DEFAULT_SNAPSHOT_EVENT_INTERVAL`, `DEFAULT_SNAPSHOT_TIME_INTERVAL` in
`server/history.ts`).

### Measured growth

Production boards today, via `dbstat` (bytes including indexes):

| Board | live | events | checkpoints | history / live |
| --- | --- | --- | --- | --- |
| `api-acceptance` | 8 KB | 8 KB (5) | 4 KB (1) | 1.5x |
| `demo` | 16 KB | 20 KB (58) | 41 KB (4) | 3.8x |
| `server-validation` | 16 KB | 41 KB (31) | 53 KB (8) | 5.9x |

`scripts/measure-history-growth.sh` drives a throwaway instance at a realistic
size (480 shapes):

- ~280 bytes per event for a single-shape human edit
- ~19 KB per event for a 30-shape batch, because `changes_json` holds before
  and after for every record touched
- **~219 KB per checkpoint** — a full board copy, so cost is O(board size) and
  is paid again every 50 events or 15 minutes
- history reached **5.3x live state** after six explicit checkpoints

Checkpoints dominate, and they scale with board size rather than with how much
changed. A 1,000-shape board under six hours of editing a day accumulates
roughly 4 checkpoints/hour x ~450 KB, about **11 MB/day or 4 GB/year for one
board**. Today's 640 KB is not the problem; that curve is.

### What restore actually needs

`reconstruct()` picks the newest checkpoint with `base_event_id <= target` and
replays only events in `(base_event_id, target]`. It does **not** need every
event since the board began. Two consequences follow:

1. Dropping a **whole** event range between two retained checkpoints costs only
   the ability to land between them; restoring *to* either still works, because
   a checkpoint carries its own snapshot.
2. Dropping a **partial** range that a retained reconstruction still replays
   does not fail loudly — `applyHistoryEvents` simply replays fewer diffs and
   returns a **silently wrong board**. Compaction must therefore only ever
   operate on closed intervals bounded by retained checkpoints.

### The constraint that makes this a decision

`migrateHistoryDatabase` installs four triggers — `history_events_no_update`,
`history_events_no_delete`, `history_checkpoints_no_update`,
`history_checkpoints_no_delete` — each raising
`ABORT, 'history_events is append-only'`. History is not merely un-deleted, it
is **un-deletable by design**, which is the property an audit trail of human and
AI actions should have. Compaction cannot be added quietly: it requires either
dropping and recreating those triggers in a maintenance window, or a migration
that redefines the invariant.

## Decision

A **tiered retention model**, as an offline maintenance command, and only once
the invariant change is accepted explicitly.

| Age of restore point | Kept |
| --- | --- |
| 0-7 days | every event and checkpoint — full resolution |
| 7-90 days | checkpoints only; whole event ranges between consecutive retained checkpoints dropped. Restore lands on checkpoint boundaries |
| over 90 days | one checkpoint per week, plus every `explicit` and `pre_restore` checkpoint |

Always kept regardless of age: the earliest checkpoint, which is the board's
origin (`ensureLegacyImportCheckpoint` bases it on a synthetic `board.imported`
event rather than leaving `base_event_id` NULL, so "earliest" rather than "NULL
base" is the correct test),
the newest checkpoint, every `explicit` and `pre_restore` checkpoint, and every
event newer than the newest retained checkpoint. A gap is deleted **whole or not at all**, whatever the event types inside it.
An earlier draft exempted account-audit rows, but that is both unnecessary and
unsafe: unnecessary because `account_events` is written to the central
`auth.sqlite` by `AuthService.event()` and the rows in board history are only a
projection of it (`configureRoomAuditReader` → `listBoardEventsSince`), and
compaction never touches `auth.sqlite`; unsafe because a row left behind inside
an otherwise emptied range would then replay an incomplete range and rebuild
into a silently wrong board. Measured on the real boards, the exemption also
made the policy inert: every gap contains `user.joined`/`user.left`, so nothing
was ever eligible.

What a compacted range does lose is the board-local presence and activity trail
— `user.joined`, `user.left`, `ai.requested` — which exists only in board
history. Who was invited, added, removed, or had permissions changed survives in
`auth.sqlite`.

### Mechanics

`scripts/compact-history.ts`, in TypeScript so that verification reconstructs
through the application's own `BoardHistoryStore.reconstruct` rather than a
reimplementation of it.

Two rules do the real work:

1. **Whole gaps only.** Deletion operates on the event range between two
   consecutive *retained* checkpoints, and only when the upper checkpoint is
   already outside the full-resolution window. `reconstruct()` replays
   `(base_of_chosen_checkpoint, target]`, so a partially emptied range rebuilds
   wrongly; an entirely removed one cannot, because every target inside it
   disappears with it and both bounding checkpoints carry their own snapshots.
2. **A checkpoint is only removable if the gap containing it is going too.**
   Removing one from a surviving gap would change which base a surviving target
   reconstructs from, and the rebuilt snapshot would stop matching. Policy
   thinning therefore only bites where the events go as well. This was found by
   the verification step rather than by reasoning.

Around them: a fresh verified backup newer than the database and an explicit
`--service-stopped` are required for `--apply`; the plan is re-checked inside
the transaction against the latest event id and checkpoint count, so a board
that moved under us aborts the pass; `busy_timeout` makes a concurrent writer
wait rather than fail it; `VACUUM` is followed by `wal_checkpoint(TRUNCATE)` so
the reclaimed space is actually visible in the file; and `--dry-run` executes
the whole pass, verification included, then deliberately rolls back.

Verification covers every retained checkpoint, every surviving event in the
historical region, and the newest 100 events. The pass commits only if all of
them rebuild byte-identically.

### The retention gate

Migration `history:0006` replaces the absolute no-delete triggers with ones
that abort unless a `history_retention_gate` row exists. The compactor opens
and closes that row inside the same transaction as its deletes, so a rollback
takes it with it and there is no window in which ordinary application code can
delete history. `UPDATE` remains categorically forbidden.

This is an **accident boundary, not a security boundary**: anything that can
write the database file can also open the gate, or drop the triggers outright.
It stops the application deleting history by mistake, which is what it is for.

## Consequences

- History converges to live state + ~90 days of checkpoints + a weekly series.
- Restoring to an arbitrary moment older than 7 days is lost; restoring to a
  checkpoint boundary is not.
- The append-only invariant weakens from absolute to policy-bounded. That is a
  real reduction in audit strength, and is why this is Proposed, not Accepted.

## Alternatives considered

- **Raise the checkpoint interval.** Slows the curve without bounding it and
  lengthens replay ranges. Worth doing as well, not instead.
- **Differential checkpoints.** Removes the O(board size) cost and keeps
  append-only completely intact — no deletion needed. Strictly better in
  principle, materially more risk, because reconstruction would then depend on
  an unbroken checkpoint chain rather than any single self-contained snapshot.
  This is the right answer if the invariant is judged worth keeping.
- **Do nothing yet.** Defensible at 640 KB. The argument against waiting is
  that compaction is far easier to prove correct on small boards than on the
  4 GB board that would eventually motivate it.

## Production gate

Approved 2026-09-20 for the architecture, not for an immediate destructive run.
Before the first production compaction, all of the following must hold, and the
resulting numbers reported:

1. fresh verified backup of the affected databases (enforced by `--apply`)
2. that backup passes integrity and foreign-key checks (enforced by `verify`)
3. compactor tested against copied databases
4. every retained restore point reconstructs identically before and after
5. current board state reconstructs identically
6. checkpoint restore works
7. editing after restore works
8. tests cover boundary timestamps and retention tiers
9. an interrupted pass cannot leave a partially compacted database
10. a focused DeepSeek review, with findings independently verified

Items 1-10 are satisfied as of 2026-09-20; see
`docs/development/current-state.md` for the measured dry-run results. The
remaining reason not to run it is simpler: on the current boards it would
delete nothing, because all history is inside the full-resolution window.
