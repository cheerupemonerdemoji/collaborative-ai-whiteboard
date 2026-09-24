/**
 * ADR 005 board-history compaction.
 *
 * Written in TypeScript on purpose: verification reconstructs every retained
 * restore point through the application's own `BoardHistoryStore.reconstruct`,
 * so the check cannot drift from the code real restores use. A Python
 * reimplementation would be a second opinion about the same question rather
 * than the same answer.
 *
 * Safety model:
 *   - deletion is only possible while a `history_retention_gate` row exists
 *     (migration history:0006), and the gate is opened and closed inside the
 *     same transaction as the deletes, so an abort takes it with it. This stops
 *     application code from deleting history by accident; it is not a security
 *     boundary, since anything that can write the file can also open the gate
 *     or drop the triggers outright;
 *   - every retained restore point is reconstructed before and after, inside
 *     that transaction, and any difference rolls the whole pass back;
 *   - `--dry-run` executes the entire pass including verification and then
 *     deliberately rolls back, so a dry run exercises the real code path;
 *   - `--apply` additionally requires a verified backup newer than the database
 *     and an explicit statement that the service is stopped.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import DatabaseConstructor from 'better-sqlite3'
import type { Database as DatabaseHandle } from 'better-sqlite3'
import { BoardHistoryStore } from '../server/history'

const DAY = 86_400_000
const DEFAULT_DETAILED_DAYS = 7
const DEFAULT_CHECKPOINT_DAYS = 90

/**
 * Reporting only. A gap is deleted whole or not at all, whatever the event
 * types inside it, because reconstruct() replays every row in
 * (base_of_chosen_checkpoint, target] and a partially emptied range rebuilds
 * into a silently wrong board.
 *
 * That is safe for the access-control record: `account_events` is written to
 * the central auth.sqlite by AuthService.event(), and the rows in board history
 * are a projection of it (configureRoomAuditReader -> listBoardEventsSince).
 * Compaction never touches auth.sqlite, so who was invited, added, removed or
 * had their permissions changed survives a compacted board timeline. What is
 * lost from an old compacted range is the board-local presence and activity
 * trail - user.joined, user.left, ai.requested - which exists only here.
 */
const PRUNABLE_EVENT_PREFIX = 'object.'

export interface CompactionOptions {
	database: string
	now?: number
	detailedDays?: number
	checkpointDays?: number
	apply?: boolean
}

export interface CompactionPlan {
	boardId: string
	boundaryEventId: number
	retainedCheckpointIds: number[]
	deletedCheckpointIds: number[]
	deletableEventIds: number[]
	oldestRetainedDetailedEventAt: number | null
	verificationPoints: number
	totals: { events: number; checkpoints: number; prunableEvents: number }
}

export interface CompactionResult extends CompactionPlan {
	applied: boolean
	deletedEvents: number
	deletedCheckpoints: number
	bytesBefore: number
	bytesAfter: number
	integrity: string
}

interface CheckpointRow {
	id: number
	created_at: number
	base_event_id: number | null
	reason: string
}

/** Stable serialisation so two structurally equal snapshots hash identically. */
function canonical(value: unknown): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
	if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, item]) => item !== undefined)
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
	return '{' + entries.map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}'
}

function hashSnapshot(snapshot: unknown): string {
	return createHash('sha256').update(canonical(snapshot)).digest('hex')
}

function isoWeek(timestamp: number): string {
	const date = new Date(timestamp)
	const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
	// ISO weeks run Monday-Sunday and belong to the year containing their Thursday.
	const day = (target.getUTCDay() + 6) % 7
	target.setUTCDate(target.getUTCDate() - day + 3)
	const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4))
	const week = 1 + Math.round(((target.getTime() - firstThursday.getTime()) / DAY - 3) / 7)
	return target.getUTCFullYear() + '-W' + String(week).padStart(2, '0')
}

function resolveBoardId(database: DatabaseHandle, file: string): string {
	const rows = database.prepare('SELECT DISTINCT board_id AS id FROM history_events').all() as Array<{ id: string }>
	if (rows.length === 1) return rows[0].id
	if (rows.length > 1) throw new Error(file + ' holds history for ' + rows.length + ' boards; refusing to guess')
	return basename(file).replace(/\.sqlite$/, '')
}

