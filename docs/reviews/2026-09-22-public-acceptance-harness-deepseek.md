# DeepSeek review — public-acceptance harness vs. server behavior

- Date: 2026-09-22
- Model: `@cf/deepseek-ai/deepseek-v4-flash-0731` (reasoning_effort=low, tier=flash)
- Mode: read-only, file-limited review via `deploy/desktop/deepseek-review.ps1`
- Baseline: `8320b54` (working tree, pre-fix)
- Scope: `scripts/public-acceptance.mjs`, `server/app.ts`, `server/rooms.ts`,
  `server/auth.ts`, `server/security.ts`, `server/tokens.ts` — nothing else
- Question asked: (1) does each harness assertion match the implemented server
  behavior, (2) does the harness have gaps against the CLAUDE.md security
  invariants, (3) could any check produce a false PASS
- Findings returned: 7 (capped at 10)

First attempt at `-ReasoningEffort medium` returned `EMPTY final answer
(finish_reason=length)` — the documented failure mode where the budget went
entirely to reasoning. Re-ran at `-ReasoningEffort low` with
`-MaxCompletionTokens 16000`, which produced all 7 findings.

## Findings and Claude's disposition

| # | DeepSeek finding | Severity | Claude verification | Disposition |
|---|---|---|---|---|
| 1 | No harness check exercises AI bearer token scopes (`server/tokens.ts` `authorizeApiToken`, `server/app.ts` `bearerPermissions`); I5 only tests a fake/random token, not a real scoped one. A read-only token could in principle be granted write and the harness would still pass. | critical | **Confirmed as a coverage gap.** Read `server/tokens.ts:15-29` and `server/app.ts:239-256,567-570,589-592`: `access.permissions.has('write')` really does gate every write route for token callers, so the mechanism exists and is scoped correctly in code — the gap is that nothing in the public harness proves it, because production `api-tokens.json` currently has zero clients (per `docs/development/current-state.md`). | **Accepted gap, deferred.** Closing it requires minting a real scoped token on the production host via `scripts/manage-api-tokens.mjs`, which is a distinct, more privileged operational action than the four disposable app accounts authorized for this run. Not done without separate sign-off. Recorded as `NOT TESTED` in the final report, not folded into RBAC results. |
| 2 | Invitation expiry is never really exercised: `D6` mints a 60s invitation, the server rejects it outright because it's below `MIN_INVITATION_TTL_MS` (300000ms), so the check always ends in `blocked`, not a proof that an initially-valid invitation stops working once its clock runs out. | high | **Confirmed, and the harness code was additionally self-contradictory** — the old `D6` had a dead `record('SKIP', ...)` line after an unconditional early `return blocked(...)`, so the SKIP message ("too long to wait out") never matched what actually happened (an outright mint rejection). Verified `MIN_INVITATION_TTL_MS = 5 * 60_000` at `server/auth.ts:20`. | **Fixed.** `D6` now only asserts the TTL floor is enforced at mint time. New `D6b` mints at the minimum allowed TTL (5m3s) and actually waits, then asserts consumption fails past real expiry — closing the gap instead of just describing it. |
| 3 | `D2` expects `400` for a `role: 'owner'` invitation; the real schema (`createInvitationSchema`, `role: z.enum(['editor','viewer']).optional()`) fails Zod parsing and the global error handler (`server/app.ts:728-734`) returns `422`. The check would FAIL even though the server correctly refuses owner invitations. | medium | **Confirmed exactly.** Read `server/app.ts:104-106,484,728-734` — `ZodError` → `reply.code(422)`. This is a real status mismatch, not a server defect. | **Fixed.** `D2` now accepts `400` or `422`. |
| 4 | "viewer role must remain server-enforced read-only" is only proven over HTTP (`F5`); no check sends a raw `push` message over a viewer's WebSocket to prove `isReadonly` is actually enforced at the socket layer. | medium | **Confirmed as a coverage gap, not a known defect.** `server/rooms.ts:207-208` passes `isReadonly: input.role === 'viewer'` into `@tldraw/sync-core`'s `TLSocketRoom.handleSocketConnect`, and `tests/collaboration-history.test.ts` already has local coverage that exercises viewer/readonly session behavior against that same library call. The gap is specifically "not proven over the public path," not "not proven at all." | **Accepted, not added.** Low incremental value given existing local coverage of the identical code path; adding a raw-protocol WS push from the harness would require hand-rolling the sync-core wire format, which is disproportionate for this pass. Recorded as a known limitation in the final report. |
| 5 | "history and restore must enforce authorization" has no check for a logged-in non-member attempting `POST /restore`. | medium | **Confirmed as a missing check**, cheap to close — `server/app.ts:430-458` already funnels the eventId/expectedClock path through `resolveBoardAccess` + `userRoleHasWrite`, which should deny a non-member, but nothing exercised it. | **Fixed.** Added `E15`: outsider `POST /restore` expects 403/404. |
| 6 | `F3` can false-PASS: it awaits *any* message on the editor's socket (`received > 0`) without checking it's the pushed shape, so a heartbeat or presence update would satisfy the assertion even if the edit itself never arrived. | medium | **Confirmed by direct inspection** of `waitForMessage` — it only counts inbound array length, never inspects content. | **Fixed.** Added `waitForMessageContaining(handle, substring, timeoutMs)`; `F3` now waits specifically for a message containing the written shape's id. |
| 7 | "authorization must never trust a client-supplied user ID" has no dedicated check. | low | **Reviewed, no exploitable surface found.** Grepped every `userId` occurrence in `server/app.ts`: identity is always derived from `session.user.id` (`server/app.ts:268`); the one client-supplied `userId` (`query.userId` at line 619) is a same-board history *filter*, not an authorization input — it can't grant access to data the caller couldn't already reach. The member-role-management path (`PUT /members/:userId`) is already exercised by `E7`/`E8` for exactly this kind of parameter-substitution concern. | **No action.** No corresponding endpoint to meaningfully test against; the closest real attack surface is already covered by `E7`/`E8`. |

## Summary

- 3 confirmed bugs in the harness itself, all fixed: `D2` (wrong expected
  status), `D6` (dead code path that never tested what it claimed to),
  `F3` (assertion too weak to prove delivery).
- 1 cheap coverage gap closed: `E15` (non-member restore).
- 1 coverage gap accepted and deferred pending a decision on provisioning a
  production machine token: AI bearer-token scope enforcement (#1).
- 1 coverage gap accepted as-is given existing local test coverage of the
  same code path: raw-socket viewer write enforcement (#4).
- 1 finding reviewed and closed with no harness change: client-supplied
  `userId` trust (#7) — no exploitable surface exists in the current routes.

No application-code defect was found. All findings were about the harness's
own assertions, not about a security regression in `server/*`.
