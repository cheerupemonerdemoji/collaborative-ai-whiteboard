import { chmodSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
	loadSnapshotIntoStorage,
	NodeSqliteWrapper,
	SQLiteSyncStorage,
	TLSocketRoom,
	type WebSocketMinimal,
} from '@tldraw/sync-core'
import { createTLSchema, defaultShapeSchemas, type TLRecord } from '@tldraw/tlschema'
import Database from 'better-sqlite3'
import type { AccountEventRecord, BoardRole } from './auth-db'
import { BoardHistoryRecorder, BoardHistoryStore } from './history'
import { HistorySyncStorage, type HistoryWriteContext } from './history-storage'
import type { HistorySource } from '../shared/history'
import { engineeringEntitySchema } from '../shared/entities'

let roomDirectory = join(resolve(process.env.CANVAS_DATA_DIR ?? './data'), 'rooms')
mkdirSync(roomDirectory, { recursive: true })

/**
 * A single custom document-scoped record type carries all eight Chibi Robo entity types via
 * an internal `entityType` discriminant, rather than registering eight separate tldraw record
 * types. It rides the existing snapshot/sync/checkpoint/restore machinery for free, the same
 * way shape records do. See docs/reviews/2026-09-22-chibi-entity-design-deepseek.md.
 */
export const schema = createTLSchema({
	shapes: { ...defaultShapeSchemas },
	records: {
		engineering_entity: {
			scope: 'document',
			validator: { validate: (record: unknown) => engineeringEntitySchema.parse(record) },
		},
	},
})

export interface RoomSessionMeta {
	userId: string
	displayName: string
	role: BoardRole
	expiresAt?: number
}

export interface RoomHandle {
	boardId: string
	room: TLSocketRoom<TLRecord, RoomSessionMeta>
	database: Database.Database
	history: BoardHistoryStore
	recorder: BoardHistoryRecorder
	storage: HistorySyncStorage
	sessions: Map<string, RoomSessionMeta>
	expiryTimers: Map<string, ReturnType<typeof setTimeout>>
	closed: boolean
}

const rooms = new Map<string, RoomHandle>()
const idleTimers = new Map<string, ReturnType<typeof setTimeout>>()
let auditReader: ((boardId: string, after: number) => Array<AccountEventRecord & { actorDisplayName?: string }>) | null = null

export function configureRoomAuditReader(reader: typeof auditReader): void { auditReader = reader }

function projectAccountAudit(handle: RoomHandle): void {
	if (!auditReader) return
	const mapping: Record<string, string> = {
		'board.legacy_adopted': 'board.adopted', 'board.member_removed': 'collaborator.removed',
		'board.member_role_changed': 'permissions.changed', 'invitation.consumed': 'collaborator.added',
	}
	let cursor = (handle.database.prepare('SELECT last_id FROM history_account_audit_cursor WHERE board_id = ?').get(handle.boardId) as { last_id: number } | undefined)?.last_id ?? 0
	for (;;) {
		const events = auditReader(handle.boardId, cursor)
		if (!events.length) return
		handle.database.transaction(() => {
			for (const event of events) {
				handle.recorder.recordSynchronousEvent({
					eventType: mapping[event.type] ?? event.type, source: 'human',
					actorUserId: event.actorUserId ? `user:${event.actorUserId}` : null,
					entityType: 'board', entityId: handle.boardId, createdAt: Date.parse(event.createdAt),
					metadata: { ...JSON.parse(event.metadataJson), accountAuditId: event.eventId, subjectUserId: event.subjectUserId, actorDisplayName: event.actorDisplayName ?? 'A collaborator' },
					documentClock: handle.storage.getClock(),
				})
			}
			cursor = events[events.length - 1].id
			handle.database.prepare('INSERT INTO history_account_audit_cursor(board_id,last_id) VALUES (?,?) ON CONFLICT(board_id) DO UPDATE SET last_id=excluded.last_id').run(handle.boardId, cursor)
		})()
		if (events.length < 500) return
	}
}

function clearIdleTimer(roomId: string) {
	const timer = idleTimers.get(roomId)
	if (timer) clearTimeout(timer)
	idleTimers.delete(roomId)
}

function closeHandle(handle: RoomHandle) {
	if (handle.closed) return
	handle.closed = true
	for (const timer of handle.expiryTimers.values()) clearTimeout(timer)
	handle.expiryTimers.clear()
	clearIdleTimer(handle.boardId)
	handle.recorder.dispose()
	if (!handle.room.isClosed()) handle.room.close()
	// Storage schedules maintenance against this database, so it has to be
	// quiesced while the handle is still open. See HistorySyncStorage.dispose().
	handle.storage.dispose()
	if (handle.database.open) handle.database.close()
	rooms.delete(handle.boardId)
}

