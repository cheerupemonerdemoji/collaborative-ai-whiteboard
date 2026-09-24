import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { RoomSnapshot, TLSyncForwardDiff } from '@tldraw/sync-core'
import type { TLRecord } from '@tldraw/tlschema'
import type Database from 'better-sqlite3'
import type {
	HistoricalTarget,
	HistoryCheckpoint,
	HistoryCheckpointInput,
	HistoryCheckpointSummary,
	HistoryEvent,
	HistoryEventFilters,
	HistoryEventInput,
	HistoryEventPage,
	HistoryFragment,
	HistoryFragmentInput,
	HistoryMetadata,
	HistoryRecordChange,
	HistorySource,
	ReconstructedBoardState,
	RestorePreparation,
} from '../shared/history'

const DEFAULT_COALESCE_MS = 900
const DEFAULT_SNAPSHOT_EVENT_INTERVAL = 50
const DEFAULT_SNAPSHOT_TIME_INTERVAL = 15 * 60_000

interface HistoryMigration {
	id: string
	sql: string
}

const migrations: readonly HistoryMigration[] = [
	{
		id: 'history:0001-events',
		sql: `
			CREATE TABLE history_events (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				board_id TEXT NOT NULL,
				actor_user_id TEXT,
				session_id TEXT,
				event_type TEXT NOT NULL,
				entity_type TEXT,
				entity_id TEXT,
				source TEXT NOT NULL CHECK (source IN ('human', 'ai', 'system')),
				created_at INTEGER NOT NULL,
				metadata_json TEXT NOT NULL,
				changes_json TEXT NOT NULL,
				document_clock INTEGER
			);
			CREATE INDEX history_events_board_time_idx ON history_events(board_id, created_at, id);
			CREATE INDEX history_events_board_user_idx ON history_events(board_id, actor_user_id, id);
			CREATE INDEX history_events_board_type_idx ON history_events(board_id, event_type, id);
			CREATE INDEX history_events_board_source_idx ON history_events(board_id, source, id);
		`,
	},
	{
		id: 'history:0002-checkpoints',
		sql: `
			CREATE TABLE history_checkpoints (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				board_id TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				created_by TEXT,
				base_event_id INTEGER,
				label TEXT,
				reason TEXT NOT NULL,
				snapshot_json TEXT NOT NULL
			);
			CREATE INDEX history_checkpoints_board_time_idx ON history_checkpoints(board_id, created_at, id);
			CREATE INDEX history_checkpoints_board_event_idx ON history_checkpoints(board_id, base_event_id, id);
		`,
	},
	{
		id: 'history:0003-append-only-guards',
		sql: `
			CREATE TRIGGER history_events_no_update
			BEFORE UPDATE ON history_events BEGIN
				SELECT RAISE(ABORT, 'history_events is append-only');
			END;
			CREATE TRIGGER history_events_no_delete
			BEFORE DELETE ON history_events BEGIN
				SELECT RAISE(ABORT, 'history_events is append-only');
			END;
			CREATE TRIGGER history_checkpoints_no_update
			BEFORE UPDATE ON history_checkpoints BEGIN
				SELECT RAISE(ABORT, 'history_checkpoints is append-only');
			END;
			CREATE TRIGGER history_checkpoints_no_delete
			BEFORE DELETE ON history_checkpoints BEGIN
				SELECT RAISE(ABORT, 'history_checkpoints is append-only');
			END;
		`,
	},
	{
		id: 'history:0004-coalescing-fragments',
		sql: `
			CREATE TABLE history_event_fragments (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				board_id TEXT NOT NULL,
				actor_user_id TEXT,
				session_id TEXT,
				event_type TEXT NOT NULL,
				entity_type TEXT,
				entity_id TEXT,
				source TEXT NOT NULL CHECK (source IN ('human', 'ai', 'system')),
				created_at INTEGER NOT NULL,
				metadata_json TEXT NOT NULL,
				changes_json TEXT NOT NULL,
				document_clock INTEGER,
				coalesce_group TEXT NOT NULL,
				flush_after INTEGER NOT NULL
			);
			CREATE INDEX history_fragments_due_idx
				ON history_event_fragments(board_id, coalesce_group, flush_after, id);
		`,
	},
	{
		id: 'history:0005-account-audit-projection',
		sql: 'CREATE TABLE history_account_audit_cursor (board_id TEXT PRIMARY KEY, last_id INTEGER NOT NULL);',
	},
	{
		// ADR 005 turns "history is never deleted" into "history is never deleted
		// except by the retention policy". The distinction is enforced here rather
		// than by dropping the guards during maintenance: deletion is refused
		// unless a gate row exists, and the compactor opens and closes that gate
		// inside the same transaction as its deletes. A crash, a rollback or a
		// failed verification takes the gate row with it, so there is no window in
		// which ordinary application code can delete history.
		// UPDATE remains categorically forbidden: a retained event is still immutable.
		id: 'history:0006-retention-gate',
		sql: `
			CREATE TABLE history_retention_gate (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				opened_at INTEGER NOT NULL,
				reason TEXT NOT NULL
			);
			DROP TRIGGER history_events_no_delete;
			DROP TRIGGER history_checkpoints_no_delete;
			CREATE TRIGGER history_events_no_delete
			BEFORE DELETE ON history_events
			WHEN NOT EXISTS (SELECT 1 FROM history_retention_gate WHERE id = 1) BEGIN
				SELECT RAISE(ABORT, 'history_events is append-only outside a retention pass');
			END;
			CREATE TRIGGER history_checkpoints_no_delete
			BEFORE DELETE ON history_checkpoints
			WHEN NOT EXISTS (SELECT 1 FROM history_retention_gate WHERE id = 1) BEGIN
				SELECT RAISE(ABORT, 'history_checkpoints is append-only outside a retention pass');
			END;
		`,
	},
]

