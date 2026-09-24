import type { RoomSnapshot } from '@tldraw/sync-core'
import type { TLRecord } from '@tldraw/tlschema'

export const HISTORY_SOURCES = ['human', 'ai', 'system'] as const
export type HistorySource = (typeof HISTORY_SOURCES)[number]

export const HISTORY_EVENT_TYPES = [
	'board.created',
	'board.imported',
	'board.renamed',
	'board.deleted',
	'board.restored',
	'user.joined',
	'user.left',
	'object.created',
	'object.edited',
	'object.moved',
	'object.deleted',
	'object.restored',
	'entity.created',
	'entity.updated',
	'entity.deleted',
	'ai.requested',
	'ai.suggestion_generated',
	'ai.suggestion_accepted',
	'ai.suggestion_rejected',
	'ai.request_cancelled',
	'ai.object_created',
	'permissions.changed',
	'collaborator.added',
	'collaborator.removed',
	'checkpoint.created',
	'restore.started',
	'restore.completed',
	'restore.failed',
] as const

export type KnownHistoryEventType = (typeof HISTORY_EVENT_TYPES)[number]

/** Known values are documented above, but namespaced application-specific values are allowed. */
export type HistoryEventType = KnownHistoryEventType | (string & {})

export type HistoryMetadata = Record<string, unknown>

/**
 * A replayable record mutation. Both sides are complete tldraw records, not patches.
 * A null `before` denotes creation and a null `after` denotes deletion.
 */
export interface HistoryRecordChange {
	recordId: string
	before: TLRecord | null
	after: TLRecord | null
}

export interface HistoryEventInput {
	actorUserId?: string | null
	sessionId?: string | null
	eventType: HistoryEventType
	entityType?: string | null
	entityId?: string | null
	source: HistorySource
	createdAt?: number
	metadata?: HistoryMetadata
	changes?: readonly HistoryRecordChange[]
	documentClock?: number | null
}

export interface HistoryEvent extends Required<Omit<HistoryEventInput, 'createdAt' | 'metadata' | 'changes'>> {
	id: number
	boardId: string
	createdAt: number
	metadata: HistoryMetadata
	changes: HistoryRecordChange[]
}

export interface HistoryFragmentInput extends HistoryEventInput {
	/** Repeated fragments with the same attribution and key can be collapsed into one event. */
	coalesceKey?: string
	/** Earliest time at which this fragment's group may be finalized. */
	flushAfter?: number
}

export interface HistoryFragment extends HistoryEvent {
	coalesceGroup: string
	flushAfter: number
}

export interface HistoryEventFilters {
	userId?: string
	source?: HistorySource | readonly HistorySource[]
	eventType?: HistoryEventType | readonly HistoryEventType[]
	entityType?: string
	entityId?: string
	from?: number
	to?: number
	after?: number
	before?: number
	order?: 'asc' | 'desc'
	limit?: number
}

export interface HistoryEventPage {
	events: HistoryEvent[]
	nextCursor: number | null
}

export type CheckpointReason =
	| 'legacy_import'
	| 'periodic'
	| 'explicit'
	| 'pre_restore'
	| 'restore_completed'
	| (string & {})

export interface HistoryCheckpointInput {
	snapshot: RoomSnapshot
	createdBy?: string | null
	createdAt?: number
	baseEventId?: number | null
	label?: string | null
	reason: CheckpointReason
}

export interface HistoryCheckpoint {
	id: number
	boardId: string
	createdAt: number
	createdBy: string | null
	baseEventId: number | null
	label: string | null
	reason: CheckpointReason
	snapshot: RoomSnapshot
}

export interface HistoryCheckpointSummary extends Omit<HistoryCheckpoint, 'snapshot'> {}

export type HistoricalTarget =
	| { eventId: number }
	| { checkpointId: number }
	| { timestamp: number }

export interface ReconstructedBoardState {
	snapshot: RoomSnapshot
	targetEventId: number | null
	baseCheckpointId: number | null
	appliedEventIds: number[]
}

export interface RestorePreparation {
	restoreId: string
	target: HistoricalTarget
	targetState: ReconstructedBoardState
	preRestoreCheckpoint: HistoryCheckpoint
	startedEvent: HistoryEvent
}
