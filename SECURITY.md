# Security policy

This project assumes its source code is public and that a reader may have
the entire repository in front of them. Nothing here depends on the
implementation being secret: authorization is enforced server-side on every
request, sessions and invitation tokens are stored only as hashes, and the
security properties this document describes are meant to hold even against
someone who has read every line of `server/*`.

See `docs/security/threat-model.md` for the trust-boundary diagram,
`docs/security/authorization-matrix.md` for what each identity can and
cannot do, and `docs/security/ai-agent-security.md` for how machine/AI
clients are kept separate from human sessions.

## Reporting a vulnerability

**Please do not open a public GitHub issue for a security vulnerability.**
A public issue discloses the problem to every reader, including anyone who
might exploit it, before a fix ships.

Preferred channel: **GitHub private vulnerability reporting**
(Security tab → "Report a vulnerability") once it is enabled on this
repository. That channel is private between the reporter and the repository
owner and supports a normal back-and-forth before anything is disclosed.

If private vulnerability reporting is not yet enabled, or you cannot use it,
open a draft security advisory instead, or contact the maintainer through
whatever channel the repository's profile currently lists — do not use a
public issue, discussion, or pull request for the initial report.

## What to include in a report

- The affected endpoint, WebSocket message, or code path (`file:line` if you
  have it).
- A concrete reproduction: request/response, or a short script. A
  proof-of-concept that demonstrates unauthorized data access or a privilege
  escalation is far more useful than a description of a theoretical concern.
- The board role, identity type (human session vs. machine bearer token),
  and scope involved, if relevant — see the authorization matrix.
- Impact: what an attacker actually gains (read another board's data,
  write without authorization, bypass a role check, exfiltrate a session,
  etc.).
- Anything you already ruled out.

You do not need to propose a fix, though one is welcome.

## Scope

In scope:

- The application server (`server/`), shared validation (`shared/`), and
  client (`client/`) code in this repository.
- Authorization, session, invitation, WebSocket, asset, history/restore, and
  AI bearer-token logic.
- The engineering-entity semantic layer (`shared/entities.ts`,
  `server/canvas-api.ts`'s semantic actions).

Out of scope (report upstream instead, unless the issue is in how *this*
project uses them):

- Vulnerabilities in `tldraw`/`@tldraw/*` itself — report to the tldraw
  project.
- Vulnerabilities in Cloudflare Access, Cloudflare Tunnel, or Tailscale
  themselves — report to Cloudflare or Tailscale.
- Denial-of-service findings that only require overwhelming an
  unauthenticated public endpoint with volume (rate limiting exists for
  authenticated write paths; general network-layer DoS is an operational
  concern for the hosting operator, not an application defect).

Please test only against your own local deployment or an instance you have
explicit permission to test. Do not test against anyone else's production
deployment without their permission.

## Supported versions

This project does not yet maintain multiple released version lines; security
fixes land on `main`. There is no long-term-support branch at this stage.

## Disclosure

Please give a reasonable amount of time to investigate and fix a report
before any public disclosure. There is no bug-bounty program.
