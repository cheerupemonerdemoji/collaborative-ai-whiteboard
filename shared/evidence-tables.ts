import { z } from 'zod'

/**
 * A structured result table for Evidence.kind === 'table'. Stored as a validated JSON artifact
 * through the existing board-scoped asset system (see docs/development/structured-evidence-design.md
 * for the full design and why this reuses that system rather than inventing a parallel one).
 *
 * The Evidence semantic entity holds meaning/provenance/interpretation (kind, reference, note,
 * tableSummary); this schema holds the actual measured rows. The server never dereferences
 * Evidence.reference to enforce this correspondence - that boundary is deliberate and documented.
 */
export const EVIDENCE_TABLE_LIMITS = {
	maxColumns: 20,
	maxRows: 2_000,
	maxCellStringLength: 200,
	maxColumnKeyLength: 60,
	maxColumnLabelLength: 100,
	maxUnitLength: 20,
	maxSerializedBytes: 500_000,
	/** A count cap on the new evidence-tables route specifically (server/app.ts), not a general
	 * asset quota - see the design doc's DeepSeek review disposition for finding #3. */
	maxTableArtifactsPerBoard: 200,
} as const

const columnKey = z
	.string()
	.min(1)
	.max(EVIDENCE_TABLE_LIMITS.maxColumnKeyLength)
	.regex(/^[A-Za-z][A-Za-z0-9_]*$/, 'Column keys must start with a letter and contain only letters, digits, and underscores')

const evidenceTableColumn = z.object({
	key: columnKey,
	label: z.string().min(1).max(EVIDENCE_TABLE_LIMITS.maxColumnLabelLength),
	unit: z.string().min(1).max(EVIDENCE_TABLE_LIMITS.maxUnitLength).optional(),
}).strict()

const evidenceTableCell = z.union([
	z.string().max(EVIDENCE_TABLE_LIMITS.maxCellStringLength),
	z.number().finite(),
	z.boolean(),
	z.null(),
])

export const evidenceTableSchema = z.object({
	version: z.literal(1),
	columns: z
		.array(evidenceTableColumn)
		.min(1)
		.max(EVIDENCE_TABLE_LIMITS.maxColumns)
		.refine((columns) => new Set(columns.map((column) => column.key)).size === columns.length, 'Column keys must be unique'),
	// Rows may be sparse (a cell can be absent, meaning blank) but must never reference a column
	// that wasn't declared - that's checked in the superRefine below, where the full column set
	// is in scope, not in a per-row schema that can't see it.
	rows: z.array(z.record(z.string(), evidenceTableCell)).max(EVIDENCE_TABLE_LIMITS.maxRows),
}).strict().superRefine((table, ctx) => {
	const validKeys = new Set(table.columns.map((column) => column.key))
	table.rows.forEach((row, rowIndex) => {
		for (const key of Object.keys(row)) {
			if (!validKeys.has(key)) {
				ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Unknown column "${key}"`, path: ['rows', rowIndex, key] })
			}
		}
	})
})

export type EvidenceTable = z.infer<typeof evidenceTableSchema>
export type EvidenceTableColumn = z.infer<typeof evidenceTableColumn>

export interface EvidenceTableSummary {
	rows: number
	columns: string[]
}

export function summaryForTable(table: EvidenceTable): EvidenceTableSummary {
	return { rows: table.rows.length, columns: table.columns.map((column) => column.label) }
}

/** Matches the safe upload-id pattern the asset routes already enforce (server/app.ts). */
export function evidenceTableArtifactId(uuid: string): string {
	return `evidence-table-${uuid}.json`
}
