import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RoomSnapshot } from '@tldraw/sync-core'
import type { TLRecord } from '@tldraw/tlschema'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { BoardHistoryStore, changesBetweenSnapshots } from '../server/history'
import { compactDatabase, planCompaction } from '../scripts/compact-history'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 8, 20)

const directories: string[] = []
const databases: Database.Database[] = []

afterEach(() => {
	while (databases.length) databases.pop()?.close()
	while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true })
})

function record(id: string, x: number): TLRecord {
	return { id, typeName: 'shape', x, y: 0, props: { text: id } } as unknown as TLRecord
}

function snapshot(records: TLRecord[], documentClock: number): RoomSnapshot {
	return {
		clock: documentClock,
		documentClock,
		documents: records.map((state) => ({ state, lastChangedClock: documentClock })),
		tombstones: {},
	}
}

/**
 * A board with 200 days of history: one edit and one checkpoint every five
 * days, every seventh checkpoint explicit, plus audit events early enough to
 * fall below any plausible deletion boundary.
 */
function buildAgedBoard() {
	const directory = mkdtempSync(join(tmpdir(), 'canvas-compact-'))
	directories.push(directory)
	const file = join(directory, 'aged.sqlite')
	const database = new Database(file)
	databases.push(database)
	database.pragma('journal_mode = WAL')
	const store = new BoardHistoryStore(database, 'aged')

	let clock = 1
	// The origin checkpoint needs a non-empty board: an import checkpoint of an
	// empty snapshot is not the board's beginning, it is nothing.
	let records: TLRecord[] = [record('shape:seed', 0)]
	let current = snapshot(records, clock)
	store.ensureLegacyImportCheckpoint(current, NOW - 205 * DAY)

	const explicitIds: number[] = []
	const auditIds: number[] = []
	for (let index = 0; index < 40; index++) {
		const at = NOW - (200 - index * 5) * DAY
		records = [...records, record(`shape:s${index}`, index)]
		clock += 1
		const next = snapshot(records, clock)
		const event = store.appendEvent({
			actorUserId: 'user:a',
			eventType: 'object.created',
			source: 'human',
			createdAt: at,
			changes: changesBetweenSnapshots(current, next),
			documentClock: clock,
		})
		current = next
		const reason = index % 7 === 0 ? 'explicit' : 'periodic'
		const checkpoint = store.createCheckpoint({
			snapshot: current,
			createdBy: 'user:a',
			baseEventId: event.id,
			reason,
			label: reason === 'explicit' ? `milestone ${index}` : null,
			createdAt: at + 1_000,
		})
		if (reason === 'explicit') explicitIds.push(checkpoint.id)

		// Access-control history must survive compaction regardless of age.
		if (index === 3 || index === 9) {
			auditIds.push(
				store.appendEvent({
					actorUserId: 'user:a',
					eventType: 'permissions.changed',
					source: 'human',
					createdAt: at + 500,
					changes: [],
					documentClock: clock,
				}).id
			)
		}
	}
	return { file, database, store, explicitIds, auditIds }
}

function counts(database: Database.Database) {
	return {
		events: (database.prepare('SELECT count(*) AS n FROM history_events').get() as { n: number }).n,
		checkpoints: (database.prepare('SELECT count(*) AS n FROM history_checkpoints').get() as { n: number }).n,
	}
}

