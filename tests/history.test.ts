import {
	NodeSqliteWrapper,
	SQLiteSyncStorage,
	type RoomSnapshot,
	type TLSyncForwardDiff,
} from '@tldraw/sync-core'
import type { TLRecord } from '@tldraw/tlschema'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	applyHistoryEvents,
	BoardHistoryRecorder,
	BoardHistoryStore,
	changesBetweenSnapshots,
	changesFromForwardDiff,
	migrateHistoryDatabase,
} from '../server/history'
import { HistorySyncStorage } from '../server/history-storage'

const databases: Database.Database[] = []

afterEach(() => {
	vi.useRealTimers()
	while (databases.length) databases.pop()?.close()
})

function makeDatabase() {
	const database = new Database(':memory:')
	databases.push(database)
	return database
}

function record(id: string, x: number, text = id): TLRecord {
	return { id, typeName: 'shape', x, y: 0, props: { text } } as unknown as TLRecord
}

function snapshot(records: TLRecord[], documentClock = 1): RoomSnapshot {
	return {
		clock: documentClock,
		documentClock,
		documents: records.map((state) => ({ state, lastChangedClock: documentClock })),
		tombstones: {},
	}
}

describe('history migrations and immutable storage', () => {
	it('uses its own additive migration ledger without touching PRAGMA user_version', () => {
		const database = makeDatabase()
		database.pragma('user_version = 73')
		migrateHistoryDatabase(database)
		migrateHistoryDatabase(database)

		const migrations = database
			.prepare('SELECT migration_id FROM app_schema_migrations ORDER BY migration_id')
			.all() as Array<{ migration_id: string }>
		expect(migrations.map((row) => row.migration_id)).toEqual([
			'history:0001-events',
			'history:0002-checkpoints',
			'history:0003-append-only-guards',
			'history:0004-coalescing-fragments',
			'history:0005-account-audit-projection',
			'history:0006-retention-gate',
		])
		expect(database.pragma('user_version', { simple: true })).toBe(73)
	})

	it('makes finalized events and checkpoints append-only', () => {
		const database = makeDatabase()
		const store = new BoardHistoryStore(database, 'board-a')
		const event = store.appendEvent({ eventType: 'board.created', source: 'system' })
		const checkpoint = store.createCheckpoint({ snapshot: snapshot([]), reason: 'explicit' })

		expect(() => database.prepare('UPDATE history_events SET event_type = ? WHERE id = ?').run('x', event.id))
			.toThrow(/append-only/)
		expect(() => database.prepare('DELETE FROM history_events WHERE id = ?').run(event.id))
			.toThrow(/append-only/)
		expect(() => database.prepare('DELETE FROM history_checkpoints WHERE id = ?').run(checkpoint.id))
			.toThrow(/append-only/)
	})

	it('participates in an existing transaction and rolls back with it', () => {
		const database = makeDatabase()
		const store = new BoardHistoryStore(database, 'board-a')
		expect(() =>
			database.transaction(() => {
				store.appendEvent({ eventType: 'object.edited', source: 'human' })
				throw new Error('roll back whiteboard transaction')
			})()
		).toThrow('roll back whiteboard transaction')
		expect(store.listEvents().events).toHaveLength(0)
	})
})

