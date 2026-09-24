# Review: tldraw licence safeguard

- Date: 2026-09-21
- Model: `@cf/deepseek-ai/deepseek-v4-flash-0731`, `reasoning_effort=low`,
  `max_findings=10`, `max_completion_tokens=12000`
- Harness: `deploy/desktop/deepseek-review.ps1` (read-only single completion,
  `response_format: json_schema`; raw reasoning is consumed for control flow and
  never persisted)
- Evidence: `scripts/license-preflight.ts`, `tests/license-preflight.test.ts`,
  the `package.json` diff, and the licence guard in `client/pages/Room.tsx`
- Findings returned: 4. Confirmed on independent verification: 3. Accepted as a
  design decision rather than a defect, then adopted anyway: 1.

The first attempt failed loudly with `EMPTY final answer (finish_reason=length)`
at 4000 completion tokens - the harness refusing to emit a truncated review
rather than pretending it had one. Re-run at 12000.

## 1. `readConfiguredKey` skipped `.env.production` ? CONFIRMED, fixed

The preflight read `['.env.production.local', '.env.local', '.env']`. Vite reads
a fourth file, `.env.production`, and ranks it **above** `.env.local`.

Verified directly rather than from documentation, by building the ladder one
file at a time and asking Vite itself:

```
.env only                  -> from-env
+ .env.local               -> from-env-local
+ .env.production          -> from-env-production
+ .env.production.local    -> from-env-production-local
```

and separately that a real environment variable beats all four. So Vite's order,
highest first, is `.env.production.local` > `.env.production` > `.env.local` >
`.env`, with `process.env` above them.

Severity is real in both directions: with a key in `.env.production`, the
preflight would have vetted a *different* key from the one Vite inlines - either
blocking a good build or passing an expired one. Not currently exploitable on
this deployment, which has only `.env.production.local`, but latent.

Fixed: the list now matches Vite's, with the measurement recorded in a comment,
and two tests cover the full ladder and the specific masking case.

## 2. `build:cloudflare` bypassed the guard entirely ? CONFIRMED, fixed

`"build:cloudflare": "tsc && vite build"` inlines the key with no check. The
Cloudflare worker path is in-tree but not deployed, so this was not a live hole;
it was a hole waiting for the day that path is used.

Fixed: `build:cloudflare` now runs `license:check:production` first. A test
enumerates every script containing `vite build` and asserts each one runs the
check before it, so adding an unguarded build script fails the suite.

`license:verify-build` was deliberately **not** added to `build:cloudflare`: it
writes to a different output directory that can also hold self-host assets, and
the resulting `CONFLICT` would be a false positive.

## 3. `build:selfhost` never ran `license:verify-build` ? design decision, adopted

Reported as a defect. It was a deliberate choice: verifying a bundle against the
key it was just built from is close to tautological, and the check was intended
for post-deploy use.

Adopted anyway, because the reasoning survives contact with finding 1: an
independent read-back of the *built* bundle is exactly what catches the case
where the preflight and Vite disagree about which file holds the key. It also
catches Vite silently not inlining at all.

Fixed: `build:selfhost` now ends with `license:verify-build`. The failure is
loud and non-destructive - it does not restart or replace the running service.

## 4. Test gaps for the above ? CONFIRMED, fixed

Covered by the tests added for findings 1-3. Each was mutation-checked: reverting
the env precedence fails 2 tests, unguarding `build:cloudflare` fails 1, and
dropping `license:verify-build` from `build:selfhost` fails 1.

## Explicitly cleared

The reviewer found **no** secret-disclosure path (Q1) and **no** date or
timezone defect (Q2). Both were independently mutation-tested: leaking the key
into an `UNKNOWN` detail string fails the secret test, and an off-by-one in the
expiry boundary fails 18 tests.

## Reviewer error rate

4 findings, 3 genuine defects, 1 design decision that was worth adopting on its
merits. No hallucinated findings. Consistent with previous runs: this harness is
useful for catching things the author's own assumptions hide, and its findings
still need verifying one at a time.
