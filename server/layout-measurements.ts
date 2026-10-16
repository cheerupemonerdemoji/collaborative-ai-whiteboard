import type Database from 'better-sqlite3'
import { MEASURED_SHAPE_TYPES, layoutFingerprint, type Measurement } from '../shared/layout'

/**
 * Browser-reported sizes for shapes whose size only a DOM can measure (text and note labels). The table lives in the
 * board's own database but outside the tldraw document, so saving a measurement is not a board change: no history event,
 * no document-clock bump, nothing for other clients to sync. See `server/history.ts` migration `layout:0001-measurements`.
 *
 * A measurement is trusted only while the shape still has the content it measured: the server recomputes the fingerprint
 * from the current record and refuses a report whose fingerprint differs (the shape was edited in the meantime), so a
 * stale or forged measurement cannot masquerade as authoritative geometry for content it never described.
 */

export function readMeasurements(database: Database.Database): Map<string, Measurement> {
	const rows = database.prepare('SELECT shape_id AS id, w, h, fp FROM layout_measurements').all() as Measurement[]
	return new Map(rows.map((row) => [row.id, { id: row.id, w: row.w, h: row.h, fp: row.fp }]))
}

export interface MeasurementOutcome {
	accepted: number
	/** The shape's content changed since it was measured, so the report describes content that no longer exists. */
	stale: number
	/** No such shape, or a type whose size is not measured. */
	ignored: number
}

interface CurrentShape {
	id: string
	type: string
	props: Record<string, unknown>
}

/**
 * Saves the measurements that still match the current board. `current` is the board's shapes at this moment, so what is
 * accepted is checked against the record on the server, not against anything the browser claims.
 */
export function saveMeasurements(database: Database.Database, report: readonly Measurement[], current: ReadonlyMap<string, CurrentShape>, reportedBy: string, now: number = Date.now()): MeasurementOutcome {
	const outcome: MeasurementOutcome = { accepted: 0, stale: 0, ignored: 0 }
	const upsert = database.prepare(`
		INSERT INTO layout_measurements (shape_id, w, h, fp, reported_at, reported_by) VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(shape_id) DO UPDATE SET w = excluded.w, h = excluded.h, fp = excluded.fp, reported_at = excluded.reported_at, reported_by = excluded.reported_by
	`)
	const write = database.transaction(() => {
		for (const item of report) {
			const shape = current.get(item.id)
			if (!shape || !MEASURED_SHAPE_TYPES.has(shape.type)) { outcome.ignored += 1; continue }
			if (layoutFingerprint(shape) !== item.fp) { outcome.stale += 1; continue }
			upsert.run(item.id, item.w, item.h, item.fp, now, reportedBy)
			outcome.accepted += 1
		}
		// Measurements of shapes that no longer exist are dead weight; drop them with every report.
		const ids = [...current.keys()]
		if (ids.length === 0) database.exec('DELETE FROM layout_measurements')
		else {
			const known = new Set(ids)
			for (const row of database.prepare('SELECT shape_id AS id FROM layout_measurements').all() as Array<{ id: string }>) {
				if (!known.has(row.id)) database.prepare('DELETE FROM layout_measurements WHERE shape_id = ?').run(row.id)
			}
		}
	})
	write()
	return outcome
}
