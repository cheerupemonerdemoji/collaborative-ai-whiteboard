#!/usr/bin/env python3
"""Consistent, verified backups of Collaborative AI Canvas persistent data.

Standard library only, on purpose: this tool has to keep working on a rebuilt
machine before `corepack pnpm install` has ever run there, so it must not depend
on the application's own node_modules.

Databases are copied with the SQLite online backup API. A plain file copy of a
WAL-mode database that the live service is writing can capture a torn page set
or miss committed transactions still sitting in the -wal; the backup API takes a
read transaction and copies a consistent page image instead.

Subcommands:
  run      create a new backup generation, verify it, apply retention
  verify   re-verify an existing archive against its manifest
  restore  extract an archive into a target directory
  list     list archives with their manifest summary
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
from datetime import datetime, timezone
from pathlib import Path

TOOL_VERSION = "1.4.0"
ARCHIVE_PREFIX = "canvas-backup-"
ARCHIVE_SUFFIX = ".tar.gz"
TS_FORMAT = "%Y%m%dT%H%M%SZ"

HOME = Path.home()
DEFAULT_DATA_DIR = HOME / ".local/share/collaborative-ai-canvas"
DEFAULT_CONFIG_DIR = HOME / ".config/collaborative-ai-canvas"
DEFAULT_BACKUP_DIR = HOME / "backups/collaborative-ai-canvas"
DEFAULT_MIRROR_DIR = Path("/mnt/data/backups/collaborative-ai-canvas")
DEFAULT_REPO_DIR = HOME / "apps/collaborative-ai-canvas"

# Retention: one generation per period, newest wins. The newest archive is
# always kept regardless of which bucket it falls into.
KEEP_DAILY = 14
KEEP_WEEKLY = 8
KEEP_MONTHLY = 6

# Tables whose row counts are recorded as a restore sanity signal.
COUNT_TABLES = (
    "users", "sessions", "boards", "board_members", "invitations",
    "board_assets", "account_events",
    "documents", "objects", "tombstones",
    "history_events", "history_event_fragments", "history_checkpoints",
)


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def open_source(path: Path) -> tuple[sqlite3.Connection, str]:
    """Open a source database without ever writing to it.

    Read-only is preferred so a backup can never checkpoint or recover the
    live database out from under the service. If SQLite refuses read-only
    (it needs the -shm for a WAL database and cannot always create one), fall
    back to a normal connection pinned with query_only.
    """
    try:
        connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=30)
        connection.execute("SELECT count(*) FROM sqlite_master").fetchone()
        return connection, "ro"
    except sqlite3.Error:
        connection = sqlite3.connect(str(path), timeout=30)
        connection.execute("PRAGMA query_only = ON")
        return connection, "query_only"


def table_counts(connection: sqlite3.Connection) -> dict[str, int]:
    present = {
        row[0] for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        )
    }
    counts: dict[str, int] = {}
    for table in COUNT_TABLES:
        if table in present:
            counts[table] = connection.execute(
                f'SELECT count(*) FROM "{table}"'
            ).fetchone()[0]
    return counts


def drop_wal_sidecars(database: Path) -> None:
    """Remove the -wal/-shm siblings SQLite leaves beside a WAL-mode file."""
    for suffix in ("-wal", "-shm"):
        sidecar = database.with_name(database.name + suffix)
        if sidecar.exists():
            sidecar.unlink()


def verify_database(path: Path) -> dict:
    """Integrity-check a *backup* file. A file existing is not a backup."""
    result: dict = {"ok": False}
    try:
        connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=30)
    except sqlite3.Error as error:
        result["error"] = f"open failed: {error}"
        return result
    try:
        integrity = [row[0] for row in connection.execute("PRAGMA integrity_check")]
        foreign_keys = connection.execute("PRAGMA foreign_key_check").fetchall()
        result["integrity_check"] = integrity
        result["foreign_key_violations"] = len(foreign_keys)
        result["counts"] = table_counts(connection)
        result["ok"] = integrity == ["ok"] and not foreign_keys
        if not result["ok"]:
            result["error"] = "integrity_check or foreign_key_check failed"
    except sqlite3.Error as error:
        result["error"] = f"verify failed: {error}"
    finally:
        connection.close()
    return result


def backup_database(source: Path, destination: Path) -> dict:
    """Copy one database with the online backup API, then verify the copy."""
    entry: dict = {
        "source": str(source),
        "source_bytes": source.stat().st_size,
        "wal_bytes": (source.parent / (source.name + "-wal")).stat().st_size
        if (source.parent / (source.name + "-wal")).exists() else 0,
    }
    connection, mode = open_source(source)
    entry["source_open_mode"] = mode
    try:
        entry["source_counts"] = table_counts(connection)
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.exists():
            destination.unlink()
        target = sqlite3.connect(str(destination))
        try:
            # pages=-1 copies the whole database in one step, so the copy is a
            # single consistent image rather than a restartable incremental one.
            connection.backup(target, pages=-1)
            target.execute("VACUUM")
            # The copy inherits the source's WAL journal mode, so checkpoint and
            # then drop the sidecars below: an archived -wal/-shm pair is stale
            # the moment it is written and only invites a confused restore.
            target.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        finally:
            target.close()
    finally:
        connection.close()
    os.chmod(destination, 0o600)
    entry["verify"] = verify_database(destination)
    # verify_database reopens the copy, which recreates the WAL sidecars, so the
    # cleanup has to come after it. Each archived database must be one
    # self-contained file; a stale -wal/-shm pair only invites a confused restore.
    drop_wal_sidecars(destination)
    entry["backup_bytes"] = destination.stat().st_size
    entry["sha256"] = sha256_file(destination)
    # Live writes between the copy and this read are normal, so a difference is
    # recorded but is not a failure.
    entry["counts_match"] = entry["verify"].get("counts") == entry["source_counts"]
    return entry


def git_commit(repo: Path) -> str | None:
    try:
        out = subprocess.run(
            ["git", "-C", str(repo), "rev-parse", "HEAD"],
            capture_output=True, text=True, timeout=15, check=True,
        )
        return out.stdout.strip()
    except Exception:
        return None


def archive_timestamp(path: Path) -> datetime | None:
    name = path.name
    if not name.startswith(ARCHIVE_PREFIX) or not name.endswith(ARCHIVE_SUFFIX):
        return None
    stamp = name[len(ARCHIVE_PREFIX):-len(ARCHIVE_SUFFIX)]
    try:
        return datetime.strptime(stamp, TS_FORMAT).replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def list_archives(directory: Path) -> list[tuple[datetime, Path]]:
    if not directory.is_dir():
        return []
    found = []
    for path in directory.iterdir():
        stamp = archive_timestamp(path)
        if stamp:
            found.append((stamp, path))
    found.sort(key=lambda item: item[0], reverse=True)
    return found


def retention_keep(archives: list[tuple[datetime, Path]]) -> set[Path]:
    """Newest archive per day, per ISO week, and per month, bounded per bucket."""
    keep: set[Path] = set()
    if not archives:
        return keep
    keep.add(archives[0][1])  # never discard the most recent generation
    for key_fn, limit in (
        (lambda d: d.strftime("%Y-%m-%d"), KEEP_DAILY),
        (lambda d: "%s-W%s" % d.isocalendar()[:2], KEEP_WEEKLY),
        (lambda d: d.strftime("%Y-%m"), KEEP_MONTHLY),
    ):
        seen: dict[str, Path] = {}
        for stamp, path in archives:  # newest first
            seen.setdefault(key_fn(stamp), path)
            if len(seen) >= limit:
                break
        keep.update(seen.values())
    return keep


def apply_retention(directory: Path, dry_run: bool = False) -> list[str]:
    archives = list_archives(directory)
    keep = retention_keep(archives)
    removed = []
    for _, path in archives:
        if path in keep:
            continue
        removed.append(path.name)
        if not dry_run:
            path.unlink()
            sidecar = path.with_suffix(path.suffix + ".sha256")
            if sidecar.exists():
                sidecar.unlink()
    return removed


def command_run(args) -> int:
    data_dir = Path(args.data_dir)
    config_dir = Path(args.config_dir)
    backup_dir = Path(args.backup_dir)
    started = utcnow()
    stamp = started.strftime(TS_FORMAT)

    auth_db = Path(os.environ.get("CANVAS_AUTH_DB_FILE", data_dir / "auth.sqlite"))
    rooms_dir = data_dir / "rooms"
    assets_dir = data_dir / "assets"

    if not auth_db.exists():
        print(f"FATAL: auth database not found at {auth_db}", file=sys.stderr)
        return 2

    backup_dir.mkdir(parents=True, exist_ok=True)
    os.chmod(backup_dir, 0o700)

    manifest: dict = {
        "tool_version": TOOL_VERSION,
        "created_at": started.isoformat(),
        "hostname": os.uname().nodename,
        "data_dir": str(data_dir),
        "config_dir": str(config_dir),
        "repo_commit": git_commit(Path(args.repo_dir)),
        "includes_config": not args.no_config,
        "databases": {},
        "assets": {},
        "config": {},
        "failures": [],
    }

    staging = Path(tempfile.mkdtemp(prefix=".staging-", dir=str(backup_dir)))
    os.chmod(staging, 0o700)
    try:
        (staging / "databases").mkdir()
        manifest["databases"]["auth.sqlite"] = backup_database(
            auth_db, staging / "databases" / "auth.sqlite"
        )
        room_files = sorted(rooms_dir.glob("*.sqlite")) if rooms_dir.is_dir() else []
        (staging / "databases" / "rooms").mkdir(parents=True, exist_ok=True)
        for room in room_files:
            manifest["databases"][f"rooms/{room.name}"] = backup_database(
                room, staging / "databases" / "rooms" / room.name
            )

        # Assets are ordinary immutable files; a copy is sufficient.
        asset_count = 0
        asset_bytes = 0
        if assets_dir.is_dir():
            target = staging / "assets"
            target.mkdir()
            for item in assets_dir.iterdir():
                if item.is_file():
                    shutil.copy2(item, target / item.name)
                    asset_count += 1
                    asset_bytes += item.stat().st_size
        manifest["assets"] = {"count": asset_count, "bytes": asset_bytes}

        # Configuration needed to bring a restored instance back to life.
        # api-tokens.json holds SHA-256 token *hashes*, not usable tokens, but
        # environment and .env.production.local can hold sensitive values, so
        # the finished archive is mode 0600.
        if not args.no_config:
            target = staging / "config"
            target.mkdir()
            candidates = [
                (config_dir / "api-tokens.json", "api-tokens.json"),
                (config_dir / "environment", "environment"),
                (Path(args.repo_dir) / ".env.production.local", "env.production.local"),
            ]
            for source, name in candidates:
                if source.is_file():
                    shutil.copy2(source, target / name)
                    os.chmod(target / name, 0o600)
                    manifest["config"][name] = {
                        "bytes": source.stat().st_size,
                        "sha256": sha256_file(source),
                        "source": str(source),
                    }
                else:
                    manifest["config"][name] = {"missing": True, "source": str(source)}

        for name, entry in manifest["databases"].items():
            if not entry["verify"].get("ok"):
                manifest["failures"].append(
                    f"{name}: {entry['verify'].get('error', 'verification failed')}"
                )

        manifest["finished_at"] = utcnow().isoformat()
        (staging / "manifest.json").write_text(json.dumps(manifest, indent=2))

        # Belt and braces: nothing but the intended files goes into the archive.
        for stray in list(staging.rglob("*-wal")) + list(staging.rglob("*-shm")):
            stray.unlink()

        archive = backup_dir / f"{ARCHIVE_PREFIX}{stamp}{ARCHIVE_SUFFIX}"
        with tarfile.open(archive, "w:gz") as tar:
            for item in sorted(staging.iterdir()):
                tar.add(item, arcname=item.name)
        os.chmod(archive, 0o600)
        digest = sha256_file(archive)
        archive.with_suffix(archive.suffix + ".sha256").write_text(
            f"{digest}  {archive.name}\n"
        )
    finally:
        shutil.rmtree(staging, ignore_errors=True)

    if manifest["failures"]:
        failed_marker = backup_dir / f"FAILED-{stamp}.txt"
        failed_marker.write_text("\n".join(manifest["failures"]) + "\n")
        print("BACKUP FAILED VERIFICATION:", file=sys.stderr)
        for failure in manifest["failures"]:
            print(f"  {failure}", file=sys.stderr)
        print(f"archive kept for inspection: {archive}", file=sys.stderr)
        return 1

    print(f"archive:  {archive} ({archive.stat().st_size} bytes)")
    print(f"sha256:   {digest}")
    print(f"databases: {len(manifest['databases'])} backed up and integrity-checked")
    print(f"assets:    {asset_count} file(s), {asset_bytes} bytes")

    mirrors = []
    if args.mirror_dir:
        mirror_dir = Path(args.mirror_dir)
        try:
            mirror_dir.mkdir(parents=True, exist_ok=True)
            os.chmod(mirror_dir, 0o700)
            shutil.copy2(archive, mirror_dir / archive.name)
            shutil.copy2(
                archive.with_suffix(archive.suffix + ".sha256"),
                mirror_dir / (archive.name + ".sha256"),
            )
            if sha256_file(mirror_dir / archive.name) != digest:
                print("FATAL: mirror copy digest mismatch", file=sys.stderr)
                return 1
            mirrors.append(str(mirror_dir))
            removed_mirror = apply_retention(mirror_dir)
            if removed_mirror:
                print(f"mirror retention removed: {', '.join(removed_mirror)}")
        except OSError as error:
            # A missing second disk must not fail the primary backup.
            print(f"WARNING: mirror to {mirror_dir} failed: {error}", file=sys.stderr)

    removed = apply_retention(backup_dir)
    if removed:
        print(f"retention removed: {', '.join(removed)}")
    kept = len(list_archives(backup_dir))
    print(f"generations kept: {kept} in {backup_dir}" + (f"; mirrored to {', '.join(mirrors)}" if mirrors else ""))
    return 0


def _extract_archive(archive: Path, destination: Path) -> None:
    with tarfile.open(archive, "r:gz") as tar:
        for member in tar.getmembers():
            target = (destination / member.name).resolve()
            if not str(target).startswith(str(destination.resolve())):
                raise ValueError(f"unsafe path in archive: {member.name}")
        tar.extractall(destination)


def command_verify(args) -> int:
    archive = Path(args.archive)
    if not archive.is_file():
        print(f"FATAL: no such archive: {archive}", file=sys.stderr)
        return 2
    sidecar = archive.with_suffix(archive.suffix + ".sha256")
    if sidecar.is_file():
        expected = sidecar.read_text().split()[0]
        actual = sha256_file(archive)
        print(f"archive sha256 {'OK' if expected == actual else 'MISMATCH'}")
        if expected != actual:
            return 1

    problems = []
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        _extract_archive(archive, root)
        manifest = json.loads((root / "manifest.json").read_text())
        print(f"created_at: {manifest['created_at']}  commit: {manifest.get('repo_commit')}")
        for name, entry in manifest["databases"].items():
            path = root / "databases" / name
            if not path.is_file():
                problems.append(f"{name}: missing from archive")
                continue
            if sha256_file(path) != entry["sha256"]:
                problems.append(f"{name}: sha256 mismatch")
                continue
            check = verify_database(path)
            status = "OK" if check["ok"] else f"FAILED ({check.get('error')})"
            counts = check.get("counts", {})
            summary = ", ".join(f"{k}={v}" for k, v in sorted(counts.items()) if v)
            print(f"  {name}: {status}  {summary}")
            if not check["ok"]:
                problems.append(f"{name}: {check.get('error')}")
        assets = manifest.get("assets", {})
        print(f"  assets: {assets.get('count', 0)} file(s)")
        for name, entry in manifest.get("config", {}).items():
            if entry.get("missing"):
                print(f"  config/{name}: absent at backup time")
            else:
                path = root / "config" / name
                ok = path.is_file() and sha256_file(path) == entry["sha256"]
                print(f"  config/{name}: {'OK' if ok else 'MISMATCH'}")
                if not ok:
                    problems.append(f"config/{name}: mismatch")

    if problems:
        print("VERIFY FAILED:", file=sys.stderr)
        for problem in problems:
            print(f"  {problem}", file=sys.stderr)
        return 1
    print("verify: OK")
    return 0


def target_is_in_use(target: Path) -> str | None:
    """Best-effort check that nothing is holding the databases we would replace."""
    candidates = [target / "auth.sqlite"]
    rooms = target / "rooms"
    if rooms.is_dir():
        candidates.extend(sorted(rooms.glob("*.sqlite")))
    for candidate in candidates:
        if not candidate.exists():
            continue
        try:
            connection = sqlite3.connect(str(candidate), timeout=0.2)
            try:
                connection.execute("BEGIN EXCLUSIVE")
                connection.execute("ROLLBACK")
            finally:
                connection.close()
        except sqlite3.Error:
            return str(candidate)
    return None


def command_restore(args) -> int:
    archive = Path(args.archive)
    target = Path(args.target)
    if not archive.is_file():
        print(f"FATAL: no such archive: {archive}", file=sys.stderr)
        return 2

    # The sidecar covers the whole archive; the manifest only covers the files
    # inside it. Restoring without this check trusts a manifest that a corrupted
    # or edited archive carries along with it.
    sidecar = archive.with_suffix(archive.suffix + ".sha256")
    if sidecar.is_file():
        expected = sidecar.read_text().split()[0]
        if sha256_file(archive) != expected:
            print(f"FATAL: {archive.name} does not match its .sha256 sidecar", file=sys.stderr)
            return 1
    elif not args.allow_unverified:
        print(
            f"FATAL: no .sha256 sidecar beside {archive.name}. "
            "Re-run with --allow-unverified only if you know why it is missing.",
            file=sys.stderr,
        )
        return 2

    if target.exists() and any(target.iterdir()):
        if not args.force:
            print(
                f"FATAL: {target} is not empty. Refusing to overwrite without --force.",
                file=sys.stderr,
            )
            return 2
        # --force onto a directory that already looks like a data directory means
        # overwriting databases a running service may have open. Replacing files
        # under live file handles corrupts that service's view of them.
        if (target / "auth.sqlite").exists() and not args.service_stopped:
            print(
                f"FATAL: {target} already contains auth.sqlite. Stop the service and "
                "pass --service-stopped to confirm nothing is using it.",
                file=sys.stderr,
            )
            return 2
        busy = target_is_in_use(target)
        if busy:
            print(f"FATAL: {busy} is locked by another process. Stop the service first.", file=sys.stderr)
            return 2
    target.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        _extract_archive(archive, root)
        manifest = json.loads((root / "manifest.json").read_text())

        # Databases are restored without their -wal/-shm siblings on purpose:
        # the backup image is already a fully checkpointed, self-contained file.
        (target / "rooms").mkdir(parents=True, exist_ok=True)
        restored = []
        for name, entry in manifest["databases"].items():
            source = root / "databases" / name
            if sha256_file(source) != entry["sha256"]:
                print(f"FATAL: {name} digest mismatch; refusing to restore", file=sys.stderr)
                return 1
            check = verify_database(source)
            if not check["ok"]:
                print(f"FATAL: {name} failed integrity check; refusing to restore", file=sys.stderr)
                return 1
            destination = target / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            for stale in (
                destination.with_name(destination.name + "-wal"),
                destination.with_name(destination.name + "-shm"),
            ):
                if stale.exists():
                    stale.unlink()
            shutil.copy2(source, destination)
            os.chmod(destination, 0o600)
            restored.append(name)

        assets_target = target / "assets"
        assets_target.mkdir(parents=True, exist_ok=True)
        asset_source = root / "assets"
        asset_count = 0
        if asset_source.is_dir():
            for item in asset_source.iterdir():
                if item.is_file():
                    shutil.copy2(item, assets_target / item.name)
                    asset_count += 1

        config_written = []
        config_source = root / "config"
        if config_source.is_dir() and args.config_target:
            config_target = Path(args.config_target)
            config_target.mkdir(parents=True, exist_ok=True)
            os.chmod(config_target, 0o700)
            for item in config_source.iterdir():
                name = "env.production.local" if item.name == "env.production.local" else item.name
                shutil.copy2(item, config_target / name)
                os.chmod(config_target / name, 0o600)
                config_written.append(name)

    print(f"restored databases: {', '.join(restored)}")
    print(f"restored assets:    {asset_count} file(s) into {target / 'assets'}")
    if config_written:
        print(f"restored config:    {', '.join(config_written)} into {args.config_target}")
    else:
        print("restored config:    skipped (pass --config-target to restore it)")
    print(f"data directory ready: {target}")
    return 0


def command_list(args) -> int:
    for directory in [Path(args.backup_dir)] + ([Path(args.mirror_dir)] if args.mirror_dir else []):
        archives = list_archives(directory)
        print(f"{directory}: {len(archives)} generation(s)")
        for stamp, path in archives:
            print(f"  {stamp.strftime('%Y-%m-%d %H:%M:%SZ')}  {path.name}  {path.stat().st_size} bytes")
    return 0


def main() -> int:
    # The path options live on each subcommand rather than the top level so that
    # the natural `backup-canvas-data.py run --data-dir X` works; argparse only
    # accepts top-level options *before* the subcommand name.
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--data-dir", default=str(DEFAULT_DATA_DIR))
    common.add_argument("--config-dir", default=str(DEFAULT_CONFIG_DIR))
    common.add_argument("--backup-dir", default=str(DEFAULT_BACKUP_DIR))
    common.add_argument("--repo-dir", default=str(DEFAULT_REPO_DIR))
    common.add_argument("--mirror-dir", default=str(DEFAULT_MIRROR_DIR))
    common.add_argument("--no-mirror", action="store_true")

    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)

    run = sub.add_parser("run", parents=[common],
                         help="create, verify and prune a backup generation")
    run.add_argument("--no-config", action="store_true",
                     help="exclude api-tokens.json, environment and the tldraw key")
    run.set_defaults(func=command_run)

    verify = sub.add_parser("verify", parents=[common], help="re-verify an archive")
    verify.add_argument("archive")
    verify.set_defaults(func=command_verify)

    restore = sub.add_parser("restore", parents=[common],
                             help="extract an archive into a data directory")
    restore.add_argument("archive")
    restore.add_argument("--target", required=True)
    restore.add_argument("--config-target", default=None)
    restore.add_argument("--force", action="store_true")
    restore.add_argument("--service-stopped", action="store_true",
                         help="confirm no service is using the target data directory")
    restore.add_argument("--allow-unverified", action="store_true",
                         help="restore an archive that has no .sha256 sidecar")
    restore.set_defaults(func=command_restore)

    listing = sub.add_parser("list", parents=[common], help="list archives")
    listing.set_defaults(func=command_list)

    args = parser.parse_args()
    if args.no_mirror:
        args.mirror_dir = None
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
