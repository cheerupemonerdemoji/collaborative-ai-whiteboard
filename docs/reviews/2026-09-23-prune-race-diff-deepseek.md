# Review: closing a room without a trailing prune race

- Date: 2026-09-23
- Model: `@cf/deepseek-ai/deepseek-v4-flash-0731`, `reasoning_effort=low`,
  `max_findings=8`, `max_completion_tokens=12000`
- Harness: `deploy/desktop/deepseek-review.ps1`
- Evidence: the diff of `server/history-storage.ts`, `server/rooms.ts` and
  `tests/rooms.test.ts`, plus the upstream `pruneTombstones` definition for
  reference
- Scope: one diff-only pass, as the rules require for a change to runtime
  lifecycle code. No architectural review was requested or performed.
- Findings returned: **0**

The reviewer was given the defect, the ownership argument and the rejected
alternatives as settled context, so its budget went to the diff rather than to
re-deriving the problem.

## Verdict

No defects found. Its summary asserted that the ordering in `closeHandle` is
safe, that no residual race remains, that the `try`/`catch` suppresses only the
opportunistic prune, that pruning re-arms after reopen so nothing durable is
lost, that the structural cast no-ops if upstream renames the member, and that
the `uncaughtException` listener is isolated per Vitest worker.

A clean bill is not evidence, so the two load-bearing claims were checked
directly rather than accepted.

## Independently verified

**Worker isolation.** The reviewer's claim that the listener cannot capture
errors from other test files was measured, not assumed: two probe test files
reported process IDs 277621 and 277622. Vitest 5 runs each file in its own
forked process by default and this project configures no `pool`, so a listener
registered in one file's process is invisible to the others.

**Timer inventory.** The reviewer said "the only known timer is the prune
throttle". That is imprecise - there are four timer sources in this path - but
its conclusion survives, because the other three were already handled before
this change:

| Timer | Quiesced by |
| --- | --- |
| idle room close (`rooms.ts`) | `clearIdleTimer` in `closeHandle` |
| session expiry (`rooms.ts`) | the `expiryTimers` loop in `closeHandle` |
| history coalescing debounce (`history.ts`) | `recorder.dispose()` -> `flush()`, which clears and nulls the timer |
| tombstone prune throttle (upstream storage) | **this change** |

`recorder.dispose()` already ran before `database.close()`, so the history
debounce was never exposed to the same race. The prune throttle was the only
unhandled one.

## Disposition

Nothing to fix. The reviewer's one imprecision is recorded above rather than
quietly dropped, so the next reader can see what it actually checked.