export function migrateHistoryDatabase(database: Database.Database): void {
	database.exec(`
		CREATE TABLE IF NOT EXISTS app_schema_migrations (
			migration_id TEXT PRIMARY KEY,
			applied_at INTEGER NOT NULL
		)
	`)
	const hasMigration = database.prepare('SELECT 1 FROM app_schema_migrations WHERE migration_id = ?')
	const markMigration = database.prepare(
		'INSERT INTO app_schema_migrations (migration_id, applied_at) VALUES (?, ?)'
	)
	for (const migration of migrations) {
		if (hasMigration.get(migration.id)) continue
		const apply = database.transaction(() => {
			database.exec(migration.sql)
			markMigration.run(migration.id, Date.now())
		})
		apply()
	}
}

function assertIdentifier(value: string, label: string): void {
	if (!value || value.length > 200) throw new Error(`${label} must be between 1 and 200 characters`)
}

function assertSource(source: string): asserts source is HistorySource {
	if (source !== 'human' && source !== 'ai' && source !== 'system') {
		throw new Error(`Invalid history source: ${source}`)
	}
}

function jsonStringify(value: unknown, label: string): string {
	let result: string | undefined
	try {
		result = JSON.stringify(value)
	} catch (error) {
		throw new Error(`${label} must be JSON serializable`, { cause: error })
	}
	if (result === undefined) throw new Error(`${label} must be JSON serializable`)
	return result
}

function jsonParse<T>(value: string, label: string): T {
	try {
		return JSON.parse(value) as T
	} catch (error) {
		throw new Error(`Stored ${label} is invalid JSON`, { cause: error })
	}
}

function cloneJson<T>(value: T, label = 'value'): T {
	return jsonParse<T>(jsonStringify(value, label), label)
}

function validateMetadata(metadata: HistoryMetadata | undefined): HistoryMetadata {
	const value = cloneJson(metadata ?? {}, 'history metadata')
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error('History metadata must be a JSON object')
	}
	return value
}

function validateChanges(changes: readonly HistoryRecordChange[]): HistoryRecordChange[] {
	return changes.map((change) => {
		assertIdentifier(change.recordId, 'recordId')
		if (!change.before && !change.after) throw new Error('A history change cannot have two null sides')
		if (change.before?.id !== undefined && change.before.id !== change.recordId) {
			throw new Error(`before record ID does not match ${change.recordId}`)
		}
		if (change.after?.id !== undefined && change.after.id !== change.recordId) {
			throw new Error(`after record ID does not match ${change.recordId}`)
		}
		return cloneJson(change, 'history changes')
	})
}