describe('event queries and durable coalescing', () => {
	it('orders and filters events by user, source, and event type', () => {
		const store = new BoardHistoryStore(makeDatabase(), 'board-a')
		store.appendEvent({
			actorUserId: 'user-a',
			eventType: 'object.created',
			source: 'human',
			createdAt: 10,
		})
		store.appendEvent({
			actorUserId: 'user-b',
			eventType: 'ai.suggestion_generated',
			source: 'ai',
			createdAt: 20,
		})
		store.appendEvent({
			actorUserId: 'user-a',
			eventType: 'object.edited',
			source: 'human',
			createdAt: 30,
		})

		expect(store.listEvents({ order: 'asc' }).events.map((event) => event.createdAt)).toEqual([
			10, 20, 30,
		])
		expect(store.listEvents({ userId: 'user-a' }).events).toHaveLength(2)
		expect(store.listEvents({ source: 'ai' }).events[0].eventType).toBe(
			'ai.suggestion_generated'
		)
		expect(store.listEvents({ eventType: ['object.created', 'object.edited'] }).events).toHaveLength(2)
	})

	it('durably stages fragments then retains the first before and final after', () => {
		const store = new BoardHistoryStore(makeDatabase(), 'board-a')
		const a = record('shape:a', 0)
		const b = record('shape:a', 10)
		const c = record('shape:a', 20)
		const common = {
			actorUserId: 'user-a',
			sessionId: 'session-a',
			eventType: 'object.moved',
			entityType: 'object',
			entityId: 'shape:a',
			coalesceKey: 'drag:shape:a',
		}
		store.appendFragment({
			...common,
			source: 'human',
			createdAt: 100,
			flushAfter: 200,
			changes: [{ recordId: a.id, before: a, after: b }],
			documentClock: 2,
		})
		store.appendFragment({
			...common,
			source: 'human',
			createdAt: 150,
			flushAfter: 250,
			changes: [{ recordId: a.id, before: b, after: c }],
			documentClock: 3,
		})

		expect(store.getPendingFragmentCount()).toBe(2)
		expect(store.flushFragments({ now: 225 })).toHaveLength(0)
		const events = store.flushFragments({ now: 250 })
		expect(events).toHaveLength(1)
		expect(events[0].changes).toEqual([{ recordId: a.id, before: a, after: c }])
		expect(events[0].documentClock).toBe(3)
		expect(store.getPendingFragmentCount()).toBe(0)
	})

	it('recovers durable pending fragments when a recorder starts', () => {
		const database = makeDatabase()
		const store = new BoardHistoryStore(database, 'board-a')
		const a = record('shape:a', 0)
		store.appendFragment({
			eventType: 'object.created',
			source: 'human',
			changes: [{ recordId: a.id, before: null, after: a }],
			flushAfter: Number.MAX_SAFE_INTEGER,
		})

		const recorder = new BoardHistoryRecorder({
			store,
			getSnapshot: () => snapshot([a]),
			initializeLegacy: false,
		})
		expect(store.getPendingFragmentCount()).toBe(0)
		expect(store.listEvents().events[0].eventType).toBe('object.created')
		recorder.dispose()
	})

	it('does not coalesce across an interleaved actor event', () => {
		const store = new BoardHistoryStore(makeDatabase(), 'board-a')
		const a = record('shape:a', 0)
		const b = record('shape:a', 10)
		const c = record('shape:a', 20)
		const d = record('shape:a', 30)
		const add = (sessionId: string, before: TLRecord, after: TLRecord, createdAt: number) =>
			store.appendFragment({
				actorUserId: sessionId,
				sessionId,
				eventType: 'object.moved',
				source: 'human',
				coalesceKey: 'shape:a',
				createdAt,
				flushAfter: createdAt,
				changes: [{ recordId: a.id, before, after }],
			})
		add('session-a', a, b, 1)
		add('session-b', b, c, 2)
		add('session-a', c, d, 3)

		const events = store.flushFragments({ force: true })
		expect(events).toHaveLength(3)
		expect(applyHistoryEvents(snapshot([a]), events).documents[0].state).toEqual(d)
	})
})

describe('tldraw storage transaction boundary', () => {
	function integratedStorage() {
		const database = makeDatabase()
		const delegate = new SQLiteSyncStorage<TLRecord>({ sql: new NodeSqliteWrapper(database) })
		const store = new BoardHistoryStore(database, 'board-a')
		const recorder = new BoardHistoryRecorder({
			store,
			getSnapshot: () => delegate.getSnapshot(),
			initializeLegacy: false,
		})
		return {
			delegate,
			store,
			recorder,
			storage: new HistorySyncStorage(delegate, database, recorder),
		}
	}

	it('commits canvas state and a durable history fragment without a nested transaction', () => {
		const { delegate, store, recorder, storage } = integratedStorage()
		const a = record('shape:a', 0)
		storage.setNextContext({
			actorUserId: 'user-a',
			actorDisplayName: 'Alice',
			sessionId: 'session-a',
			source: 'human',
		})
		expect(() => storage.transaction((txn) => txn.set(a.id, a))).not.toThrow()
		expect(delegate.getSnapshot().documents.find((entry) => entry.state.id === a.id)?.state).toEqual(a)
		expect(store.getPendingFragmentCount()).toBe(1)

		const [event] = recorder.flush()
		expect(event.actorUserId).toBe('user-a')
		expect(event.changes).toEqual([{ recordId: a.id, before: null, after: a }])
	})

	it('rolls back the canvas mutation if its history insert fails', () => {
		const { delegate, store, storage } = integratedStorage()
		const a = record('shape:a', 0)
		storage.setNextContext({
			actorUserId: 'user-a',
			actorDisplayName: 'Alice',
			source: 'human',
			metadata: { invalidJson: 1n } as unknown as Record<string, unknown>,
		})
		expect(() => storage.transaction((txn) => txn.set(a.id, a))).toThrow(/JSON serializable/)
		expect(delegate.getSnapshot().documents.some((entry) => entry.state.id === a.id)).toBe(false)
		expect(store.getPendingFragmentCount()).toBe(0)
	})
})

