# Contributing

## Security issues

**Do not open a public issue for a security vulnerability.** See
`SECURITY.md` for the private reporting process. Everything else in this
file is for ordinary bugs, features, and changes.

## Installation

This project uses `pnpm` through Node's built-in Corepack, not a
standalone `npm` install.

```bash
corepack pnpm install
```

Node 22+ is recommended.

## Local development

```bash
corepack pnpm build
CANVAS_DATA_DIR=./data corepack pnpm start
```

or, for a watch-mode server:

```bash
corepack pnpm dev:selfhost
```

The server binds to `127.0.0.1:8787` by default. First use is at
`http://127.0.0.1:8787/login`, where you create the owner account. See the
README's "Accounts, roles, and first use" section for the invitation model.

Note: a production build additionally requires a tldraw license key
(`VITE_TLDRAW_LICENSE_KEY`) -- see the README's "Local development" section.
It is not needed for `corepack pnpm test` or `corepack pnpm typecheck`.

## Before opening a change

```bash
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
```

All three should be clean. The test suite runs under `vitest`
(`tests/**/*.test.ts`) and does not require any external service, license
key, or network access.

## What a good change looks like

- Keep changes scoped to one concern; prefer several small, reviewable
  commits over one large one.
- New server-side behavior needs a test that would fail if the behavior
  regressed -- not just a test that happens to pass. If you're fixing a bug,
  a regression test that reproduces it first is the most convincing form of
  fix.
- Authorization changes are held to a higher bar: if you touch
  `resolveBoardAccess`, board-role checks, bearer-token scope checks, or
  anything in `server/security.ts`, explain in the PR description exactly
  which identity/operation combination changes and why, and update
  `docs/security/authorization-matrix.md` to match.
- Don't add configuration, feature flags, or abstraction for a case that
  doesn't exist yet. This project has an explicit preference for the
  smallest thing that solves the actual problem -- see `CLAUDE.md`'s
  guidance on the Chibi Robo semantic layer for what "smallest useful
  layer" means in practice here.
- Don't commit secrets, production data, or anything under `data/` --
  `.gitignore` covers the known shapes, but review your own diff before
  pushing regardless.

## Project structure, in brief

- `server/` -- the Fastify application: auth, rooms/sync, canvas API,
  history, tokens.
- `shared/` -- validation schemas shared (in intent, not literally imported)
  between server and client: visual actions (`shared/ai.ts`), semantic
  entities (`shared/entities.ts`), the history event model
  (`shared/history.ts`).
- `client/` -- the React/tldraw frontend.
- `tests/` -- Vitest tests, one file per subsystem.
- `docs/` -- architecture decisions (`docs/decisions/`), deployment records
  (`docs/deployments/`), operational runbooks (`docs/operations/`), review
  records (`docs/reviews/`), and security documentation
  (`docs/security/`).

See `ARCHITECTURE.md` for the fuller system diagram and
`docs/development/current-state.md` for what's currently in progress.

## Reviews

Some changes in this repository's history went through a bounded review
pass from an independent model (DeepSeek, via Cloudflare Workers AI) before
or after implementation -- see `docs/reviews/` for examples and
`.claude/rules/deepseek-reviewers.md` for how that's scoped. This is an
internal workflow detail, not a requirement for external contributions;
ordinary human code review applies to pull requests from outside
contributors.