function validateSnapshot(snapshot: RoomSnapshot): RoomSnapshot {
	if (!snapshot || !Array.isArray(snapshot.documents)) throw new Error('Invalid room snapshot')
	for (const document of snapshot.documents) {
		if (!document || typeof document.lastChangedClock !== 'number' || !document.state?.id) {
			throw new Error('Invalid document in room snapshot')
		}
	}
	return cloneJson(snapshot, 'room snapshot')
}

interface EventRow {
	id: number
	board_id: string
	actor_user_id: string | null
	session_id: string | null
	event_type: string
	entity_type: string | null
	entity_id: string | null
	source: string
	created_at: number
	metadata_json: string
	changes_json: string
	document_clock: number | null
}

interface CheckpointRow {
	id: number
	board_id: string
	created_at: number
	created_by: string | null
	base_event_id: number | null
	label: string | null
	reason: string
	snapshot_json: string
}

interface FragmentRow extends EventRow {
	coalesce_group: string
	flush_after: number
}

function eventFromRow(row: EventRow): HistoryEvent {
	assertSource(row.source)
	return {
		id: row.id,
		boardId: row.board_id,
		actorUserId: row.actor_user_id,
		sessionId: row.session_id,
		eventType: row.event_type,
		entityType: row.entity_type,
		entityId: row.entity_id,
		source: row.source,
		createdAt: row.created_at,
		metadata: validateMetadata(jsonParse<HistoryMetadata>(row.metadata_json, 'event metadata')),
		changes: validateChanges(jsonParse<HistoryRecordChange[]>(row.changes_json, 'event changes')),
		documentClock: row.document_clock,
	}
}

function fragmentFromRow(row: FragmentRow): HistoryFragment {
	return {
		...eventFromRow(row),
		coalesceGroup: row.coalesce_group,
		flushAfter: row.flush_after,
	}
}

function checkpointFromRow(row: CheckpointRow): HistoryCheckpoint {
	return {
		id: row.id,
		boardId: row.board_id,
		createdAt: row.created_at,
		createdBy: row.created_by,
		baseEventId: row.base_event_id,
		label: row.label,
		reason: row.reason,
		snapshot: validateSnapshot(jsonParse<RoomSnapshot>(row.snapshot_json, 'checkpoint snapshot')),
	}
}

function mergeChanges(groups: readonly (readonly HistoryRecordChange[])[]): HistoryRecordChange[] {
	const merged = new Map<string, HistoryRecordChange>()
	for (const changes of groups) {
		for (const change of changes) {
			const previous = merged.get(change.recordId)
			const next = previous
				? { recordId: change.recordId, before: previous.before, after: change.after }
				: cloneJson(change)
			if (next.before === null && next.after === null) merged.delete(change.recordId)
			else if (next.before && next.after && isDeepStrictEqual(next.before, next.after)) {
				merged.delete(change.recordId)
			} else merged.set(change.recordId, next)
		}
	}
	return [...merged.values()]
}

export function changesFromForwardDiff(
	diff: TLSyncForwardDiff<TLRecord>,
	beforeSnapshot: RoomSnapshot
): HistoryRecordChange[] {
	const beforeById = new Map<string, TLRecord>(
		beforeSnapshot.documents.map((entry) => [entry.state.id, entry.state as TLRecord])
	)
	const changes: HistoryRecordChange[] = []
	for (const [recordId, put] of Object.entries(diff.puts)) {
		if (Array.isArray(put)) {
			changes.push({ recordId, before: put[0], after: put[1] })
		} else {
			changes.push({ recordId, before: beforeById.get(recordId) ?? null, after: put })
		}
	}
	for (const recordId of diff.deletes) {
		const before = beforeById.get(recordId)
		if (!before) throw new Error(`Cannot create replayable delete for missing record ${recordId}`)
		changes.push({ recordId, before, after: null })
	}
	return validateChanges(changes)
}

export function changesBetweenSnapshots(
	beforeSnapshot: RoomSnapshot,
	afterSnapshot: RoomSnapshot
): HistoryRecordChange[] {
	const before = new Map<string, TLRecord>(
		beforeSnapshot.documents.map((entry) => [entry.state.id, entry.state as TLRecord])
	)
	const after = new Map<string, TLRecord>(
		afterSnapshot.documents.map((entry) => [entry.state.id, entry.state as TLRecord])
	)
	const ids = new Set([...before.keys(), ...after.keys()])
	const changes: HistoryRecordChange[] = []
	for (const recordId of ids) {
		const beforeRecord = before.get(recordId) ?? null
		const afterRecord = after.get(recordId) ?? null
		if (!isDeepStrictEqual(beforeRecord, afterRecord)) {
			changes.push({ recordId, before: beforeRecord, after: afterRecord })
		}
	}
	return validateChanges(changes)
}

