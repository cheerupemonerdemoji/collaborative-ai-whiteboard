# DeepSeek review — engineering_entity concrete design pressure-test

- Date: 2026-09-22
- Model: `@cf/deepseek-ai/deepseek-v4-flash-0731` (reasoning_effort=low, tier=flash)
- Mode: read-only, file-limited review via `deploy/desktop/deepseek-review.ps1`
- Scope: `docs/chibi-robo/whiteboard-integration-plan.md`'s already-incorporated
  conclusions (summarized, not re-litigated), a concrete implementation
  proposal (single `engineering_entity` record type via `createTLSchema`'s
  `records` option), `shared/ai.ts`, `server/canvas-api.ts`,
  `shared/history.ts`, and the schema-setup excerpt of `server/rooms.ts`
- Findings returned: 6 (capped at 10)

This is a deliberately different question from the two 2026-09-15 passes
already in `docs/reviews/2026-09-15-chibi-schema-review-deepseek.md` and
`2026-09-15-chibi-final-diff-deepseek.md`. Those reviewed the *plan document*
conceptually. This one reviews a *concrete implementation proposal* — the
underlying files it was asked about are unchanged since those earlier
passes, but the proposal itself (single record type, `T.union` discriminant,
parallel action-schema union, budget dimensions) did not exist until this
task, so this is new ground, not a repeat.

## Findings and disposition

| # | DeepSeek finding | Severity | Claude verification | Disposition |
|---|---|---|---|---|
| 1 | Deleting an entity leaves dangling incoming relations on other entities, since edges live only on the source record. | high | **Confirmed as a real gap in the proposal as written.** | **Resolved by design, not by cascade-delete code.** V1 has no hard-delete action at all — the plan document already says "keep deletion reversible by marking entities archived before removing metadata." `update_status` transitioning an entity to `archived` is the only removal path in V1; nothing is ever hard-deleted, so a relation's `targetId` is always resolvable (possibly to an archived entity). Reads exclude archived entities by default but relation integrity is never broken. This is simpler than DeepSeek's proposed cascade-scan-and-clean and avoids adding a second write path that touches unrelated records. |
| 2 | A restored/checkpointed board can leave an `engineering_entity.shapeId` pointing at a shape that isn't in that snapshot (shape deleted, or restored to before it existed). | medium | **Confirmed as a real edge case.** | **Accepted, handled defensively rather than actively cleaned.** `shapeId` was always optional/advisory (a visual anchor, not a foreign key the system depends on for correctness). Any code that reads it treats "referenced shape not found" as a normal, always-handled case (anchor lost, entity remains valid) rather than adding restore-path post-processing to null it out. Cheaper and avoids a new hook into the restore/checkpoint-replay path. |
| 3 | A parallel `semanticActionSchema` union next to `canvasActionSchema` doesn't *prove* the 8 visual actions stay unchanged — a future edit could still drift them. | medium | **Confirmed**, and cheap to close. | **Fixed via a regression test**, not a schema-level guarantee. Added a test that pins the exact tool-literal set and shape of `canvasActionSchema` so any accidental change to a visual action schema fails a test, not silently. |
| 4 | `createdBy`/`updatedBy`/`createdAt`/`updatedAt` on every entity duplicate what the history recorder already tracks; extra bookkeeping burden. | medium | **Reviewed against the user's own original spec**, which explicitly lists `createdBy`/`updatedBy` in the entity's minimum base fields. | **Kept, not removed** — explicit requirement, and low-cost to maintain correctly because they're set exclusively server-side in the same code path that already derives `actor` for the history event (no separate bookkeeping step). DeepSeek's concern is noted as an accepted, mitigated risk rather than acted on, since removing an explicitly requested field isn't Claude's call to make unilaterally. |
| 5 | A separate semantic-action rate limiter would be redundant if semantic actions share the existing actions route, since `writeLimiter` already throttles that request stream. | low | **Confirmed.** | **Adopted as proposed.** Semantic actions are validated and applied inside the same `/api/rooms/:roomId/actions` handler and therefore the same `writeLimiter` call; no second limiter was added. |
| 6 | `record_experiment_result`, `attach_evidence`, `update_status` are all just field-level updates on an entity; treating them as distinct action types is unnecessary vocabulary for a "smallest useful layer" V1. | low | **Confirmed as a real simplification opportunity, but the user's task brief explicitly names these three as the intended V1 action set** (not "consider these," a specific enumerated list). | **Kept as distinct action names, but implemented as thin validated wrappers over one shared update path**, not three duplicated server branches. This gets DeepSeek's actual complaint (duplicated server logic) without contradicting an explicit user requirement, and keeps the clearer, more legible history events the user's brief asked for (e.g. "Simulation Agent recorded result: PASS" reads directly from a `record_experiment_result` action; a generic `update_entity` diff would not). |

## Summary

One real correctness gap (#1) closed by a design choice already implied by
the plan document (archive-only removal, never hard-delete) rather than new
code. One edge case (#2) accepted and handled defensively. One coverage gap
(#3) closed with a regression test. Two simplification suggestions (#4, #6)
evaluated against the user's explicit field/action requirements and kept,
with the underlying maintenance-burden concern addressed structurally
(server-only field mutation, shared implementation) rather than by dropping
requested surface area. One redundancy (#5) fully adopted.