function scheduleIdleClose(handle: RoomHandle) {
	clearIdleTimer(handle.boardId)
	const timer = setTimeout(() => {
		idleTimers.delete(handle.boardId)
		if (handle.room.getNumActiveSessions() === 0 && !handle.room.isClosed()) closeHandle(handle)
	}, 5 * 60_000)
	timer.unref()
	idleTimers.set(handle.boardId, timer)
}

export function sanitizeRoomId(roomId: string): string {
	if (!/^[A-Za-z0-9_-]{1,80}$/.test(roomId)) throw new Error('Invalid room ID')
	return roomId
}

export function configureRoomDataDirectory(dataDirectory: string): void {
	if (rooms.size) throw new Error('Cannot change the room data directory while rooms are open')
	roomDirectory = join(resolve(dataDirectory), 'rooms')
	mkdirSync(roomDirectory, { recursive: true })
}

export function getRoomHandle(inputRoomId: string): RoomHandle {
	const boardId = sanitizeRoomId(inputRoomId)
	const existing = rooms.get(boardId)
	if (existing && !existing.room.isClosed()) {
		projectAccountAudit(existing)
		return existing
	}

	const databasePath = join(roomDirectory, `${boardId}.sqlite`)
	const database = new Database(databasePath)
	try { chmodSync(databasePath, 0o600) } catch { /* Windows ACLs remain authoritative. */ }
	database.pragma('journal_mode = WAL')
	database.pragma('foreign_keys = ON')
	const baseStorage = new SQLiteSyncStorage<TLRecord>({ sql: new NodeSqliteWrapper(database) })
	const history = new BoardHistoryStore(database, boardId)
	const recorder = new BoardHistoryRecorder({
		store: history,
		getSnapshot: () => baseStorage.getSnapshot!(),
		initializeLegacy: false,
	})
	const storage = new HistorySyncStorage(baseStorage, database, recorder)
	const sessions = new Map<string, RoomSessionMeta>()
	let handle!: RoomHandle
	const room = new TLSocketRoom<TLRecord, RoomSessionMeta>({
		schema,
		storage,
		onAfterReceiveMessage({ stringified, meta, sessionId }) {
			if (meta.expiresAt !== undefined && Date.now() >= meta.expiresAt) throw new Error('Session expired')
			let type: unknown
			try { type = (JSON.parse(stringified) as { type?: unknown }).type }
			catch { return }
			if (type !== 'push') return
			storage.setNextContext({
				actorUserId: `user:${meta.userId}`,
				actorDisplayName: meta.displayName,
				sessionId,
				source: 'human',
			})
		},
		onSessionRemoved(_currentRoom, args) {
			if (handle.closed) return
			clearTimeout(handle.expiryTimers.get(args.sessionId))
			handle.expiryTimers.delete(args.sessionId)
			sessions.delete(args.sessionId)
			recorder.recordSynchronousEvent({
				actorUserId: `user:${args.meta.userId}`,
				sessionId: args.sessionId,
				eventType: 'user.left',
				entityType: 'board',
				entityId: boardId,
				source: 'human',
				metadata: { actorDisplayName: args.meta.displayName },
				documentClock: storage.getClock(),
			})
			if (args.numSessionsRemaining === 0) {
				closeHandle(handle)
			}
			else scheduleIdleClose(handle)
		},
	})
	handle = { boardId, room, database, history, recorder, storage, sessions, expiryTimers: new Map(), closed: false }
	rooms.set(boardId, handle)
	history.ensureLegacyImportCheckpoint(room.getCurrentSnapshot())
	projectAccountAudit(handle)
	scheduleIdleClose(handle)
	return handle
}

/** Compatibility for compact canvas callers. */
export function makeOrLoadRoom(inputRoomId: string): TLSocketRoom<TLRecord, RoomSessionMeta> {
	return getRoomHandle(inputRoomId).room
}