export class BoardHistoryStore {
	readonly boardId: string

	constructor(
		readonly database: Database.Database,
		boardId: string
	) {
		assertIdentifier(boardId, 'boardId')
		this.boardId = boardId
		migrateHistoryDatabase(database)
	}

	private atomic<T>(callback: () => T): T {
		return this.database.inTransaction ? callback() : this.database.transaction(callback)()
	}

	private insertEvent(input: HistoryEventInput): HistoryEvent {
		assertSource(input.source)
		assertIdentifier(input.eventType, 'eventType')
		const changes = validateChanges(input.changes ?? [])
		const metadata = validateMetadata(input.metadata)
		const createdAt = input.createdAt ?? Date.now()
		const result = this.database
			.prepare(`
				INSERT INTO history_events (
					board_id, actor_user_id, session_id, event_type, entity_type, entity_id,
					source, created_at, metadata_json, changes_json, document_clock
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`)
			.run(
				this.boardId,
				input.actorUserId ?? null,
				input.sessionId ?? null,
				input.eventType,
				input.entityType ?? null,
				input.entityId ?? null,
				input.source,
				createdAt,
				jsonStringify(metadata, 'event metadata'),
				jsonStringify(changes, 'event changes'),
				input.documentClock ?? null
			)
		return this.getEvent(Number(result.lastInsertRowid))!
	}

	/** Synchronous and safe to call within an outer better-sqlite3 transaction. */
	appendEvent(input: HistoryEventInput): HistoryEvent {
		return this.atomic(() => {
			// An immediate semantic event is an ordering boundary for pending human edits.
			this.flushFragments({ force: true })
			return this.insertEvent(input)
		})
	}

	/**
	 * Persist a coalescible fragment. Call this inside the same transaction as the tldraw write.
	 * Fragments are durable crash-recovery staging rows, not part of the immutable public timeline.
	 */
	appendFragment(input: HistoryFragmentInput): HistoryFragment {
		return this.atomic(() => {
			assertSource(input.source)
			assertIdentifier(input.eventType, 'eventType')
			const createdAt = input.createdAt ?? Date.now()
			const coalesceGroup = jsonStringify(
				[
					input.actorUserId ?? null,
					input.sessionId ?? null,
					input.source,
					input.eventType,
					input.entityType ?? null,
					input.entityId ?? null,
					input.coalesceKey ?? 'default',
				],
				'coalescing key'
			)
			const changes = validateChanges(input.changes ?? [])
			const result = this.database
				.prepare(`
					INSERT INTO history_event_fragments (
						board_id, actor_user_id, session_id, event_type, entity_type, entity_id,
						source, created_at, metadata_json, changes_json, document_clock,
						coalesce_group, flush_after
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				`)
				.run(
					this.boardId,
					input.actorUserId ?? null,
					input.sessionId ?? null,
					input.eventType,
					input.entityType ?? null,
					input.entityId ?? null,
					input.source,
					createdAt,
					jsonStringify(validateMetadata(input.metadata), 'fragment metadata'),
					jsonStringify(changes, 'fragment changes'),
					input.documentClock ?? null,
					coalesceGroup,
					input.flushAfter ?? createdAt + DEFAULT_COALESCE_MS
				)
			const row = this.database
				.prepare('SELECT * FROM history_event_fragments WHERE id = ? AND board_id = ?')
				.get(Number(result.lastInsertRowid), this.boardId) as FragmentRow
			return fragmentFromRow(row)
		})
	}

