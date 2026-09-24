# Third-party notices

This file exists to make one thing unambiguous: **this project's own
original code and the tldraw SDK it depends on are under different
licenses, from different rights holders, and this repository does not
grant any rights to the SDK beyond what tldraw Inc. itself grants.**

## This project's license

Everything in this repository that is original to this project --
`server/`, `shared/`, the application-specific parts of `client/`,
`scripts/`, `docs/`, and this repository's own configuration and
tooling -- is licensed under the **Apache License, Version 2.0**. See
`LICENSE`.

That license does not extend to the third-party dependencies listed below.
Each dependency remains under its own license regardless of the license
this repository's own code uses.

## The tldraw SDK is not open source and is not covered by this repository's Apache-2.0 license

This project depends on the tldraw SDK (the `tldraw` npm package and its
`@tldraw/*` sub-packages) to render the collaborative canvas and to
synchronize it over WebSocket. **The tldraw SDK is tldraw Inc.'s own
proprietary, source-available software, not open source, and this
repository does not relicense it, redistribute its source, or grant any
license to it.** Installing this project's dependencies (`pnpm install`)
downloads the SDK from the npm registry under tldraw Inc.'s own terms, the
same as installing it directly from tldraw would.

Verified directly from the installed packages (`node_modules/<package>/package.json`
and `node_modules/<package>/LICENSE.md`), not assumed:

| Package | License (as declared by the package itself) |
| --- | --- |
| `tldraw` | tldraw Inc.'s own license -- see the package's `LICENSE.md`, which points to <https://github.com/tldraw/tldraw/blob/main/LICENSE.md> |
| `@tldraw/editor` | same tldraw license |
| `@tldraw/sync` | same tldraw license |
| `@tldraw/sync-core` | same tldraw license |
| `@tldraw/driver` | same tldraw license |
| `@tldraw/tlschema` | MIT |
| `@tldraw/store` | MIT |
| `@tldraw/state` | MIT |
| `@tldraw/state-react` | MIT |
| `@tldraw/utils` | MIT |
| `@tldraw/validate` | MIT |

**Read this table carefully: not all tldraw packages carry the same
license.** Some lower-level packages (`@tldraw/tlschema`, `@tldraw/store`,
`@tldraw/state`, `@tldraw/state-react`, `@tldraw/utils`, `@tldraw/validate`)
are MIT-licensed and behave like ordinary open-source dependencies. The
packages that actually render and synchronize the canvas -- `tldraw`
itself, `@tldraw/editor`, `@tldraw/sync`, `@tldraw/sync-core`, and
`@tldraw/driver` -- are under **tldraw Inc.'s own custom license**, which
`pnpm licenses list` correctly reports as `Unknown` (it is not a standard
OSI-approved identifier). This project's server directly imports
`@tldraw/sync-core` and `@tldraw/utils`; the client directly imports
`tldraw`.

Based on tldraw's own public documentation of that license (which governs;
this summary does not): it is **source-available**, meaning the source is
visible and can be studied and modified, but it is **not permissively
open-source** in the sense that MIT or Apache-2.0 are. Production/commercial
use is expected to require a valid tldraw license (a free tier exists for
qualifying use, and paid tiers exist beyond that). Do not treat "you can
read the source" as "you can deploy it commercially for free" -- check
tldraw's own current terms at the URL above before any production use.

**This is exactly why this repository already has license-key tooling**
(`scripts/license-preflight.ts`, `docs/operations/tldraw-license.md`,
`VITE_TLDRAW_LICENSE_KEY`): a production build of *this* project requires
its own valid tldraw SDK license key, obtained directly from tldraw, the
same as any other project built on the tldraw SDK. **This repository does
not include, distribute, or grant any tldraw production license** -- the
license key referenced in `.env.production.local` (gitignored, never
committed) belongs to this project's own operator, obtained directly from
tldraw Inc., and is not something this repository can transfer to anyone
who clones it. Anyone deploying this project to production needs to obtain
their own key from tldraw.

## MIT-licensed tldraw packages: required notice

The MIT-licensed tldraw packages above require this notice to be preserved
wherever the software is used. Reproduced verbatim, as required:

```
MIT License

Copyright (c) 2024 tldraw Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

This is the same notice that previously, incorrectly, stood alone as this
entire repository's `LICENSE.md` -- it is accurate for the MIT-licensed
tldraw packages it actually belongs to, and is preserved here for that
reason, not removed. It was never an accurate license for this project's
own original code or for tldraw's separately-licensed SDK packages, which
is why it has been replaced at the repository root by `LICENSE` (Apache-2.0)
plus this file.

## Other third-party dependencies

This project's remaining dependencies (Fastify and its plugins, React,
Radix UI, zod, better-sqlite3, ws, Vite, esbuild, TypeScript, Vitest,
Wrangler, and others) were audited with `pnpm licenses list` on
2026-09-22. All of them are permissive (MIT, ISC, BSD-2/3-Clause,
Apache-2.0, 0BSD, BlueOak-1.0.0, CC0-1.0, or dual-licensed combinations of
those). The only non-permissive license found is `MPL-2.0`
(`lightningcss`, a **development-only** build dependency of Vite -- it is
not bundled into the shipped application and is never distributed by this
project). No GPL, AGPL, or other strong-copyleft dependency was found.
Re-run `pnpm licenses list` after any dependency change to keep this
current; this file is a point-in-time audit, not a guarantee about future
dependency versions.
