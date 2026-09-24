# tldraw licence: how it is wired, and how to rotate it

The canvas runs on tldraw under a licence key. This is the operator page for
that key: where it lives, what happens as it approaches its date, how to put a
new one in, and how to prove the new one is actually being served.

**Never paste the key into chat, a commit, a log, an issue or this file.** The
tooling here is built so that you never have to: everything reports the expiry
*date* and never the key.

## 1. Where the key lives

| Where | What it is |
| --- | --- |
| `.env.production.local` (repo root, git-ignored) | `VITE_TLDRAW_LICENSE_KEY=...` - the source of truth on this deployment |
| `dist/client/assets/index-*.js` | the key, **inlined verbatim at build time** |
| `client/pages/Room.tsx` | reads `import.meta.env.VITE_TLDRAW_LICENSE_KEY`, passes it to `<Tldraw licenseKey=... />` |

The middle row is the one that catches people out. Vite substitutes
`import.meta.env.VITE_*` at build time, so the key is baked into the JavaScript
that browsers download. **Editing the env file changes nothing until you
rebuild.** There is no server-side licence check and no runtime reload.

Vite reads several env files, and the preflight deliberately reads them in the
same order, highest priority first:

```
VITE_TLDRAW_LICENSE_KEY in the real environment   (beats everything)
.env.production.local                             <- where this deployment keeps it
.env.production
.env.local
.env
```

That ordering was measured against `vite.loadEnv('production', ...)`, not
assumed, and a test asserts it. Reading a different file from the one Vite
inlines would mean vetting one key while shipping another - which can both
block a good build and pass an expired one.

## 2. What the tooling can and cannot tell you

tldraw 5.4.1 exposes no supported API for asking about licence state. The whole
area - `LicenseManager`, `LicenseState`, `LicenseInfo`,
`InvalidLicenseReason`, `useMaybeLicenseManager` - is marked "Excluded from
this release type" in the published type definitions. The only public surface
is the `licenseKey` prop.

So there are two different things, and they must not be confused:

- **Real validation** happens in tldraw, in the browser, against the signed
  payload inside the key. Nothing in this repository reproduces it.
- **Best-effort operator metadata** is what `scripts/license-preflight.ts`
  reads: the human-readable `tldraw-YYYY-MM-DD` prefix on the issued key. That
  is a *label*. It is good enough to stop an accidental deployment and to drive
  a warning countdown; it is not proof of anything.

Every report says which of the two it is speaking about.

Deliberately not relied upon: tldraw currently allows an undocumented grace
period after expiry. Its length is an internal constant that can change without
notice, so the tooling treats the printed date as the deadline and never counts
on a single day past it.

## 3. Statuses

| Status | Meaning | Production build |
| --- | --- | --- |
| `MISSING` | no key configured | **blocked** |
| `VALID` | more than 30 days left | proceeds |
| `EXPIRING_SOON` | 30 / 14 / 7 / 1 days left | proceeds, warns (tightest threshold reported) |
| `EXPIRED` | past the labelled date | **blocked**, overridable |
| `UNKNOWN` | a key is present but its label cannot be read | proceeds, warns |

`UNKNOWN` never blocks. A key whose label this tooling cannot parse may be
perfectly valid, and refusing to deploy over it would be a self-inflicted
outage.

A licence is treated as good *through* the whole of its expiry date and lapses
at the first instant of the following day, **UTC**. The build machine local
timezone never decides whether a deployment is blocked.

## 4. Commands

```sh
pnpm run license:check              # report on the configured key (never blocks)
pnpm run license:check:production   # the same check in blocking mode
pnpm run license:verify-build       # inspect what dist/client actually serves
```

Both build paths are guarded:

- `build:selfhost` runs `license:check:production` **before** Vite and
  `license:verify-build` **after** it, so the build both refuses a bad key and
  proves the good one actually reached the bundle.
- `build:cloudflare` runs `license:check:production` before Vite. (It does not
  run the verify step, because it writes to a different output directory that
  can hold assets from the self-host build.)

