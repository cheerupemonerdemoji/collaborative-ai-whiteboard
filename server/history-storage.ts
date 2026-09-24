import type {
	RoomSnapshot,
	TLSyncStorage,
	TLSyncStorageOnChangeCallbackProps,
	TLSyncStorageTransactionCallback,
	TLSyncStorageTransactionOptions,
	TLSyncStorageTransactionResult,
} from '@tldraw/sync-core'
import type { TLRecord } from '@tldraw/tlschema'
import type Database from 'better-sqlite3'
import { isDeepStrictEqual } from 'node:util'
import type { HistoryMetadata, HistorySource } from '../shared/history'
import { BoardHistoryRecorder, changesBetweenSnapshots } from './history'

export interface HistoryWriteContext {
	actorUserId: string | null
	actorDisplayName: string
	sessionId?: string | null
	source: HistorySource
	eventType?: string
	metadata?: HistoryMetadata
	immediate?: boolean
	suppress?: boolean
}

function recordsChanged(before: RoomSnapshot, after: RoomSnapshot) {
	return changesBetweenSnapshots(before, after)
}

function isEntityChange(change: ReturnType<typeof recordsChanged>[number]): boolean {
	const typeName = (change.before?.typeName ?? change.after?.typeName) as string | undefined
	return typeName === 'engineering_entity'
}

function eventTypeForChanges(changes: ReturnType<typeof recordsChanged>): string {
	const allEntities = changes.length > 0 && changes.every(isEntityChange)
	if (changes.length && changes.every((change) => change.before === null)) return allEntities ? 'entity.created' : 'object.created'
	if (changes.length && changes.every((change) => change.after === null)) return allEntities ? 'entity.deleted' : 'object.deleted'
	if (allEntities) return 'entity.updated'
	if (changes.length && changes.every((change) => {
		if (change.before?.typeName !== 'shape' || change.after?.typeName !== 'shape') return false
		const before = change.before as unknown as Record<string, unknown>
		const after = change.after as unknown as Record<string, unknown>
		const { x: beforeX, y: beforeY, ...beforeRest } = before
		const { x: afterX, y: afterY, ...afterRest } = after
		return (beforeX !== afterX || beforeY !== afterY) && isDeepStrictEqual(beforeRest, afterRest)
	})) return 'object.moved'
	return 'object.edited'
}

/**
 * Adds an authenticated history boundary around tldraw's synchronous storage transaction.
 * History is inserted inside tldraw's existing better-sqlite3 transaction, so canvas state and
 * the durable fragment/event commit together without a nested BEGIN. A context set from
 * TLSocketRoom.onAfterReceiveMessage is consumed by the next synchronous storage transaction,
 * avoiding the session-less onCommittedChanges callback.
 */
export class HistorySyncStorage implements TLSyncStorage<TLRecord> {
	private nextContext: HistoryWriteContext | null = null

	constructor(
		private readonly delegate: TLSyncStorage<TLRecord>,
		_database: Database.Database,
		private readonly recorder: BoardHistoryRecorder
	) {}

	setNextContext(context: HistoryWriteContext): void {
		this.nextContext = context
	}

	withContext<T>(context: HistoryWriteContext, operation: () => T): T {
		const previous = this.nextContext
		this.nextContext = context
		try { return operation() }
		finally { this.nextContext = previous }
	}

	transaction<T>(
		callback: TLSyncStorageTransactionCallback<TLRecord, T>,
		opts?: TLSyncStorageTransactionOptions
	): TLSyncStorageTransactionResult<T, TLRecord> {
		const context = this.nextContext
		const before = context && !context.suppress ? this.delegate.getSnapshot?.() : undefined
		try {
			return this.delegate.transaction((txn) => {
				const result = callback(txn)
				const documentClock = txn.getClock()
				if (context && !context.suppress && before && documentClock > (before.documentClock ?? 0)) {
					const after = this.delegate.getSnapshot?.()
					if (after) {
						const changes = recordsChanged(before, after)
						const eventType = context.eventType ?? eventTypeForChanges(changes)
						const metadata = { actorDisplayName: context.actorDisplayName, ...(context.metadata ?? {}) }
						if (context.source === 'human' && !context.immediate) {
							this.recorder.recordHumanFragment({
								actorUserId: context.actorUserId,
								sessionId: context.sessionId,
								eventType,
								entityType: 'records',
								entityId: changes.length === 1 ? changes[0].recordId : null,
								coalesceKey: changes.map((change) => change.recordId).sort().join(','),
								metadata,
								changes,
								documentClock,
							})
						} else {
							this.recorder.recordSynchronousEvent({
								actorUserId: context.actorUserId,
								sessionId: context.sessionId,
								eventType,
								entityType: 'records',
								entityId: changes.length === 1 ? changes[0].recordId : null,
								source: context.source,
								metadata,
								changes,
								documentClock,
							})
						}
					}
				}
				return result
			}, opts)
		} finally {
			if (this.nextContext === context) this.nextContext = null
		}
	}

	/**
	 * Quiesce the wrapped storage's scheduled maintenance before its database
	 * handle is closed.
	 *
	 * `SQLiteSyncStorage` prunes tombstones on a trailing-edge throttle with a
	 * one-second window, so any write in the last second before a room closes
	 * leaves a timer armed. Nothing upstream cancels it: the storage exposes no
	 * close or dispose, and `TLSocketRoom.close()` does not reach into it. The
	 * timer then fires from the event loop against a connection we have already
	 * closed, and better-sqlite3 throws `The database connection is not open`.
	 * A timer callback has no caller to propagate to, so that surfaces as an
	 * uncaught exception rather than a rejected promise.
	 *
	 * We construct the delegate and we own the database handle, so quiescing it
	 * before closing is our responsibility. Flushing first performs the prune
	 * that was actually scheduled, while the connection is still valid;
	 * cancelling afterwards guarantees nothing remains armed. The cancel is what
	 * fixes the race - the flush only preserves the maintenance the throttle was
	 * there to perform.
	 *
	 * Pruning is opportunistic: it only acts once tombstones exceed a threshold,
	 * and it re-arms on the next write after the room reopens. A failure to
	 * prune must therefore never prevent a room from closing.
	 */
	dispose(): void {
		const scheduled = (this.delegate as { pruneTombstones?: unknown }).pruneTombstones
		if (typeof scheduled !== 'function') return
		const throttled = scheduled as { flush?(): void; cancel?(): void }
		try { throttled.flush?.() } catch { /* Opportunistic; closing must still proceed. */ }
		throttled.cancel?.()
	}

	getClock(): number { return this.delegate.getClock() }
	onChange(callback: (arg: TLSyncStorageOnChangeCallbackProps) => unknown): () => void { return this.delegate.onChange(callback) }
	getSnapshot(): RoomSnapshot { return this.delegate.getSnapshot!() }
	getObjectsSnapshot(): RoomSnapshot['documents'] { return this.delegate.getObjectsSnapshot?.() ?? [] }
	getObjectsByIds(ids: Iterable<string>): RoomSnapshot['documents'] { return this.delegate.getObjectsByIds?.(ids) ?? [] }
}
