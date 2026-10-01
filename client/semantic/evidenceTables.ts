import { evidenceTableSchema, EVIDENCE_TABLE_LIMITS, type EvidenceTable, type EvidenceTableSummary } from '../../shared/evidence-tables'
import { apiRequest } from '../auth'

export interface CreateEvidenceTableResult {
	uploadId: string
	summary: EvidenceTableSummary
}

/** Validates and stores a table artifact through the new, authorized, size/shape-checked route. */
export function createEvidenceTable(boardId: string, table: EvidenceTable): Promise<CreateEvidenceTableResult> {
	return apiRequest<CreateEvidenceTableResult>(`/api/boards/${encodeURIComponent(boardId)}/evidence-tables`, {
		method: 'POST',
		body: JSON.stringify(table),
	})
}

/**
 * Fetches a table artifact through the *existing, unchanged* authorized asset route. Defensive by
 * design (DeepSeek review finding #1/#6 disposition, docs/development/structured-evidence-design.md):
 * a reference can in principle point at something that isn't a valid table (the server never
 * verifies this at entity-write time), so this never lets a malformed or oversized response reach
 * JSON.parse/the renderer uncaught - it throws a plain Error with a message meant for display,
 * not a raw parse exception.
 */
export async function fetchEvidenceTable(boardId: string, uploadId: string): Promise<EvidenceTable> {
	const response = await fetch(`/api/boards/${encodeURIComponent(boardId)}/assets/${encodeURIComponent(uploadId)}`, { credentials: 'same-origin' })
	if (!response.ok) throw new Error(response.status === 404 ? 'That table artifact could not be found.' : `Could not load the table (status ${response.status}).`)
	const text = await response.text()
	if (text.length > EVIDENCE_TABLE_LIMITS.maxSerializedBytes * 2) {
		// A generous margin over the creation-time limit, not the exact limit: an artifact this
		// feature didn't create (see the defensive-reading rationale above) could be any size.
		throw new Error('This artifact is too large to display as a table here.')
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(text)
	} catch {
		throw new Error('This artifact is not valid JSON, so it cannot be shown as a table.')
	}
	const result = evidenceTableSchema.safeParse(parsed)
	if (!result.success) throw new Error('This artifact does not match the expected table shape.')
	return result.data
}

export interface ParsedCsv {
	table: EvidenceTable
	warnings: string[]
}

function slugifyColumnKey(header: string, index: number, seen: Set<string>): string {
	let key = header.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')
	if (!key || !/^[a-z]/.test(key)) key = `col_${key || index}`
	let candidate = key
	let suffix = 2
	while (seen.has(candidate)) { candidate = `${key}_${suffix}`; suffix += 1 }
	seen.add(candidate)
	return candidate
}

function parseCsvCell(raw: string): string | number {
	const trimmed = raw.trim()
	if (trimmed !== '' && Number.isFinite(Number(trimmed))) return Number(trimmed)
	return trimmed
}

/**
 * A deliberately narrow CSV import: the first line is headers, every other line is one row,
 * cells split on a plain comma. No quoting/escaping support (a comma inside a cell value will
 * misparse) - documented in docs/development/structured-evidence-design.md as an accepted V1
 * limitation, since the actual use case (numeric simulation sweep tables) doesn't need it.
 */
export function parseCsvToTable(text: string): ParsedCsv {
	const warnings: string[] = []
	const lines = text.split('\n').map((line) => line.replace(/\r$/, '')).filter((line) => line.trim() !== '')
	if (lines.length === 0) throw new Error('Paste at least a header row and one data row.')
	const headers = lines[0].split(',').map((header) => header.trim())
	const seenKeys = new Set<string>()
	const columns = headers.map((header, index) => ({ key: slugifyColumnKey(header, index, seenKeys), label: header || `Column ${index + 1}` }))
	const rows = lines.slice(1).map((line, lineIndex) => {
		const cells = line.split(',')
		if (cells.length !== columns.length) {
			warnings.push(`Row ${lineIndex + 1} has ${cells.length} cell(s), expected ${columns.length}; extra cells were dropped and missing ones left blank.`)
		}
		const row: Record<string, string | number> = {}
		columns.forEach((column, index) => {
			const raw = cells[index]
			if (raw !== undefined && raw.trim() !== '') row[column.key] = parseCsvCell(raw)
		})
		return row
	})
	return { table: { version: 1, columns, rows }, warnings }
}