A test asserts that every script containing `vite build` runs the check first,
so adding an unguarded build script fails the suite rather than quietly
reopening the hole.

**Emergency override.** If a build must go out with an expired licence:

```sh
TLDRAW_LICENSE_ALLOW_EXPIRED=1 pnpm run build:selfhost
```

It prints `OVERRIDDEN` rather than passing quietly. Use it to recover from an
outage, not to postpone a rotation.

## 5. Rotating the key

Do this **before** the date in the warning, not after.

1. **Obtain the replacement** from tldraw (hobby, trial or commercial, matching
   the deployment). This is a human step; nothing here can do it.

2. **Note the new expiry date** from the key prefix. You will check against it
   at step 7 without ever having to look at the key again.

3. **Put it in `.env.production.local`**, replacing the old line:

   ```sh
   cd /home/app/collaborative-ai-canvas
   cp .env.production.local .env.production.local.bak.$(date +%Y%m%d)
   chmod 600 .env.production.local.bak.*
   ${EDITOR:-nano} .env.production.local     # edit VITE_TLDRAW_LICENSE_KEY in place
   ```

   Edit it in an editor. Do not echo it, do not pass it on a command line, and
   do not put it in shell history. The backup copy is git-ignored by the
   existing `.env.*` rule; confirm with `git status --short` that it does not
   appear as untracked.

4. **Confirm what is now configured** - this prints the date only:

   ```sh
   corepack pnpm run license:check
   ```

   Expect `status: VALID` and the new date. If the date is not what you expect,
   stop: the wrong value went into the file, or it went into a file that Vite
   ranks lower than another one present.

5. **Rebuild.** The key only reaches browsers through a build.

   ```sh
   corepack pnpm run build:selfhost
   ```

   The preflight runs first and the build-verification runs last, so a failure
   at either end stops the rotation before it reaches the service.

6. **Restart the service** so the new assets are served:

   ```sh
   systemctl --user restart collaborative-ai-canvas
   systemctl --user is-active collaborative-ai-canvas
   curl -fsS http://127.0.0.1:8787/api/health
   ```

7. **Prove the new key is actually being served:**

   ```sh
   corepack pnpm run license:verify-build
   ```

   This reads the expiry date back out of the built JavaScript and compares it
   with the configured key. It fails with `STALE BUILD` if the env file was
   updated but the rebuild was skipped - the commonest way a rotation silently
   does nothing.

8. **Check the browser.** Open a board and look at the console. tldraw does the
   real validation there; a rejected key complains, and the watermark appears.
   None of the tooling above can see this.

9. **Clean up** the backup copy once you are satisfied:

   ```sh
   shred -u .env.production.local.bak.*     # or rm, if shred is unavailable
   ```

## 6. Rolling back

The old build is the fallback. If the new key is rejected in the browser:

- restore the env file from `.env.production.local.bak.<date>`, rebuild,
  restart; or
- if the old key has not yet lapsed, that is the whole fix.

If the old key *has* lapsed and the new one does not work, the honest position
is a licence problem with tldraw, not a deployment problem. The canvas keeps
working with a watermark rather than going dark, so there is no emergency
justification for shipping something unverified.

## 7. If the key goes missing entirely

`client/pages/Room.tsx` blocks the canvas in a production build when no key is
configured at all, and shows a "Whiteboard license required" page instead of a
silently unlicensed canvas. The build guard should mean you never see it.

Note the asymmetry, which is deliberate: a *missing* key blocks, an *expired*
key does not block at runtime. Expiry is something tldraw itself handles
gracefully, and turning it into an outage of our own making would be worse than
the watermark.

## 8. Secret handling rules

- The key never appears in Git. `.gitignore` covers `.env` and `.env.*`; keep
  it that way, and keep any backup copy under that same pattern.
- The key never appears in a log, a report, a commit message, a document or a
  chat message. Every tool here prints dates and statuses only, and there are
  tests asserting exactly that, including that a key cannot reach an error
  string or a serialised verdict.
- The env file and any backup copy stay `chmod 600`.
- Rotating the key does not require rotating anything else. It is not an
  authentication credential and it grants no access to this deployment.