export function connectRoomSocket(
	handle: RoomHandle,
	input: { sessionId: string; socket: WebSocketMinimal; userId: string; displayName: string; role: BoardRole; expiresAt?: number }
) {
	if (!/^[A-Za-z0-9_-]{8,160}$/.test(input.sessionId)) throw new Error('Invalid session ID')
	clearIdleTimer(handle.boardId)
	const meta: RoomSessionMeta = { userId: input.userId, displayName: input.displayName, role: input.role, expiresAt: input.expiresAt }
	handle.sessions.set(input.sessionId, meta)
	handle.recorder.recordSynchronousEvent({
		actorUserId: `user:${input.userId}`,
		sessionId: input.sessionId,
		eventType: 'user.joined',
		entityType: 'board',
		entityId: handle.boardId,
		source: 'human',
		metadata: { actorDisplayName: input.displayName, role: input.role },
		documentClock: handle.storage.getClock(),
	})
	handle.room.handleSocketConnect({
		sessionId: input.sessionId,
		socket: input.socket,
		isReadonly: input.role === 'viewer',
		objectAccess: input.role === 'viewer' ? 'read' : 'write',
		meta,
	})
	clearTimeout(handle.expiryTimers.get(input.sessionId))
	if (meta.expiresAt !== undefined) {
		const checkExpiry = () => {
			if (handle.closed || handle.sessions.get(input.sessionId) !== meta) return
			const remaining = meta.expiresAt! - Date.now()
			if (remaining <= 0) {
				handle.room.closeSession(input.sessionId, 'PERMISSION_DENIED')
				return
			}
			const timer = setTimeout(checkExpiry, Math.min(remaining, 2_147_483_647))
			timer.unref()
			handle.expiryTimers.set(input.sessionId, timer)
		}
		checkExpiry()
	}
}

export function withRoomHistory<T>(handle: RoomHandle, context: HistoryWriteContext, operation: () => T): T {
	return handle.storage.withContext(context, operation)
}

export function appendRoomEvent(handle: RoomHandle, input: Parameters<BoardHistoryRecorder['recordSynchronousEvent']>[0]) {
	return handle.recorder.recordSynchronousEvent(input)
}

export function createRoomCheckpoint(handle: RoomHandle, actor: { userId: string; displayName: string; actorUserId?: string; source?: HistorySource }, label?: string) {
	const actorId = actor.actorUserId ?? `user:${actor.userId}`
	handle.recorder.flush()
	const event = handle.history.appendEvent({
		actorUserId: actorId,
		eventType: 'checkpoint.created',
		entityType: 'board',
		entityId: handle.boardId,
		source: actor.source ?? 'human',
		metadata: { actorDisplayName: actor.displayName, label: label ?? null },
		documentClock: handle.storage.getClock(),
	})
	return handle.history.createCheckpoint({
		snapshot: handle.room.getCurrentSnapshot(),
		createdBy: actorId,
		baseEventId: event.id,
		reason: 'explicit',
		label: label ?? 'Manual checkpoint',
	})
}

export class RoomRestoreError extends Error {
	constructor(message: string, readonly statusCode: number) { super(message) }
}

export function restoreRoomVersion(
	handle: RoomHandle,
	input: { eventId: number; expectedClock: number; userId: string; displayName: string; sessionId?: string | null; actorUserId?: string; source?: HistorySource }
) {
	const actorId = input.actorUserId ?? `user:${input.userId}`
	handle.recorder.flush()
	const target = { eventId: input.eventId } as const
	return handle.storage.withContext({
			actorUserId: actorId,
			actorDisplayName: input.displayName,
			sessionId: input.sessionId,
			source: 'human',
			suppress: true,
		}, () => {
			const transaction = handle.storage.transaction((txn) => {
			if (txn.getClock() !== input.expectedClock) throw new RoomRestoreError('Board changed; refresh history and try again', 409)
			const before = handle.storage.getSnapshot()
			const preparation = handle.history.prepareRestore({
				target,
				currentSnapshot: before,
				actorUserId: actorId,
				source: input.source,
				sessionId: input.sessionId,
			})
			loadSnapshotIntoStorage(txn, schema, preparation.targetState.snapshot)
			const restored = handle.storage.getSnapshot()
			const completed = handle.history.completeRestore({
				restoreId: preparation.restoreId,
				beforeSnapshot: before,
				restoredSnapshot: restored,
				actorUserId: actorId,
				source: input.source,
				sessionId: input.sessionId,
				target,
			})
			return { restoreId: preparation.restoreId, event: completed.completedEvent, checkpoint: completed.checkpoint }
			})
			return { ...transaction.result, clock: transaction.documentClock }
		})
}

export function closeUserRoomSessions(boardId: string, userId: string): number {
	const handle = rooms.get(boardId)
	if (!handle || handle.room.isClosed()) return 0
	let closed = 0
	for (const [sessionId, meta] of handle.sessions) {
		if (meta.userId !== userId) continue
		handle.room.closeSession(sessionId, 'PERMISSION_DENIED')
		closed++
	}
	return closed
}

export function closeAllRooms(): void {
	for (const handle of [...rooms.values()]) closeHandle(handle)
}

export function closeUserSessions(userId: string): void {
	for (const boardId of [...rooms.keys()]) closeUserRoomSessions(boardId, userId)
}

export function closeBoardSessions(boardId: string): void {
	const handle = rooms.get(boardId)
	if (!handle || handle.closed) return
	for (const sessionId of [...handle.sessions.keys()]) handle.room.closeSession(sessionId, 'PERMISSION_DENIED')
}
