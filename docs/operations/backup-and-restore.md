# Backup, restore, and disaster recovery

Answers three questions: what persistent state exists, how it is protected, and
how to bring it back on a machine that no longer has any of it.

## What is persistent state

| Path | Holds | Lost if not backed up |
| --- | --- | --- |
| `~/.local/share/collaborative-ai-canvas/auth.sqlite` | accounts, password hashes, sessions, boards, memberships, invitations, board→asset ownership, account audit events | every account and every authorization relationship |
| `~/.local/share/collaborative-ai-canvas/rooms/<board>.sqlite` | one board each: tldraw records, plus that board's history events, fragments and checkpoints | all canvas content and all history |
| `~/.local/share/collaborative-ai-canvas/assets/` | uploaded images and files | uploaded assets (board references survive and dangle) |
| `~/.config/collaborative-ai-canvas/api-tokens.json` | SHA-256 hashes of machine/AI tokens with their board scopes and permissions | machine clients stop being recognised |
| `~/.config/collaborative-ai-canvas/environment` | service configuration (allowed origins, registration flag) | service comes back misconfigured |
| `<repo>/.env.production.local` | the tldraw licence key used at build time | the client cannot be rebuilt without requesting a new key |

Everything else — code, systemd units, the deployment records — is in Git.

**Not backed up on purpose:** the Cloudflare Tunnel credential
(`~/.config/cloudflared/*.token`). It is a live credential for a remotely
managed tunnel and is reissued from the Cloudflare Zero Trust dashboard in less
time than restoring it safely would take.

## How backups are taken

`scripts/backup-canvas-data.py` — standard library Python only, so it still runs
on a rebuilt machine before `corepack pnpm install` has been run there.

Databases are copied with the **SQLite online backup API**, not `cp`. A plain
copy of a WAL-mode database that the live service is writing can capture a torn
set of pages or miss committed transactions still sitting in the `-wal`. The
backup API takes a read transaction and copies a consistent page image. Sources
are opened read-only so a backup can never checkpoint or recover the live
database out from under the service.

Each generation is a single `canvas-backup-<UTC>.tar.gz`, mode 0600, containing
`databases/`, `assets/`, `config/` and a `manifest.json` recording sizes,
SHA-256 digests, row counts, the repository commit, and the integrity results.

### Verification

A file existing is not a backup. Every generation is checked at creation, and
can be rechecked at any time:

```
python3 scripts/backup-canvas-data.py verify <archive>
```

For each database: `PRAGMA integrity_check` must return `ok`, `PRAGMA
foreign_key_check` must return nothing, and the file's digest must match the
manifest. A failure writes a `FAILED-<timestamp>.txt` marker, keeps the archive
for inspection, and exits non-zero so the systemd unit records a failure.

### Schedule and retention

`canvas-backup.timer` (user unit) runs daily at 03:30 with a randomised delay
and `Persistent=true`, so a day the machine was off is caught up rather than
silently skipped.

Retention keeps the newest generation per period: **14 daily, 8 weekly, 6
monthly**, and never discards the most recent archive. At the current data size
(~640 KB of databases, ~27 KB compressed per generation) the whole retained set
is well under a megabyte; the policy is set by how far back you might want to
reach, not by disk pressure. Revisit it if board history growth changes the
archive size materially.

### Where copies live

| Copy | Location | Protects against |
| --- | --- | --- |
| primary | `~/backups/collaborative-ai-canvas` on your-server | accidental deletion, bad migration |
| mirror | `/mnt/data/backups/collaborative-ai-canvas` (second physical disk, `sdb1`) | loss of the system disk |
| off-box | `%USERPROFILE%\Backups\collaborative-ai-canvas` on `the operator's designated Tailscale exit node` | loss of the server |

The off-box copy is **pulled** by the desktop
(`%USERPROFILE%\Scripts\pull-canvas-backups.ps1`, scheduled task
`CanvasBackupPull`, daily 04:15). The direction is deliberate: the desktop is
already trusted to SSH into the server, so the pull grants nothing new. Putting
a server key onto the desktop would instead widen what a server compromise
reaches. Each pulled file is checked against the server's `.sha256` sidecar and
deleted rather than kept if it does not match.

The scheduled task is registered "interactive only", so it runs when the operator is
logged in on that desktop — the same condition the Cloudflare Tunnel already
depends on.

**Open decision:** all three copies are in one building. A genuinely off-site
destination (object storage, or a machine elsewhere) is still worth choosing.
The tooling does not care where the archive goes, so this is a destination
decision, not an implementation one.

## Restoring

### Drill it, don't trust it

```
scripts/dr-drill.sh [archive] [port]
```

Restores the newest archive into a temporary directory, starts a second
instance on port 8799 against it, and checks 18 assertions: anonymous requests
are refused, an existing board's canvas loads out of the restored room
database, a scoped machine token can read but not write, a new account can be
created, a board can be made, canvas writes are accepted and read back, history
and checkpoints record, an authenticated WebSocket is accepted and an anonymous
one is refused with 1008 — and production is untouched throughout. It cleans up
after itself. Run it after any change to the backup path.

### Real recovery on a fresh machine

1. Install prerequisites: Node 22, Git, Python 3, `corepack`.
2. `git clone` the repository to `~/apps/collaborative-ai-canvas`.
   The bare origin also lives on the server (`~/repos/...`), so keep a clone
   elsewhere or push to a remote you will still have.
3. Copy the newest archive from the off-box location and verify it **before
   trusting it**:
   ```
   python3 scripts/backup-canvas-data.py verify <archive>
   ```
4. Restore data and configuration:
   ```
   python3 scripts/backup-canvas-data.py restore <archive> \
     --target ~/.local/share/collaborative-ai-canvas \
     --config-target ~/.config/collaborative-ai-canvas
   ```
   Restore refuses a non-empty target without `--force`, and refuses any
   database whose digest or integrity check fails. Databases are written
   without `-wal`/`-shm` siblings because each archived file is already a
   checkpointed, self-contained image.
5. Move `config/env.production.local` back to `<repo>/.env.production.local`
   (the restore writes it into the config target under that flattened name).
6. `corepack pnpm install && corepack pnpm run build`.
7. Install the units and start:
   ```
   install -m 0644 deploy/collaborative-ai-canvas.service ~/.config/systemd/user/
   install -m 0644 deploy/canvas-backup.service ~/.config/systemd/user/
   install -m 0644 deploy/canvas-backup.timer   ~/.config/systemd/user/
   loginctl enable-linger $USER
   systemctl --user daemon-reload
   systemctl --user enable --now collaborative-ai-canvas canvas-backup.timer
   ```
8. Reissue the Cloudflare Tunnel token in the Zero Trust dashboard, write it to
   `~/.config/cloudflared/<name>.token`, install
   `deploy/cloudflared-whiteboard.service` plus the `--protocol http2` drop-in,
   and start it.
9. Verify: `curl http://127.0.0.1:8787/api/health`, sign in, open a board,
   confirm the canvas and its history are present.

### Verifying a restore without a second machine

`scripts/dr-drill.sh` is exactly this procedure against a throwaway directory
and port. Prefer it over restoring onto the live data directory.

## What a restore does not bring back

- Cloudflare Tunnel credentials and the tunnel's ingress configuration (both
  live in Cloudflare; the ingress is recorded in
  `docs/deployments/2026-09-20-tunnel-routing-correction.md`).
- Cloudflare Access policies.
- Tailscale device authorization — the rebuilt machine joins as a new node.
- The tldraw licence if `.env.production.local` was excluded with `--no-config`.
