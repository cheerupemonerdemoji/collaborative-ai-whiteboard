# DeepSeek review 2 — diff-only hostile review

- Date: 2026-09-15
- Model: `cloudflare-workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731`
- Baseline: `1add02292979356c68f80656825e75f187221863`
- Scope: baseline-to-HEAD diff and only the files changed during this task
- Limit: 10 findings

## Reviewer output

### Finding 1 — Corepack portability

- **Severity:** Medium
- **File and line:** `package.json:16`
- **Evidence:** The build changed from `npm run build:selfhost` to `corepack pnpm run
  build:selfhost`. The pinned package manager helps, but some Node installations do
  not include or enable Corepack and a cold cache can require registry access.
- **Impact:** A host without Corepack, or an offline host without the pinned pnpm
  version cached, cannot run the normal build command.
- **Proposed fix:** Revert to npm and fix that toolchain, or standardize the lifecycle
  on a pinned Node/Corepack/pnpm toolchain.
- **Confidence:** Medium.

### Finding 2 — package-runner divergence

- **Severity:** Low
- **File and line:** `package.json:16`
- **Evidence:** Invoking pnpm from the script can expose different lifecycle variables
  and executable-resolution behavior than npm.
- **Impact:** A build that relies on npm-specific environment variables or layout
  could behave differently; only the target Corepack host was directly verified.
- **Proposed fix:** Standardize all lifecycle commands and CI on one package runner.
- **Confidence:** Medium.

### Finding 3 — obsolete privileged tunnel service

- **Severity:** Low–Medium
- **File and line:** `README.md:96-101` and
  `docs/deployments/2026-09-15-public-acceptance-results.md:53-57`
- **Evidence:** The root service remains in `activating` while the intended per-user
  service is active; the current SSH account cannot execute the documented sudo fix.
- **Impact:** Retry noise and possible connector contention remain. A root process has
  broader access to credential files.
- **Proposed fix:** Disable the root service at the console, verify only the per-user
  connector is running, and rotate the credential if the old process loaded a current
  token.
- **Confidence:** Medium.

### Finding 4 — ambiguous acceptance label

- **Severity:** Low
- **File and line:** `docs/deployments/2026-09-15-public-acceptance-results.md:14-16,63-67`
- **Evidence:** The approved-email row said `Partial pass / fail` while most public
  tests were blocked and the document said production was not accepted.
- **Impact:** A summary consumer could incorrectly collapse the result to a pass.
- **Proposed fix:** Add an explicit `STATUS: NOT ACCEPTED` marker.
- **Confidence:** High that the document was otherwise honest; medium that a consumer
  would misclassify it.

### Reviewer residual risks

- Live Access logout, Access expiry, explicit denied-email, and two-identity tests
  remain unverified.
- If Error 1033 persists after port 7844 egress is restored, investigate duplicate
  connector contention.
- The reviewer questioned whether the diagnostic service restore was verified.
- A cold Corepack cache introduces package-registry availability into a new host's
  first build.

The reviewer found no application-code security regression; no application code was
changed in this task.

## Codex classification

| Finding | Classification | Disposition |
| --- | --- | --- |
| 1 | **Accepted risk** | The requested target was the existing production host, where Corepack and the pinned pnpm version are installed/cached and the corrected normal build passed. Reverting would restore the confirmed missing-npm failure. A future multi-host CI task should pin the complete toolchain. |
| 2 | **False positive for this diff** | The changed command delegates to the unchanged `build:selfhost`; no npm lifecycle variables were added or identified as inputs. The full build output matched the intended Vite and esbuild stages. |
| 3 | **Confirmed** | Already documented with exact remediation. It cannot be completed through the current SSH account because sudo requires an interactive password. It remains an operational action and production risk. |
| 4 | **Confirmed and fixed** | Added the explicit `STATUS: NOT ACCEPTED` marker requested by the reviewer. |

Residual-risk classification: the unexecuted public tests and possible duplicate
connector contention are **confirmed/accepted pending operations**. The service-restore
concern is **already mitigated**: after the explicit diagnostic, the user service was
restarted, observed active, and both loopback and Tailscale application health checks
passed. Cold-cache registry dependence is the same accepted target-host portability
risk as finding 1.