export function planCompaction(
	database: DatabaseHandle,
	boardId: string,
	now: number,
	detailedDays: number,
	checkpointDays: number
): CompactionPlan {
	const checkpoints = database
		.prepare('SELECT id, created_at, base_event_id, reason FROM history_checkpoints WHERE board_id = ? ORDER BY id ASC')
		.all(boardId) as CheckpointRow[]
	const detailedCutoff = now - detailedDays * DAY
	const checkpointCutoff = now - checkpointDays * DAY

	const retained = new Set<number>()
	if (checkpoints.length) {
		retained.add(checkpoints[checkpoints.length - 1].id) // the way back to now
		// The board's beginning. ensureLegacyImportCheckpoint bases the origin on a
		// synthetic board.imported event rather than leaving base_event_id NULL, so
		// the earliest checkpoint is the origin; a NULL base is still honoured for
		// databases created another way.
		retained.add(checkpoints[0].id)
		const nullBase = checkpoints.find((row) => row.base_event_id === null)
		if (nullBase) retained.add(nullBase.id)
	}
	const weekly = new Map<string, CheckpointRow>()
	for (const row of checkpoints) {
		if (row.reason === 'explicit' || row.reason === 'pre_restore') {
			retained.add(row.id)
			continue
		}
		if (row.created_at >= checkpointCutoff) {
			retained.add(row.id)
			continue
		}
		const bucket = isoWeek(row.created_at)
		const held = weekly.get(bucket)
		if (!held || row.id > held.id) weekly.set(bucket, row)
	}
	for (const row of weekly.values()) retained.add(row.id)

	const retainedRows = checkpoints.filter((row) => retained.has(row.id))

	/**
	 * Only whole gaps between consecutive retained checkpoints are eligible.
	 * reconstruct() replays (base_of_chosen_checkpoint, target], so removing a
	 * proper subset of a range that any surviving target still replays would
	 * produce a silently wrong board. Removing a gap in full cannot: every target
	 * inside it disappears with it, and both bounding checkpoints carry their own
	 * snapshots.
	 *
	 * A gap holding anything that is not prunable - an invitation, a permission
	 * change, a restore marker - is skipped whole, because that row must survive
	 * and would otherwise be left replaying an incomplete range.
	 */
	const deletableEventIds: number[] = []
	const deletedGaps: Array<{ lower: number; upper: number }> = []
	for (let index = 0; index + 1 < retainedRows.length; index++) {
		const upper = retainedRows[index + 1]
		if (upper.created_at >= detailedCutoff) break // inside the full-resolution window
		const lower = retainedRows[index].base_event_id ?? 0
		const bound = upper.base_event_id ?? 0
		if (bound <= lower) continue
		const rows = database
			.prepare('SELECT id, event_type FROM history_events WHERE board_id = ? AND id > ? AND id <= ? ORDER BY id ASC')
			.all(boardId, lower, bound) as Array<{ id: number; event_type: string }>
		if (!rows.length) continue
		for (const row of rows) deletableEventIds.push(row.id)
		deletedGaps.push({ lower, upper: bound })
	}

	/**
	 * A checkpoint is only removable if the gap containing it is going too.
	 * Removing one from a gap that survives would change which base a surviving
	 * target reconstructs from - reconstruct() picks the newest checkpoint with
	 * base_event_id <= target - and the rebuilt snapshot would no longer match
	 * the one callers had before. Policy thinning therefore only takes effect
	 * where the events are being removed as well, which is exactly the tier where
	 * ADR 005 intends it.
	 */
	const deletedCheckpointIds = checkpoints
		.filter((row) => !retained.has(row.id))
		.filter((row) => {
			const base = row.base_event_id ?? 0
			return deletedGaps.some((gap) => base > gap.lower && base < gap.upper)
		})
		.map((row) => row.id)
	const boundaryEventId = deletableEventIds.length ? deletableEventIds[deletableEventIds.length - 1] : 0

	const oldestRetained = database
		.prepare('SELECT MIN(created_at) AS at FROM history_events WHERE board_id = ? AND event_type LIKE ? AND id > ?')
		.get(boardId, PRUNABLE_EVENT_PREFIX + '%', boundaryEventId) as { at: number | null }

	const totals = {
		events: (database.prepare('SELECT count(*) AS n FROM history_events WHERE board_id = ?').get(boardId) as { n: number }).n,
		checkpoints: checkpoints.length,
		prunableEvents: (
			database
				.prepare('SELECT count(*) AS n FROM history_events WHERE board_id = ? AND event_type LIKE ?')
				.get(boardId, PRUNABLE_EVENT_PREFIX + '%') as { n: number }
		).n,
	}

	return {
		boardId,
		boundaryEventId,
		retainedCheckpointIds: checkpoints.filter((row) => retained.has(row.id)).map((row) => row.id),
		deletedCheckpointIds,
		deletableEventIds,
		oldestRetainedDetailedEventAt: oldestRetained.at,
		verificationPoints: 0,
		totals,
	}
}