	/** Atomically converts due (or all) durable fragments into immutable events. */
	flushFragments(options: { now?: number; force?: boolean } = {}): HistoryEvent[] {
		return this.atomic(() => {
			const now = options.now ?? Date.now()
			const pending = this.database
				.prepare(`
					SELECT * FROM history_event_fragments
					WHERE board_id = ? ORDER BY id ASC
				`)
				.all(this.boardId) as FragmentRow[]
			const groups: FragmentRow[][] = []
			for (const row of pending) {
				const previous = groups.at(-1)
				if (previous?.[0].coalesce_group === row.coalesce_group) previous.push(row)
				else groups.push([row])
			}
			const events: HistoryEvent[] = []
			for (const group of groups) {
				// Never skip an earlier fragment to publish a later event: that would make replay order lie.
				if (!options.force && group.some((row) => row.flush_after > now)) break
				const fragments = group.map(fragmentFromRow)
				if (!fragments.length) continue
				const first = fragments[0]
				const last = fragments[fragments.length - 1]
				const changes = mergeChanges(fragments.map((fragment) => fragment.changes))
				const metadata = Object.assign({}, ...fragments.map((fragment) => fragment.metadata))
				if (changes.length || Object.keys(metadata).length) {
					events.push(
						this.insertEvent({
							actorUserId: first.actorUserId,
							sessionId: first.sessionId,
							eventType: first.eventType,
							entityType: first.entityType,
							entityId: first.entityId,
							source: first.source,
							createdAt: last.createdAt,
							metadata,
							changes,
							documentClock: last.documentClock,
						})
					)
				}
				this.database
					.prepare('DELETE FROM history_event_fragments WHERE board_id = ? AND id BETWEEN ? AND ?')
					.run(this.boardId, group[0].id, group[group.length - 1].id)
			}
			return events
		})
	}

	getPendingFragmentCount(): number {
		const row = this.database
			.prepare('SELECT COUNT(*) AS count FROM history_event_fragments WHERE board_id = ?')
			.get(this.boardId) as { count: number }
		return row.count
	}

	getEvent(id: number): HistoryEvent | null {
		const row = this.database
			.prepare('SELECT * FROM history_events WHERE board_id = ? AND id = ?')
			.get(this.boardId, id) as EventRow | undefined
		return row ? eventFromRow(row) : null
	}

	listEvents(filters: HistoryEventFilters = {}): HistoryEventPage {
		const clauses = ['board_id = ?']
		const bindings: Array<string | number> = [this.boardId]
		const addScalar = (column: string, value: string | number | undefined, operator = '=') => {
			if (value === undefined) return
			clauses.push(`${column} ${operator} ?`)
			bindings.push(value)
		}
		const addList = (column: string, value: string | readonly string[] | undefined) => {
			if (value === undefined) return
			const values = Array.isArray(value) ? value : [value]
			if (!values.length) {
				clauses.push('0 = 1')
				return
			}
			clauses.push(`${column} IN (${values.map(() => '?').join(', ')})`)
			bindings.push(...values)
		}
		addScalar('actor_user_id', filters.userId)
		addList('source', filters.source)
		addList('event_type', filters.eventType)
		addScalar('entity_type', filters.entityType)
		addScalar('entity_id', filters.entityId)
		addScalar('created_at', filters.from, '>=')
		addScalar('created_at', filters.to, '<=')
		addScalar('id', filters.after, '>')
		addScalar('id', filters.before, '<')
		const limit = Math.max(1, Math.min(filters.limit ?? 50, 200))
		const order = filters.order === 'asc' ? 'ASC' : 'DESC'
		const rows = this.database
			.prepare(`SELECT * FROM history_events WHERE ${clauses.join(' AND ')} ORDER BY id ${order} LIMIT ?`)
			.all(...bindings, limit + 1) as EventRow[]
		const hasMore = rows.length > limit
		const events = rows.slice(0, limit).map(eventFromRow)
		return { events, nextCursor: hasMore ? events.at(-1)?.id ?? null : null }
	}

	private insertCheckpoint(input: HistoryCheckpointInput): HistoryCheckpoint {
		const snapshot = validateSnapshot(input.snapshot)
		const result = this.database
			.prepare(`
				INSERT INTO history_checkpoints (
					board_id, created_at, created_by, base_event_id, label, reason, snapshot_json
				) VALUES (?, ?, ?, ?, ?, ?, ?)
			`)
			.run(
				this.boardId,
				input.createdAt ?? Date.now(),
				input.createdBy ?? null,
				input.baseEventId === undefined ? this.latestEventId() : input.baseEventId,
				input.label ?? null,
				input.reason,
				jsonStringify(snapshot, 'room snapshot')
			)
		return this.getCheckpoint(Number(result.lastInsertRowid))!
	}