describe('diffs, snapshots, reconstruction, and restore', () => {
	it('turns forward diffs and snapshots into complete before/after changes', () => {
		const a = record('shape:a', 0)
		const moved = record('shape:a', 10)
		const b = record('shape:b', 20)
		const diff: TLSyncForwardDiff<TLRecord> = {
			puts: { [a.id]: [a, moved], [b.id]: b },
			deletes: [],
		}
		expect(changesFromForwardDiff(diff, snapshot([a]))).toEqual([
			{ recordId: a.id, before: a, after: moved },
			{ recordId: b.id, before: null, after: b },
		])
		expect(changesBetweenSnapshots(snapshot([a]), snapshot([moved, b]))).toEqual([
			{ recordId: a.id, before: a, after: moved },
			{ recordId: b.id, before: null, after: b },
		])
	})

	it('creates one idempotent legacy checkpoint and reconstructs a historical event', () => {
		const store = new BoardHistoryStore(makeDatabase(), 'board-a')
		const a = record('shape:a', 0)
		const moved = record('shape:a', 10)
		const baseline = store.ensureLegacyImportCheckpoint(snapshot([a], 1), 10)
		expect(store.ensureLegacyImportCheckpoint(snapshot([moved], 2), 20).id).toBe(baseline.id)
		const event = store.appendEvent({
			actorUserId: 'user-a',
			eventType: 'object.moved',
			source: 'human',
			createdAt: 30,
			changes: [{ recordId: a.id, before: a, after: moved }],
			documentClock: 2,
		})

		const result = store.reconstruct({ eventId: event.id })
		expect(result.baseCheckpointId).toBe(baseline.id)
		expect(result.appliedEventIds).toEqual([event.id])
		expect(result.snapshot.documents[0].state).toEqual(moved)
	})

	it('applies deletion and rejects a divergent event chain', () => {
		const a = record('shape:a', 0)
		const valid = {
			id: 2,
			boardId: 'board-a',
			actorUserId: 'user-a',
			sessionId: null,
			eventType: 'object.deleted',
			entityType: 'object',
			entityId: a.id,
			source: 'human' as const,
			createdAt: 20,
			metadata: {},
			changes: [{ recordId: a.id, before: a, after: null }],
			documentClock: 2,
		}
		const result = applyHistoryEvents(snapshot([a]), [valid])
		expect(result.documents).toEqual([])
		expect(result.tombstones?.[a.id]).toBe(2)
		expect(() =>
			applyHistoryEvents(snapshot([]), [{ ...valid, id: 3 }])
		).toThrow(/History divergence/)
	})

	it('prepares and completes restore as a new head without removing intervening history', () => {
		const store = new BoardHistoryStore(makeDatabase(), 'board-a')
		const a = record('shape:a', 0)
		const moved = record('shape:a', 10)
		const baseline = store.ensureLegacyImportCheckpoint(snapshot([a], 1), 10)
		store.appendEvent({
			actorUserId: 'user-a',
			eventType: 'object.moved',
			source: 'human',
			createdAt: 20,
			changes: [{ recordId: a.id, before: a, after: moved }],
			documentClock: 2,
		})
		const beforeRestoreCount = store.listEvents().events.length
		const prepared = store.prepareRestore({
			target: { checkpointId: baseline.id },
			currentSnapshot: snapshot([moved], 2),
			actorUserId: 'user-a',
			createdAt: 30,
		})
		expect(prepared.targetState.snapshot.documents[0].state).toEqual(a)
		expect(prepared.preRestoreCheckpoint.snapshot.documents[0].state).toEqual(moved)
		const completed = store.completeRestore({
			restoreId: prepared.restoreId,
			beforeSnapshot: snapshot([moved], 2),
			restoredSnapshot: snapshot([a], 3),
			actorUserId: 'user-a',
			target: prepared.target,
			createdAt: 31,
		})
		expect(completed.completedEvent.eventType).toBe('restore.completed')
		expect(store.listEvents().events).toHaveLength(beforeRestoreCount + 2)
		expect(store.listCheckpoints().map((item) => item.reason)).toContain('pre_restore')
	})

	it('periodically checkpoints through the supplied snapshot callback', () => {
		const store = new BoardHistoryStore(makeDatabase(), 'board-a')
		let current = snapshot([], 0)
		const recorder = new BoardHistoryRecorder({
			store,
			getSnapshot: () => current,
			initializeLegacy: false,
			snapshotEveryEvents: 1,
			snapshotEveryMs: Number.MAX_SAFE_INTEGER,
		})
		const a = record('shape:a', 0)
		current = snapshot([a], 1)
		recorder.recordSynchronousEvent({
			eventType: 'ai.object_created',
			source: 'ai',
			changes: [{ recordId: a.id, before: null, after: a }],
			documentClock: 1,
		})
		expect(store.listCheckpoints()).toHaveLength(1)
		expect(store.listCheckpoints()[0].reason).toBe('periodic')
		recorder.dispose()
	})
})