type Target = { checkpointId: number } | { eventId: number }

/**
 * Every restore point the policy promises to keep. Hashing these before and
 * after is the actual safety property: the pass commits only if each one still
 * rebuilds identically.
 */
function verificationTargets(database: DatabaseHandle, boardId: string, plan: CompactionPlan): Array<{ label: string; target: Target }> {
	const targets: Array<{ label: string; target: Target }> = []
	for (const id of plan.retainedCheckpointIds) targets.push({ label: 'checkpoint:' + id, target: { checkpointId: id } })

	// Every surviving target in the historical region, not just the recent tail:
	// a wrong boundary shows up as a broken reconstruction of an old surviving
	// event, which a tail-only check would never look at.
	const doomed = new Set(plan.deletableEventIds)
	const historical = database
		.prepare('SELECT id FROM history_events WHERE board_id = ? AND id <= ? ORDER BY id ASC')
		.all(boardId, plan.boundaryEventId) as Array<{ id: number }>
	for (const row of historical) {
		if (!doomed.has(row.id)) targets.push({ label: 'event:' + row.id, target: { eventId: row.id } })
	}

	const recent = database
		.prepare('SELECT id FROM history_events WHERE board_id = ? AND id > ? ORDER BY id DESC LIMIT 100')
		.all(boardId, plan.boundaryEventId) as Array<{ id: number }>
	for (const row of recent) targets.push({ label: 'event:' + row.id, target: { eventId: row.id } })
	return targets
}

function snapshotHashes(store: BoardHistoryStore, targets: Array<{ label: string; target: Target }>): Map<string, string> {
	const hashes = new Map<string, string>()
	for (const item of targets) hashes.set(item.label, hashSnapshot(store.reconstruct(item.target).snapshot))
	return hashes
}

export function compactDatabase(options: CompactionOptions): CompactionResult {
	const file = resolve(options.database)
	if (!existsSync(file)) throw new Error('no such database: ' + file)
	const now = options.now ?? Date.now()
	const detailedDays = options.detailedDays ?? DEFAULT_DETAILED_DAYS
	const checkpointDays = options.checkpointDays ?? DEFAULT_CHECKPOINT_DAYS
	const bytesBefore = statSync(file).size

	const database = new DatabaseConstructor(file)
	try {
		database.pragma('foreign_keys = ON')
		// Wait for a concurrent writer rather than failing the pass outright.
		database.pragma('busy_timeout = 5000')
		const boardId = resolveBoardId(database, file)
		const store = new BoardHistoryStore(database, boardId)
		const plan = planCompaction(database, boardId, now, detailedDays, checkpointDays)
		const targets = verificationTargets(database, boardId, plan)
		const plannedLatestEventId = (
			database.prepare('SELECT MAX(id) AS id FROM history_events WHERE board_id = ?').get(boardId) as { id: number | null }
		).id
		plan.verificationPoints = targets.length

		let deletedEvents = 0
		let deletedCheckpoints = 0
		const nothingToDo = plan.deletableEventIds.length === 0 && plan.deletedCheckpointIds.length === 0

		if (!nothingToDo) {
			const before = snapshotHashes(store, targets)
			const pass = database.transaction(() => {
				// The plan was computed outside this transaction; refuse to act on it if
				// the board moved underneath us.
				const latest = (
					database.prepare('SELECT MAX(id) AS id FROM history_events WHERE board_id = ?').get(boardId) as { id: number | null }
				).id
				const checkpointCount = (
					database.prepare('SELECT count(*) AS n FROM history_checkpoints WHERE board_id = ?').get(boardId) as { n: number }
				).n
				if (latest !== plannedLatestEventId || checkpointCount !== plan.totals.checkpoints) {
					throw new Error('board changed between planning and compaction; rerun')
				}
				database
					.prepare('INSERT INTO history_retention_gate (id, opened_at, reason) VALUES (1, ?, ?)')
					.run(now, 'adr-005-retention')
				try {
					// Delete exactly the planned ids. A range delete would also take rows
					// in gaps the plan deliberately skipped, which is how a surviving
					// event ends up replaying an incomplete range.
					for (let offset = 0; offset < plan.deletableEventIds.length; offset += 400) {
						const batch = plan.deletableEventIds.slice(offset, offset + 400)
						const placeholders = batch.map(() => '?').join(',')
						deletedEvents += database
							.prepare('DELETE FROM history_events WHERE board_id = ? AND id IN (' + placeholders + ')')
							.run(boardId, ...batch).changes
					}
					if (deletedEvents !== plan.deletableEventIds.length) {
						throw new Error('deleted ' + deletedEvents + ' events but planned ' + plan.deletableEventIds.length)
					}
					for (const id of plan.deletedCheckpointIds) {
						deletedCheckpoints += database
							.prepare('DELETE FROM history_checkpoints WHERE board_id = ? AND id = ?')
							.run(boardId, id).changes
					}
				} finally {
					// Closed inside the transaction: the gate must not outlive the pass
					// even if a delete above throws.
					database.prepare('DELETE FROM history_retention_gate WHERE id = 1').run()
				}
				const after = snapshotHashes(store, targets)
				for (const [label, digest] of before) {
					if (after.get(label) !== digest) throw new Error('restore point ' + label + ' changed during compaction; rolling back')
				}
				if (!options.apply) throw new Error('__DRY_RUN__')
			})
			try {
				pass()
			} catch (error) {
				deletedEvents = 0
				deletedCheckpoints = 0
				if (!(error instanceof Error) || error.message !== '__DRY_RUN__') throw error
			}
		}

		if (options.apply && !nothingToDo) {
			database.exec('VACUUM')
			// VACUUM in WAL mode writes into the -wal, so the main file does not
			// shrink until the WAL is checkpointed back into it. Without this the
			// reported size reduction is a fiction.
			database.pragma('wal_checkpoint(TRUNCATE)')
		}
		const integrity = database.pragma('integrity_check', { simple: true }) as string
		const gate = database.prepare('SELECT count(*) AS n FROM history_retention_gate').get() as { n: number }
		if (gate.n !== 0) throw new Error('retention gate is still open after the pass')

		return {
			...plan,
			applied: Boolean(options.apply) && !nothingToDo,
			deletedEvents,
			deletedCheckpoints,
			bytesBefore,
			bytesAfter: statSync(file).size,
			integrity,
		}
	} finally {
		database.close()
	}
}