	createCheckpoint(input: HistoryCheckpointInput): HistoryCheckpoint {
		return this.atomic(() => {
			this.flushFragments({ force: true })
			return this.insertCheckpoint(input)
		})
	}

	getCheckpoint(id: number): HistoryCheckpoint | null {
		const row = this.database
			.prepare('SELECT * FROM history_checkpoints WHERE board_id = ? AND id = ?')
			.get(this.boardId, id) as CheckpointRow | undefined
		return row ? checkpointFromRow(row) : null
	}

	listCheckpoints(limit = 100): HistoryCheckpointSummary[] {
		const rows = this.database
			.prepare(`
				SELECT id, board_id, created_at, created_by, base_event_id, label, reason
				FROM history_checkpoints WHERE board_id = ? ORDER BY id DESC LIMIT ?
			`)
			.all(this.boardId, Math.max(1, Math.min(limit, 500))) as Array<Omit<CheckpointRow, 'snapshot_json'>>
		return rows.map((row) => ({
			id: row.id,
			boardId: row.board_id,
			createdAt: row.created_at,
			createdBy: row.created_by,
			baseEventId: row.base_event_id,
			label: row.label,
			reason: row.reason,
		}))
	}

	latestEventId(): number | null {
		const row = this.database
			.prepare('SELECT MAX(id) AS id FROM history_events WHERE board_id = ?')
			.get(this.boardId) as { id: number | null }
		return row.id
	}

	ensureLegacyImportCheckpoint(snapshot: RoomSnapshot, createdAt = Date.now()): HistoryCheckpoint {
		return this.atomic(() => {
			const existing = this.database
				.prepare('SELECT * FROM history_checkpoints WHERE board_id = ? ORDER BY id ASC LIMIT 1')
				.get(this.boardId) as CheckpointRow | undefined
			if (existing) return checkpointFromRow(existing)
			const imported = this.insertEvent({
				eventType: 'board.imported',
				source: 'system',
				createdAt,
				entityType: 'board',
				entityId: this.boardId,
				metadata: { legacyImport: true },
				documentClock: snapshot.documentClock ?? null,
			})
			return this.insertCheckpoint({
				snapshot,
				createdAt,
				baseEventId: imported.id,
				reason: 'legacy_import',
				label: 'Imported board state',
			})
		})
	}

	private resolveTargetEventId(target: HistoricalTarget): number | null {
		if ('eventId' in target) {
			if (!this.getEvent(target.eventId)) throw new Error('History event not found')
			return target.eventId
		}
		if ('checkpointId' in target) {
			const checkpoint = this.getCheckpoint(target.checkpointId)
			if (!checkpoint) throw new Error('Checkpoint not found')
			return checkpoint.baseEventId
		}
		const row = this.database
			.prepare(`
				SELECT id FROM history_events
				WHERE board_id = ? AND created_at <= ? ORDER BY id DESC LIMIT 1
			`)
			.get(this.boardId, target.timestamp) as { id: number } | undefined
		return row?.id ?? null
	}

	reconstruct(target: HistoricalTarget): ReconstructedBoardState {
		const targetEventId = this.resolveTargetEventId(target)
		let checkpointRow: CheckpointRow | undefined
		if ('checkpointId' in target) {
			checkpointRow = this.database
				.prepare('SELECT * FROM history_checkpoints WHERE board_id = ? AND id = ?')
				.get(this.boardId, target.checkpointId) as CheckpointRow | undefined
		} else if (targetEventId === null) {
			checkpointRow = this.database
				.prepare(`
					SELECT * FROM history_checkpoints
					WHERE board_id = ? AND base_event_id IS NULL ORDER BY id DESC LIMIT 1
				`)
				.get(this.boardId) as CheckpointRow | undefined
		} else {
			checkpointRow = this.database
				.prepare(`
					SELECT * FROM history_checkpoints
					WHERE board_id = ? AND (base_event_id IS NULL OR base_event_id <= ?)
					ORDER BY COALESCE(base_event_id, -1) DESC, id DESC LIMIT 1
				`)
				.get(this.boardId, targetEventId) as CheckpointRow | undefined
		}
		if (!checkpointRow) throw new Error('No checkpoint is available for this historical target')
		const checkpoint = checkpointFromRow(checkpointRow)
		const baseEventId = checkpoint.baseEventId ?? 0
		const eventRows = targetEventId === null
			? []
			: (this.database
					.prepare(`
						SELECT * FROM history_events
						WHERE board_id = ? AND id > ? AND id <= ? ORDER BY id ASC
					`)
					.all(this.boardId, baseEventId, targetEventId) as EventRow[])
		const events = eventRows.map(eventFromRow)
		const snapshot = applyHistoryEvents(checkpoint.snapshot, events)
		return {
			snapshot,
			targetEventId,
			baseCheckpointId: checkpoint.id,
			appliedEventIds: events.map((event) => event.id),
		}
	}

