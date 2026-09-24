# DeepSeek pass 1 — public acceptance planner

- Date: 2026-09-15
- Model: `cloudflare-workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731`
- Baseline: `2575e7bb6c945e28a28f67696d9345ceb0d6d76f`
- Scope: only the explicitly listed authentication, session, WebSocket, membership,
  invitation, asset, history, restore, AI API, tests, and Cloudflare deployment files

DeepSeek used **Public** for live Cloudflare-path tests and **Local** for supporting
integration coverage. Codex corrected the reviewer's stale statement that port 7844
was still blocked: the tunnel recovery appendix is authoritative.

| Pri | Test | Setup/action | Expected result | Security property | Evidence | Confidence |
| --- | --- | --- | --- | --- | --- | --- |
| P0 | Public approved identity | Browse and authenticate with allowlisted identity | Access passes and application login loads | Default-deny edge gate | ADR 004; public `/login` | Low before retest |
| P0 | Public unapproved identity | Use a second non-allowlisted identity | Denied before origin | Access allowlist | ADR 004 | Low |
| P1 | Access logout/re-auth/expiry | Log out or expire a short Access session | New Access challenge; app cookie cannot bypass edge | Independent edge session | ADR 004 | Low |
| P0 | Application login/logout | Valid and invalid credentials; logout then reuse cookie | Valid login works; bad password is generic; logout revokes | Credential and session security | `server/app.ts`, `server/auth.ts` | High automated |
| P1 | Session persistence/expiry/revocation | Reuse, expire, and revoke application session | Persistence until expiry; then HTTP/WS denial | Absolute expiry and live revocation | `server/auth.ts`, `server/rooms.ts` | High automated |
| P0 | Two-user collaboration | Owner and editor push bidirectional/simultaneous edits | Both converge; attribution remains per actor/session | Multiwriter integrity | `server/rooms.ts`; collaboration tests | Medium |
| P1 | Reconnect/reload/restart | Drop socket, reload, restart services | Persisted state returns and history continues | Recovery durability | `server/rooms.ts`, `server/history.ts` | Mixed |
| P0 | Owner/editor/viewer/nonmember | Exercise HTTP and socket writes | Owner/editor write; viewer socket is server-read-only; nonmember hidden | RBAC and IDOR resistance | `server/app.ts`, `server/rooms.ts` | High automated |
| P0 | Invitations | Valid, expired, reused, revoked, wrong-login and owner-role attempts | Only one valid scoped use; correct role; no owner escalation | Scoped one-use grants | `server/auth.ts`; auth/server tests | Mixed |
| P0 | History attribution | Human, token, and system events | Correct actor/source; append-only listing and filters | Audit provenance | `server/history.ts`, history tests | High automated |
| P0 | Checkpoint/history view | Explicit checkpoint, filtering, event snapshot | Authorized immutable snapshots reconstruct correctly | History integrity | history endpoints/tests | High automated |
| P0 | Restore | Fresh/stale clock; inspect prior history; reconnect | Pre-restore head checkpointed, new head created, old history intact, stale returns 409 | Reversible optimistic restore | `server/rooms.ts`; collaboration tests | High automated |
| P0 | Assets | Member/nonmember/removed member; old route; traversal | Scoped access only; removed user loses access; old route 404 | Asset authorization and containment | `server/app.ts`, `server/auth-db.ts` | Mixed |
| P0 | AI token scopes | Read/write/history/restore, invalid and wrong-room tokens | Least privilege; invalid denied; no cookie downgrade | Machine authorization | `server/tokens.ts`, `server/app.ts` | High automated |
| P1 | AI realtime/attribution | Token writes while user connected | Live broadcast and token attribution | Shared state provenance | rooms/canvas API/history | Low live |
| P0 | AI event sanitization | Send prompt/unbounded metadata | Prompt removed; allowlist and size limit enforced | Secret minimization | `server/app.ts`; canvas API tests | High automated |

DeepSeek's detailed planner also called for login rate limiting, secure-cookie/HSTS
verification, automatic expiry of live sockets, member-removal socket closure,
append-only database triggers, upload traversal/duplicate checks, and restore
authorization. Codex retained those as supporting security checks rather than claiming
they satisfy the requested live public tests.