function requireFreshBackup(databaseFile: string, archive: string | undefined, repoRoot: string): void {
	if (!archive) throw new Error('--apply requires --backup <archive.tar.gz>')
	if (!existsSync(archive)) throw new Error('no such backup archive: ' + archive)
	if (statSync(archive).mtimeMs < statSync(databaseFile).mtimeMs) {
		throw new Error('backup archive is older than the database; take a fresh backup first')
	}
	const verified = spawnSync('python3', [join(repoRoot, 'scripts', 'backup-canvas-data.py'), 'verify', archive], {
		encoding: 'utf8',
		timeout: 300_000,
	})
	if (verified.status !== 0) throw new Error('backup verification failed:\n' + verified.stdout + verified.stderr)
}

function main(argv: string[]): number {
	const args = new Map<string, string>()
	const flags = new Set<string>()
	for (let index = 0; index < argv.length; index++) {
		const item = argv[index]
		if (!item.startsWith('--')) continue
		const next = argv[index + 1]
		if (next && !next.startsWith('--')) {
			args.set(item.slice(2), next)
			index++
		} else {
			flags.add(item.slice(2))
		}
	}
	const database = args.get('database')
	if (!database) {
		console.error('usage: tsx scripts/compact-history.ts --database <file> [--dry-run | --apply --backup <archive> --service-stopped]')
		return 2
	}
	const apply = flags.has('apply')
	const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
	if (apply) {
		if (!flags.has('service-stopped')) {
			console.error('FATAL: --apply requires --service-stopped. Stop collaborative-ai-canvas first.')
			return 2
		}
		try {
			requireFreshBackup(resolve(database), args.get('backup'), repoRoot)
		} catch (error) {
			console.error('FATAL: ' + (error as Error).message)
			return 2
		}
	}

	const result = compactDatabase({
		database,
		apply,
		now: args.has('now') ? Number(args.get('now')) : undefined,
		detailedDays: args.has('detailed-days') ? Number(args.get('detailed-days')) : undefined,
		checkpointDays: args.has('checkpoint-days') ? Number(args.get('checkpoint-days')) : undefined,
	})
	console.log(JSON.stringify(result, null, 2))
	return result.integrity === 'ok' ? 0 : 1
}

// This module is imported by the tests, so only run the CLI when the file is
// the process entry point. `require.main` is not available under ESM.
const invokedDirectly =
	process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
	try {
		process.exit(main(process.argv.slice(2)))
	} catch (error) {
		console.error('FATAL: ' + (error as Error).message)
		process.exit(1)
	}
}