	prepareRestore(input: {
		target: HistoricalTarget
		currentSnapshot: RoomSnapshot
		actorUserId: string
		source?: HistorySource
		sessionId?: string | null
		createdAt?: number
	}): RestorePreparation {
		return this.atomic(() => {
			this.flushFragments({ force: true })
			const targetState = this.reconstruct(input.target)
			const restoreId = randomUUID()
			const startedEvent = this.insertEvent({
				actorUserId: input.actorUserId,
				sessionId: input.sessionId,
				eventType: 'restore.started',
				entityType: 'board',
				entityId: this.boardId,
				source: input.source ?? 'human',
				createdAt: input.createdAt,
				metadata: { restoreId, target: input.target },
				documentClock: input.currentSnapshot.documentClock ?? null,
			})
			const preRestoreCheckpoint = this.insertCheckpoint({
				snapshot: input.currentSnapshot,
				createdBy: input.actorUserId,
				createdAt: input.createdAt,
				baseEventId: startedEvent.id,
				reason: 'pre_restore',
				label: 'Before restore',
			})
			return { restoreId, target: input.target, targetState, preRestoreCheckpoint, startedEvent }
		})
	}

	completeRestore(input: {
		restoreId: string
		beforeSnapshot: RoomSnapshot
		restoredSnapshot: RoomSnapshot
		actorUserId: string
		source?: HistorySource
		sessionId?: string | null
		target: HistoricalTarget
		createdAt?: number
	}): { completedEvent: HistoryEvent; checkpoint: HistoryCheckpoint } {
		return this.atomic(() => {
			this.flushFragments({ force: true })
			const completedEvent = this.insertEvent({
				actorUserId: input.actorUserId,
				sessionId: input.sessionId,
				eventType: 'restore.completed',
				entityType: 'board',
				entityId: this.boardId,
				source: input.source ?? 'human',
				createdAt: input.createdAt,
				metadata: { restoreId: input.restoreId, target: input.target },
				changes: changesBetweenSnapshots(input.beforeSnapshot, input.restoredSnapshot),
				documentClock: input.restoredSnapshot.documentClock ?? null,
			})
			const checkpoint = this.insertCheckpoint({
				snapshot: input.restoredSnapshot,
				createdBy: input.actorUserId,
				createdAt: input.createdAt,
				baseEventId: completedEvent.id,
				reason: 'restore_completed',
				label: 'Restored version',
			})
			return { completedEvent, checkpoint }
		})
	}
}

export function applyHistoryEvents(baseSnapshot: RoomSnapshot, events: readonly HistoryEvent[]): RoomSnapshot {
	const snapshot = validateSnapshot(baseSnapshot)
	const documents = new Map<string, RoomSnapshot['documents'][number]>(
		snapshot.documents.map((entry) => [entry.state.id, entry])
	)
	const tombstones = { ...(snapshot.tombstones ?? {}) }
	let documentClock = snapshot.documentClock ?? 0
	for (const event of events) {
		const changeClock = event.documentClock ?? documentClock + 1
		for (const change of event.changes) {
			const current = documents.get(change.recordId)?.state ?? null
			if (!isDeepStrictEqual(current, change.before)) {
				throw new Error(`History divergence before event ${event.id}, record ${change.recordId}`)
			}
			if (change.after === null) {
				documents.delete(change.recordId)
				tombstones[change.recordId] = changeClock
			} else {
				documents.set(change.recordId, {
					state: cloneJson(change.after),
					lastChangedClock: changeClock,
				})
				delete tombstones[change.recordId]
			}
		}
		documentClock = Math.max(documentClock, changeClock)
	}
	return {
		...snapshot,
		clock: Math.max(snapshot.clock ?? 0, documentClock),
		documentClock,
		documents: [...documents.values()],
		tombstones,
	}
}

