import type { TLRecord } from '@tldraw/tlschema'
import { createTLStore, type TLAssetStore } from 'tldraw'
import { syncSchema } from '../../shared/schema'

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isTLRecord(value: unknown): value is TLRecord {
	return isRecord(value) && typeof value.id === 'string' && typeof value.typeName === 'string'
}

function parseSnapshot(value: unknown): unknown {
	if (typeof value !== 'string') return value
	try { return JSON.parse(value) as unknown } catch { return value }
}

/** Accepts history's {document: recordMap}, TLSocketRoom snapshots, or tldraw store snapshots. */
export function recordsFromSnapshot(input: unknown): TLRecord[] {
	const value = parseSnapshot(input)
	if (Array.isArray(value)) return value.filter(isTLRecord)
	if (!isRecord(value)) return []
	if ('snapshot' in value) return recordsFromSnapshot(value.snapshot)
	if (Array.isArray(value.documents)) {
		return value.documents.map((entry) => isRecord(entry) && 'state' in entry ? entry.state : entry).filter(isTLRecord)
	}
	if (isRecord(value.document)) {
		if (isRecord(value.document.store)) return Object.values(value.document.store).filter(isTLRecord)
		return Object.values(value.document).filter(isTLRecord)
	}
	if (isRecord(value.store)) return Object.values(value.store).filter(isTLRecord)
	return Object.values(value).filter(isTLRecord)
}

/**
 * Builds the read-only store behind a historical version. It must use the application schema:
 * a historical snapshot can contain `engineering_entity` records, and a store built from
 * tldraw's default schema rejects them at initialization.
 */
export function createHistoricalStore(snapshot: unknown, assets?: TLAssetStore) {
	const records = recordsFromSnapshot(snapshot)
	if (!records.length) throw new Error('This version does not contain a readable canvas snapshot.')
	const initialData = Object.fromEntries(records.map((record) => [record.id, record])) as Record<TLRecord['id'], TLRecord>
	return createTLStore({ initialData, schema: syncSchema, ...(assets ? { assets } : {}) })
}
