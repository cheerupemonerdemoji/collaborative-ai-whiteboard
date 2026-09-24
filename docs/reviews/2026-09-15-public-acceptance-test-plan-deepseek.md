# DeepSeek review 1 — public acceptance-test plan

- Date: 2026-09-15
- Model: `cloudflare-workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731`
- Mode: read-only, file-limited review
- Baseline: `1add02292979356c68f80656825e75f187221863`

DeepSeek marked tests requiring a second identity as **2-ID** and tests requiring live Cloudflare state as **CF-DASH**.

| Priority | Test | Expected result | Endpoint/component | Security property | Evidence |
|---|---|---|---|---|---|
| P1 | CF-DASH: approved Access email | The allowlisted email authenticates, reaches the origin, then sees the application login | Access → Tunnel → `127.0.0.1:8787` | Deny-by-default outer gate | `docs/deployments/2026-09-15-cloudflare-public-access.md:5-10`; `docs/decisions/004-cloudflare-whiteboard-access.md:19-20` |
| P1 | CF-DASH, 2-ID: unapproved email | Access denial; no origin response | Access application | Non-allowlisted identity blocked before origin | `docs/decisions/004-cloudflare-whiteboard-access.md:19-20` |
| P1 | CF-DASH: Access logout/re-auth | Logout causes a new Access challenge; the application cookie cannot bypass Access | Access plus `canvas_session` | Independent edge and application sessions | `server/security.ts:15-16`; `server/app.ts:330-337` |
| P1 | CF-DASH: Access/application expiration | Expired application session makes `/api/auth/me` and WebSocket fail; expired Access JWT re-challenges | `/api/auth/me`; `/api/connect/:roomId` | Expiry and revocation enforcement | `server/auth.ts:510-512`; `server/rooms.ts:212-225`; `tests/auth.test.ts:118-130` |
| P1 | 2-ID: concurrent public editing | Both users exchange WSS changes and history has correct `user:<id>` attribution | `/api/connect/:roomId`; `useSync` | Authenticated collaboration and attribution | `server/app.ts:466-502`; `server/rooms.ts:186-210`; `tests/collaboration-history.test.ts:53-70` |
| P2 | WebSocket disconnect/reconnect | Disconnect cleans the session; reconnect restores persisted state and records lifecycle events | Room lifecycle and WebSocket | No ghost sessions; persistence | `server/rooms.ts:92-100,152-226` |
| P1 | 2-ID: owner/editor/viewer | Owner manages; editor writes; viewer is server-side read-only; nonmember is hidden | Board APIs and WebSocket | RBAC and IDOR resistance | `server/app.ts:105-107,518-537,625-643`; `tests/server-app.test.ts:271-298` |
| P1 | 2-ID: invitations | One-use scoped invitation grants the selected role; invalid, reused, expired, revoked, or wrong-login token fails | `/api/invitations`; `/api/invitations/consume` | Hashed, scoped, expiring one-use grants | `server/auth.ts:664-712,803-828`; `tests/server-app.test.ts:238-298` |
| P2 | History | Attributed events list/filter correctly and remain append-only | History and snapshot endpoints | Authorized, immutable audit trail | `server/app.ts:565-611`; `server/history.ts:77-93`; `tests/history.test.ts:66-78` |
| P2 | Checkpoints | Explicit checkpoint is listed; viewer cannot create one | Checkpoint endpoints | Write authorization and append-only snapshot | `server/app.ts:613-643`; `server/rooms.ts:236-255` |
| P1 | Restore | Fresh clock restores after checkpointing the live head; stale clock returns 409; history remains | Restore endpoint | Restore authorization and optimistic concurrency | `server/app.ts:387-408`; `server/rooms.ts:261-300`; `tests/collaboration-history.test.ts:72-88` |
| P2 | Uploads | Writer uploads; member reads; viewer cannot upload; anonymous/nonmember cannot read; traversal rejected | Board upload/asset endpoints | Board-scoped asset authorization | `server/app.ts:645-675`; `server/auth-db.ts:629-640`; `tests/server-app.test.ts:400-416` |
| P2 | External AI | Room and permission scopes are enforced; metadata is sanitized; AI mutations are validated and broadcast | Canvas action and AI event endpoints | Least-privilege machine identity | `server/tokens.ts:15-28`; `server/app.ts:196-209,518-563`; `tests/canvas-api.test.ts:57-74` |
| P2 | Browser account session | Login sets `HttpOnly; SameSite=Strict`; current-user works; logout revokes and clears; failures rate-limit | Auth endpoints and client auth provider | Cookie-only server session and throttling | `server/security.ts:15-21`; `server/app.ts:317-337`; `tests/server-app.test.ts:160-189` |

DeepSeek's coverage note: the repository had no automated evidence for Access logout/re-authentication, Access JWT expiry, or true two-browser concurrent editing. Those must be verified live. Tests needing two real identities are concurrent editing, the complete role matrix, invitations, and explicit unapproved-email denial.