export interface BoardHistoryRecorderOptions {
	store: BoardHistoryStore
	getSnapshot: () => RoomSnapshot
	coalesceMs?: number
	snapshotEveryEvents?: number
	snapshotEveryMs?: number
	initializeLegacy?: boolean
	now?: () => number
}

/** Scheduling convenience around BoardHistoryStore; storage writes remain synchronous. */
export class BoardHistoryRecorder {
	private readonly store: BoardHistoryStore
	private readonly getSnapshot: () => RoomSnapshot
	private readonly coalesceMs: number
	private readonly snapshotEveryEvents: number
	private readonly snapshotEveryMs: number
	private readonly now: () => number
	private timer: ReturnType<typeof setTimeout> | null = null
	private eventsAtLastSnapshot: number
	private lastSnapshotAt: number

	constructor(options: BoardHistoryRecorderOptions) {
		this.store = options.store
		this.getSnapshot = options.getSnapshot
		this.coalesceMs = options.coalesceMs ?? DEFAULT_COALESCE_MS
		this.snapshotEveryEvents = options.snapshotEveryEvents ?? DEFAULT_SNAPSHOT_EVENT_INTERVAL
		this.snapshotEveryMs = options.snapshotEveryMs ?? DEFAULT_SNAPSHOT_TIME_INTERVAL
		this.now = options.now ?? Date.now
		// A prior process may have committed fragments and died before its debounce fired.
		this.store.flushFragments({ force: true })
		if (options.initializeLegacy ?? true) this.store.ensureLegacyImportCheckpoint(this.getSnapshot(), this.now())
		this.eventsAtLastSnapshot = this.store.latestEventId() ?? 0
		this.lastSnapshotAt = this.store.listCheckpoints(1)[0]?.createdAt ?? this.now()
	}

	recordHumanFragment(input: Omit<HistoryFragmentInput, 'source' | 'flushAfter'>): HistoryFragment {
		const createdAt = input.createdAt ?? this.now()
		const fragment = this.store.appendFragment({
			...input,
			source: 'human',
			createdAt,
			flushAfter: createdAt + this.coalesceMs,
		})
		this.scheduleFlush()
		return fragment
	}

	recordHumanCommittedDiff(
		input: Omit<HistoryFragmentInput, 'source' | 'flushAfter' | 'changes'> & {
			diff: TLSyncForwardDiff<TLRecord>
			beforeSnapshot: RoomSnapshot
		}
	): HistoryFragment {
		const { diff, beforeSnapshot, ...event } = input
		return this.recordHumanFragment({
			...event,
			changes: changesFromForwardDiff(diff, beforeSnapshot),
		})
	}

	recordSynchronousEvent(input: HistoryEventInput): HistoryEvent {
		if (this.timer) clearTimeout(this.timer)
		this.timer = null
		// Flush pending edits without checkpointing yet. The snapshot callback observes the live
		// room, which may already include this immediate mutation; checkpoint only after its event.
		this.store.flushFragments({ force: true })
		const event = this.store.appendEvent(input)
		this.maybeCheckpoint()
		return event
	}

	flush(): HistoryEvent[] {
		if (this.timer) clearTimeout(this.timer)
		this.timer = null
		const events = this.store.flushFragments({ force: true })
		if (events.length) this.maybeCheckpoint()
		return events
	}

	dispose(): void {
		this.flush()
	}

	private scheduleFlush(): void {
		if (this.timer) clearTimeout(this.timer)
		this.timer = setTimeout(() => this.flush(), this.coalesceMs)
		this.timer.unref?.()
	}

	private maybeCheckpoint(): void {
		const latestId = this.store.latestEventId() ?? 0
		const now = this.now()
		if (
			latestId - this.eventsAtLastSnapshot < this.snapshotEveryEvents &&
			now - this.lastSnapshotAt < this.snapshotEveryMs
		) return
		this.store.createCheckpoint({
			snapshot: this.getSnapshot(),
			baseEventId: latestId || null,
			createdAt: now,
			reason: 'periodic',
		})
		this.eventsAtLastSnapshot = latestId
		this.lastSnapshotAt = now
	}
}