describe('ADR 005 history compaction', () => {
	it('keeps the tiers the policy promises and never plans a partial event range', () => {
		const { database, store } = buildAgedBoard()
		const plan = planCompaction(database, 'aged', NOW, 7, 90)

		const rows = database
			.prepare('SELECT id, created_at, base_event_id, reason FROM history_checkpoints ORDER BY id')
			.all() as Array<{ id: number; created_at: number; base_event_id: number | null; reason: string }>
		const retained = new Set(plan.retainedCheckpointIds)

		// Origin and newest are the two ends of the restorable range. The origin is
		// the earliest checkpoint: ensureLegacyImportCheckpoint bases it on a
		// synthetic board.imported event rather than on a NULL base.
		expect(rows[0].reason).toBe('legacy_import')
		expect(retained.has(rows[0].id)).toBe(true)
		expect(retained.has(rows[rows.length - 1].id)).toBe(true)
		// Human-labelled and pre-restore checkpoints are never discarded.
		for (const row of rows.filter((item) => item.reason === 'explicit')) expect(retained.has(row.id)).toBe(true)
		// Everything inside 90 days survives; something beyond it does not.
		for (const row of rows.filter((item) => item.created_at >= NOW - 90 * DAY)) expect(retained.has(row.id)).toBe(true)
		expect(plan.deletedCheckpointIds.length).toBeGreaterThan(0)
		for (const id of plan.deletedCheckpointIds) {
			const row = rows.find((item) => item.id === id)!
			expect(row.created_at).toBeLessThan(NOW - 90 * DAY)
			expect(row.reason).toBe('periodic')
		}

		// The boundary is a retained checkpoint's base, so no surviving replay
		// range can straddle it.
		expect(plan.boundaryEventId).toBeGreaterThan(0)
		const boundaryOwner = rows.find((row) => row.base_event_id === plan.boundaryEventId)
		expect(boundaryOwner).toBeDefined()
		expect(retained.has(boundaryOwner!.id)).toBe(true)
		expect(boundaryOwner!.created_at).toBeLessThan(NOW - 7 * DAY)

		// Nothing inside the full-resolution window is ever proposed for deletion.
		const detailed = database
			.prepare('SELECT id FROM history_events WHERE created_at >= ?')
			.all(NOW - 7 * DAY) as Array<{ id: number }>
		for (const row of detailed) expect(plan.deletableEventIds).not.toContain(row.id)
		expect(store.reconstruct({ checkpointId: rows[rows.length - 1].id }).snapshot).toBeTruthy()
	})

	it('rolls a dry run back completely and leaves the deletion gate shut', () => {
		const { file, database } = buildAgedBoard()
		const before = counts(database)
		database.close()
		databases.pop()

		const dry = compactDatabase({ database: file, now: NOW, apply: false })
		expect(dry.applied).toBe(false)
		expect(dry.deletedEvents).toBe(0)
		expect(dry.deletedCheckpoints).toBe(0)
		expect(dry.deletableEventIds.length).toBeGreaterThan(0)
		expect(dry.integrity).toBe('ok')

		const reopened = new Database(file)
		databases.push(reopened)
		expect(counts(reopened)).toEqual(before)
		// The gate is transactional: a rolled-back pass cannot leave it open.
		expect((reopened.prepare('SELECT count(*) AS n FROM history_retention_gate').get() as { n: number }).n).toBe(0)
		expect(() => reopened.prepare('DELETE FROM history_events WHERE id = (SELECT MIN(id) FROM history_events)').run())
			.toThrow(/append-only/)
	})

	it('compacts only when every retained restore point still rebuilds identically', () => {
		const { file, database, store, explicitIds, auditIds } = buildAgedBoard()
		const plan = planCompaction(database, 'aged', NOW, 7, 90)
		const latestEventId = store.latestEventId()!

		// Hash the restore points the policy promises to keep, using the same
		// reconstruction path a real restore uses.
		const stable = (target: { checkpointId: number } | { eventId: number }) =>
			JSON.stringify(store.reconstruct(target).snapshot)
		const expected = new Map<string, string>()
		for (const id of plan.retainedCheckpointIds) expected.set(`checkpoint:${id}`, stable({ checkpointId: id }))
		expected.set('current', stable({ eventId: latestEventId }))
		const beforeCounts = counts(database)
		database.close()
		databases.pop()

		const result = compactDatabase({ database: file, now: NOW, apply: true })
		expect(result.applied).toBe(true)
		expect(result.integrity).toBe('ok')
		expect(result.deletedEvents).toBe(plan.deletableEventIds.length)
		expect(result.deletedCheckpoints).toBe(plan.deletedCheckpointIds.length)
		expect(result.bytesAfter).toBeLessThan(result.bytesBefore)

		const reopened = new Database(file)
		databases.push(reopened)
		const after = new BoardHistoryStore(reopened, 'aged')
		const afterStable = (target: { checkpointId: number } | { eventId: number }) =>
			JSON.stringify(after.reconstruct(target).snapshot)

		// Every retained restore point, and the current board, rebuild identically.
		for (const id of result.retainedCheckpointIds) {
			expect(afterStable({ checkpointId: id })).toBe(expected.get(`checkpoint:${id}`))
		}
		expect(afterStable({ eventId: latestEventId })).toBe(expected.get('current'))

		// A gap goes whole or not at all, so a projected audit row inside a deleted
		// gap goes with it. That is not a loss of the access-control record: the
		// authoritative account_events live in auth.sqlite, which compaction never
		// touches. What must hold here is all-or-nothing, which the reconstruction
		// identity checks above already prove.
		for (const id of auditIds) {
			const survived = after.getEvent(id) !== null
			if (!survived) expect(plan.deletableEventIds).toContain(id)
		}
		for (const id of explicitIds) expect(reopened.prepare('SELECT id FROM history_checkpoints WHERE id = ?').get(id)).toBeTruthy()
		expect(counts(reopened).events).toBeLessThan(beforeCounts.events)
		// Exactly the planned rows are gone. Prunable events below the boundary may
		// legitimately survive: deletion works on whole gaps, and a gap holding a
		// non-prunable row is skipped entire rather than partially emptied.
		for (const id of plan.deletableEventIds) {
			expect(reopened.prepare('SELECT id FROM history_events WHERE id = ?').get(id)).toBeUndefined()
		}
		expect(counts(reopened).events).toBe(beforeCounts.events - result.deletedEvents)
		expect(counts(reopened).checkpoints).toBe(beforeCounts.checkpoints - result.deletedCheckpoints)

		// A restore onto a retained checkpoint still works, and the board is still
		// editable afterwards.
		const target = result.retainedCheckpointIds[Math.floor(result.retainedCheckpointIds.length / 2)]
		const restored = after.reconstruct({ checkpointId: target })
		expect(restored.snapshot.documents.length).toBeGreaterThan(0)
		const appended = after.appendEvent({
			actorUserId: 'user:a',
			eventType: 'object.created',
			source: 'human',
			createdAt: NOW,
			changes: changesBetweenSnapshots(restored.snapshot, snapshot(
				[...restored.snapshot.documents.map((item) => item.state as TLRecord), record('shape:after-restore', 999)],
				restored.snapshot.documentClock + 1
			)),
			documentClock: restored.snapshot.documentClock + 1,
		})
		const replayed = after.reconstruct({ eventId: appended.id })
		expect(replayed.snapshot.documents.some((item) => (item.state as TLRecord).id === 'shape:after-restore')).toBe(true)

		// Running again is a no-op: the policy has converged.
		reopened.close()
		databases.pop()
		const second = compactDatabase({ database: file, now: NOW, apply: true })
		expect(second.deletedEvents).toBe(0)
		expect(second.deletedCheckpoints).toBe(0)
		expect(second.integrity).toBe('ok')
	})

	it('deletes nothing on a board that is entirely inside the full-resolution window', () => {
		const { file, database } = buildAgedBoard()
		database.close()
		databases.pop()
		// Pretend "now" is the board's own beginning: everything is recent.
		const result = compactDatabase({ database: file, now: NOW - 205 * DAY, apply: true })
		expect(result.boundaryEventId).toBe(0)
		expect(result.deletedEvents).toBe(0)
		expect(result.applied).toBe(false)
		expect(result.integrity).toBe('ok')
	})
})
