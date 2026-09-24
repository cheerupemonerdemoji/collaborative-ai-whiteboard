# DeepSeek pass 2 — final diff-scoped security review

- Date: 2026-09-15
- Model: `cloudflare-workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731`
- Baseline: `2575e7bb6c945e28a28f67696d9345ceb0d6d76f`
- Scope: only `git diff 2575e7b...HEAD` and files changed during this task
- Runtime-code changes reviewed: none

## Raw reviewer findings

### F1 — Single-point-of-failure exit node; recovery untested

- **Severity:** Medium (availability-critical)
- **File:line:** `docs/deployments/2026-09-15-public-acceptance-results.md:75,88,121`
- **Evidence:** Public recovery depends on `the operator's designated Tailscale exit node`; server reboot and
  exit-node-loss recovery were not tested.
- **Impact:** Public service can fail when the desktop, Tailscale session, or desktop
  upstream is unavailable.
- **Proposed change:** Add redundant egress, failover testing, and monitoring.
- **Confidence:** High
- **Reviewer classification:** Confirmed fact.

### F2 — PASS rows may obscure the acceptance gap

- **Severity:** Medium
- **File:line:** `docs/deployments/2026-09-15-public-acceptance-results.md:92,104-112`
- **Evidence:** Public path tests passed while multiuser, RBAC, invitations, expiry,
  assets, history/restore, and external AI remain untested publicly.
- **Impact:** A summary consumer could mistake reachability for production acceptance.
- **Proposed change:** Enforce a hard no-go and retain `NOT ACCEPTED` everywhere.
- **Confidence:** High
- **Reviewer classification:** Confirmed fact.

### F3 — Semantic writes lack explicit amplification budgets

- **Severity:** Medium
- **File:line:** `docs/chibi-robo/whiteboard-integration-plan.md:46,53-54,100-104,143`
- **Evidence:** Read limits were explicit; write size, entity-count, and rate budgets
  were not.
- **Impact:** Large semantic writes could amplify persistence and realtime broadcast.
- **Proposed change:** Add per-entity, per-board, per-batch, and per-actor/token limits.
- **Confidence:** Medium-high
- **Reviewer classification:** Likely issue.

### F4 — Open relation/tag vocabulary contradicts closed schemas

- **Severity:** Low
- **File:line:** `docs/chibi-robo/whiteboard-integration-plan.md:45-52`
- **Evidence:** The illustrative base used string relation types and unbounded tags.
- **Impact:** An implementation copied literally could permit ad-hoc schemas.
- **Proposed change:** Use a closed relation enum and bounded validated tags.
- **Confidence:** High
- **Reviewer classification:** Suggestion.

### F5 — Semantic ID grammar unspecified

- **Severity:** Low
- **File:line:** `docs/chibi-robo/whiteboard-integration-plan.md:53`
- **Evidence:** The `entity:` namespace lacked length and character constraints.
- **Impact:** Collision, query encoding, or unbounded index risks.
- **Proposed change:** Specify and validate a bounded ID grammar.
- **Confidence:** Medium
- **Reviewer classification:** Suggestion.

### F6 — Evidence URL server behavior unspecified

- **Severity:** Low
- **File:line:** `docs/chibi-robo/whiteboard-integration-plan.md:55-56`
- **Evidence:** HTTPS references were allowed without saying whether the server fetches
  them.
- **Impact:** Future server-side fetching could create SSRF exposure.
- **Proposed change:** State that the server never dereferences evidence URLs.
- **Confidence:** Medium
- **Reviewer classification:** Suggestion.

### F7 — Semantic storage mechanism ambiguous

- **Severity:** Low
- **File:line:** `docs/chibi-robo/whiteboard-integration-plan.md:19,143`
- **Evidence:** The draft offered namespaced records or shape metadata while allowing
  nonvisual evidence.
- **Impact:** Shape lifecycle could diverge from semantic restore lifecycle.
- **Proposed change:** Choose one storage mechanism and define anchor deletion behavior.
- **Confidence:** Medium
- **Reviewer classification:** Uncertainty.

### F8 — Canonical Corepack build portability

- **Severity:** Low
- **File:line:** `README.md:26-31,47-49`
- **Evidence:** A first Corepack run can require registry access; the reviewer could not
  inspect `package.json` because it was outside the changed-file scope.
- **Impact:** A new offline host without cached pnpm could fail to build.
- **Proposed change:** Verify package-manager pin and lockfile; document offline
  preparation and clean install guidance.
- **Confidence:** Medium
- **Reviewer classification:** Uncertainty.

The reviewer reported no high-severity finding and no application-code regression.

## Codex classification and disposition

| Finding | Codex classification | Disposition |
| --- | --- | --- |
| F1 | **Accepted risk / needs more testing** | Confirmed and prominently documented. No deliberate exit-node outage or reboot was performed because recovery may require physical intervention. Redundant egress is the correct operational follow-up. |
| F2 | **Confirmed** | Added an explicit `RELEASE GATE: BLOCKED` statement next to the follow-up results. |
| F3 | **Confirmed** | Added per-entity, per-board, per-batch, and per-token/session write budgets to the plan. |
| F4 | **Confirmed** | Changed the plan to a closed relation enum and bounded normalized tags. |
| F5 | **Confirmed** | Defined the `entity:` ID grammar and maximum length. |
| F6 | **Confirmed** | Explicitly prohibited server-side evidence URL fetching, preview, and checksum operations. |
| F7 | **Confirmed** | Selected dedicated namespaced tldraw records and defined non-silent anchor deletion behavior. |
| F8 | **Already mitigated / partly false positive** | `package.json` pins `pnpm@10.15.1`, `pnpm-lock.yaml` exists, README already requires pre-provisioning/caching before offline deployment, and the canonical build passed on production. |
