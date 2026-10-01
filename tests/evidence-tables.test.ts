/**
 * Structured Evidence V1: the evidenceTableSchema itself, the new
 * POST /api/boards/:boardId/evidence-tables route (authorization, validation, limits, the
 * artifact-count cap), and the semantic-entity side (tableSummary through create/update,
 * semantic-context, history, checkpoint/restore). See docs/development/structured-evidence-design.md
 * for the design this verifies.
 */
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AuthDatabase } from '../server/auth-db'
import { EVIDENCE_TABLE_LIMITS, evidenceTableSchema, summaryForTable } from '../shared/evidence-tables'
import { createAcceptanceFixture, type AcceptanceFixture } from './helpers/acceptance-fixture'

/* ------------------------------------------------------------------- schema validation -- */

const validTable = {
	version: 1 as const,
	columns: [
		{ key: 'frequency_hz', label: 'Frequency', unit: 'Hz' },
		{ key: 'support_margin_mm', label: 'Support margin', unit: 'mm' },
		{ key: 'result', label: 'Result' },
	],
	rows: [
		{ frequency_hz: 0.16, support_margin_mm: 5.22, result: 'PASS' },
		{ frequency_hz: 0.17, support_margin_mm: 4.95, result: 'FAIL' },
	],
}

describe('evidenceTableSchema', () => {
	it('accepts a well-formed table', () => {
		expect(() => evidenceTableSchema.parse(validTable)).not.toThrow()
	})

	it('accepts a sparse row (a cell may be absent - blank, not an error)', () => {
		const table = { ...validTable, rows: [{ frequency_hz: 0.16 }] }
		expect(() => evidenceTableSchema.parse(table)).not.toThrow()
	})

	it('rejects a row referencing an undeclared column', () => {
		const table = { ...validTable, rows: [{ frequency_hz: 0.16, made_up_column: 1 }] }
		expect(() => evidenceTableSchema.parse(table)).toThrow(/Unknown column/)
	})

	it('rejects duplicate column keys', () => {
		const table = { ...validTable, columns: [...validTable.columns, { key: 'frequency_hz', label: 'Duplicate' }] }
		expect(() => evidenceTableSchema.parse(table)).toThrow(/unique/i)
	})

	it('rejects a column key that is not a safe identifier', () => {
		const table = { ...validTable, columns: [{ key: '1bad key', label: 'x' }], rows: [] }
		expect(() => evidenceTableSchema.parse(table)).toThrow()
	})

	it('rejects zero columns', () => {
		expect(() => evidenceTableSchema.parse({ version: 1, columns: [], rows: [] })).toThrow()
	})

	it('rejects more than the column limit', () => {
		const columns = Array.from({ length: EVIDENCE_TABLE_LIMITS.maxColumns + 1 }, (_, index) => ({ key: `c${index}`, label: `C${index}` }))
		expect(() => evidenceTableSchema.parse({ version: 1, columns, rows: [] })).toThrow()
	})

	it('rejects more than the row limit', () => {
		const rows = Array.from({ length: EVIDENCE_TABLE_LIMITS.maxRows + 1 }, () => ({ frequency_hz: 1 }))
		expect(() => evidenceTableSchema.parse({ ...validTable, rows })).toThrow()
	})

	it('rejects a non-finite cell value (schema requires a finite number, like genericScalar elsewhere)', () => {
		const table = { ...validTable, rows: [{ frequency_hz: Number.POSITIVE_INFINITY }] }
		expect(() => evidenceTableSchema.parse(table)).toThrow()
	})

	it('rejects an unrecognized extra top-level key (.strict())', () => {
		expect(() => evidenceTableSchema.parse({ ...validTable, extra: true })).toThrow()
	})

	it('rejects malformed JSON shape entirely (e.g. rows as a non-array)', () => {
		expect(() => evidenceTableSchema.parse({ ...validTable, rows: 'not an array' })).toThrow()
	})

	it('summaryForTable reports row count and column labels', () => {
		expect(summaryForTable(evidenceTableSchema.parse(validTable))).toEqual({ rows: 2, columns: ['Frequency', 'Support margin', 'Result'] })
	})
})

/* --------------------------------------------------------- the evidence-tables HTTP route -- */

const fixtures: AcceptanceFixture[] = []
async function fixture() { const built = await createAcceptanceFixture(); fixtures.push(built); return built }
afterEach(async () => { for (const built of fixtures.splice(0)) await built.cleanup() })

describe('POST /api/boards/:boardId/evidence-tables', () => {
	it('editor can create a table artifact and gets back its id and server-computed summary', async () => {
		const f = await fixture()
		const response = await f.editor.post(`/api/boards/${f.boardId}/evidence-tables`, validTable)
		expect(response.statusCode).toBe(201)
		const body = response.json()
		expect(body.uploadId).toMatch(/^evidence-table-[0-9a-f-]+\.json$/)
		expect(body.summary).toEqual({ rows: 2, columns: ['Frequency', 'Support margin', 'Result'] })
	})

	it('owner can create a table artifact', async () => {
		const f = await fixture()
		expect((await f.owner.post(`/api/boards/${f.boardId}/evidence-tables`, validTable)).statusCode).toBe(201)
	})

	it('viewer is denied (403), nonmember is denied (404), anonymous is denied (401)', async () => {
		const f = await fixture()
		expect((await f.viewer.post(`/api/boards/${f.boardId}/evidence-tables`, validTable)).statusCode).toBe(403)
		expect((await f.nonmember.post(`/api/boards/${f.boardId}/evidence-tables`, validTable)).statusCode).toBe(404)
		expect((await f.anonymous.post(`/api/boards/${f.boardId}/evidence-tables`, validTable)).statusCode).toBe(401)
	})

	it('a malformed table is rejected with 422 and itemized details, server-side, not just client-side', async () => {
		const f = await fixture()
		const response = await f.editor.post(`/api/boards/${f.boardId}/evidence-tables`, { version: 1, columns: [], rows: [] })
		expect(response.statusCode).toBe(422)
		expect(response.json().details).toBeTruthy()
	})

	it('a body that is not shaped like a table at all is rejected with 422, not an unhandled 500 - a diff-review finding, verified false here', async () => {
		const f = await fixture()
		const response = await f.editor.post(`/api/boards/${f.boardId}/evidence-tables`, { not: 'a table', columns: 'nope', rows: 42 })
		expect(response.statusCode).toBe(422)
	})

	it('an oversized table (over maxRows) is rejected', async () => {
		const f = await fixture()
		const rows = Array.from({ length: EVIDENCE_TABLE_LIMITS.maxRows + 1 }, () => ({ frequency_hz: 1 }))
		const response = await f.editor.post(`/api/boards/${f.boardId}/evidence-tables`, { ...validTable, rows })
		expect(response.statusCode).toBe(422)
	})

	it('the created artifact is readable through the existing, unchanged asset GET route by any board member', async () => {
		const f = await fixture()
		const { uploadId } = (await f.editor.post(`/api/boards/${f.boardId}/evidence-tables`, validTable)).json()
		const ownerRead = await f.owner.get(`/api/boards/${f.boardId}/assets/${uploadId}`)
		expect(ownerRead.statusCode).toBe(200)
		expect(evidenceTableSchema.parse(JSON.parse(ownerRead.body))).toBeTruthy()
		const viewerRead = await f.viewer.get(`/api/boards/${f.boardId}/assets/${uploadId}`)
		expect(viewerRead.statusCode).toBe(200)
		const nonmemberRead = await f.nonmember.get(`/api/boards/${f.boardId}/assets/${uploadId}`)
		expect(nonmemberRead.statusCode).toBe(404)
	})

	it('a second fixture (a different board) cannot read the first board\'s artifact - cross-board isolation via the existing asset authorization', async () => {
		const f1 = await fixture()
		const f2 = await fixture()
		const { uploadId } = (await f1.editor.post(`/api/boards/${f1.boardId}/evidence-tables`, validTable)).json()
		const crossRead = await f2.owner.get(`/api/boards/${f1.boardId}/assets/${uploadId}`)
		expect(crossRead.statusCode).toBe(404) // f2's owner is not a member of f1's board at all
	})
})

/* -------------------------------------------------------------------- artifact count cap -- */

describe('countBoardAssetsWithPrefix (the artifact-count cap\'s counting mechanism)', () => {
	it('counts only assets under the given board and prefix, not other assets or other boards', async () => {
		const f = await fixture()
		const secondBoard = await f.owner.post('/api/boards', { name: 'Second board', id: 'second-board' })
		expect(secondBoard.statusCode).toBe(200)

		await f.editor.post(`/api/boards/${f.boardId}/evidence-tables`, validTable)
		await f.editor.post(`/api/boards/${f.boardId}/evidence-tables`, validTable)
		await f.editor.request('POST', `/api/boards/${f.boardId}/uploads/not-a-table.bin`, Buffer.from('x'), { 'content-type': 'application/octet-stream' })
		await f.owner.post('/api/boards/second-board/evidence-tables', validTable)
		// A second connection to the same fixture's auth.sqlite, read-only in effect here -
		// this is a white-box check of the counting primitive itself (not a public HTTP route),
		// safe because better-sqlite3 supports multiple connections to one WAL-mode file.
		const database = new AuthDatabase(join(f.directory, 'auth.sqlite'))
		try {
			expect(database.countBoardAssetsWithPrefix(f.boardId, 'evidence-table-')).toBe(2)
			expect(database.countBoardAssetsWithPrefix('second-board', 'evidence-table-')).toBe(1)
			expect(database.countBoardAssetsWithPrefix(f.boardId, 'nonexistent-prefix-')).toBe(0)
		} finally {
			database.close()
		}
	})

	it('registerBoardAssetIfUnderCap is atomic: it refuses and does not insert once the cap is reached', async () => {
		const f = await fixture()
		const database = new AuthDatabase(join(f.directory, 'auth.sqlite'))
		try {
			expect(database.registerBoardAssetIfUnderCap(f.boardId, 'evidence-table-a.json', 'evidence-table-', 1)).toBe(true)
			expect(database.countBoardAssetsWithPrefix(f.boardId, 'evidence-table-')).toBe(1)
			// The cap (1) is now reached; a second attempt must be refused and must not insert.
			expect(database.registerBoardAssetIfUnderCap(f.boardId, 'evidence-table-b.json', 'evidence-table-', 1)).toBe(false)
			expect(database.countBoardAssetsWithPrefix(f.boardId, 'evidence-table-')).toBe(1)
		} finally {
			database.close()
		}
	})
})

/* --------------------------------------------- tableSummary through create/update/history -- */

describe('Evidence.tableSummary through the semantic action path', () => {
	it('create_entity accepts a first-class tableSummary (not routed through genericFields)', async () => {
		const f = await fixture()
		const { uploadId, summary } = (await f.editor.post(`/api/boards/${f.boardId}/evidence-tables`, validTable)).json()
		const response = await f.editor.post(`/api/rooms/${f.boardId}/actions`, {
			actions: [{ tool: 'create_entity', id: 'engineering_entity:evtable-1', entityType: 'evidence', title: 'A structured table', fields: { kind: 'table', reference: uploadId }, tableSummary: summary }],
		})
		expect(response.statusCode).toBe(200)
		const context = await f.editor.get(`/api/rooms/${f.boardId}/semantic-context`)
		const entity = context.json().entities.find((item: { id: string }) => item.id === 'engineering_entity:evtable-1')
		expect(entity.tableSummary).toEqual(summary)
		expect(entity.kind).toBe('table')
		expect(entity.reference).toBe(uploadId)
	})

	it('update_entity can repoint reference and tableSummary together to a new artifact, and both changes are attributed history', async () => {
		const f = await fixture()
		const first = (await f.editor.post(`/api/boards/${f.boardId}/evidence-tables`, validTable)).json()
		await f.editor.post(`/api/rooms/${f.boardId}/actions`, {
			actions: [{ tool: 'create_entity', id: 'engineering_entity:evtable-2', entityType: 'evidence', title: 'Versioned table', fields: { kind: 'table', reference: first.uploadId }, tableSummary: first.summary }],
		})
		const second = (await f.editor.post(`/api/boards/${f.boardId}/evidence-tables`, { ...validTable, rows: [...validTable.rows, { frequency_hz: 0.18, support_margin_mm: 4.83, result: 'FAIL' }] })).json()
		const update = await f.editor.post(`/api/rooms/${f.boardId}/actions`, {
			actions: [{ tool: 'update_entity', id: 'engineering_entity:evtable-2', fields: { reference: second.uploadId }, tableSummary: second.summary }],
		})
		expect(update.statusCode).toBe(200)
		const context = await f.owner.get(`/api/rooms/${f.boardId}/semantic-context`)
		const entity = context.json().entities.find((item: { id: string }) => item.id === 'engineering_entity:evtable-2')
		expect(entity.reference).toBe(second.uploadId)
		expect(entity.tableSummary.rows).toBe(3)
		// The superseded artifact is untouched and still readable - immutability, not overwritten.
		const oldStillReadable = await f.owner.get(`/api/boards/${f.boardId}/assets/${first.uploadId}`)
		expect(oldStillReadable.statusCode).toBe(200)
		const history = await f.owner.get(`/api/boards/${f.boardId}/history`)
		expect(history.json().events.map((event: { eventType: string }) => event.eventType)).toEqual(expect.arrayContaining(['entity.created', 'entity.updated']))
	})

	it('viewer cannot create or update a table-bearing Evidence entity through the action path either', async () => {
		const f = await fixture()
		const { uploadId, summary } = (await f.editor.post(`/api/boards/${f.boardId}/evidence-tables`, validTable)).json()
		const response = await f.viewer.post(`/api/rooms/${f.boardId}/actions`, {
			actions: [{ tool: 'create_entity', id: 'engineering_entity:evtable-viewer-blocked', entityType: 'evidence', title: 'x', fields: { kind: 'table', reference: uploadId }, tableSummary: summary }],
		})
		expect(response.statusCode).toBe(403)
	})

	it('tableSummary on a non-evidence entity is a clean 422, not an unhandled 500 - a diff-review finding, verified false here', async () => {
		// The action schema accepts tableSummary on any entityType (it isn't worth a discriminated
		// per-type action schema for one optional field), but componentEntity's own .strict() schema
		// has no tableSummary key, so this fails exactly like any other unmodeled field does -
		// already-proven behavior (see the ENTITY_FIELD_SPECS drift-guard tests) - and the server's
		// existing global error handler turns that ZodError into a normal 422, the same as every
		// other direct `.parse()` call in this codebase (e.g. createBoardSchema.parse, registerSchema.parse).
		const f = await fixture()
		const response = await f.editor.post(`/api/rooms/${f.boardId}/actions`, {
			actions: [{ tool: 'create_entity', id: 'engineering_entity:bad-table-summary', entityType: 'component', title: 'x', tableSummary: { rows: 1, columns: ['a'] } }],
		})
		expect(response.statusCode).toBe(422)
	})
})

/* -------------------------------------------------- checkpoint/restore: the design's claim -- */

describe('checkpoint/restore: an old checkpoint resolves to the artifact that was live at that moment, not a newer one', () => {
	it('restoring a pre-update checkpoint brings back the old reference/tableSummary, and the old artifact is still readable', async () => {
		const f = await fixture()
		const first = (await f.editor.post(`/api/boards/${f.boardId}/evidence-tables`, validTable)).json()
		await f.editor.post(`/api/rooms/${f.boardId}/actions`, {
			actions: [{ tool: 'create_entity', id: 'engineering_entity:evtable-restore', entityType: 'evidence', title: 'Restore check', fields: { kind: 'table', reference: first.uploadId }, tableSummary: first.summary }],
		})
		const checkpoint = await f.editor.post(`/api/boards/${f.boardId}/checkpoints`, { label: 'before table update' })
		expect(checkpoint.statusCode).toBe(200)

		const second = (await f.editor.post(`/api/boards/${f.boardId}/evidence-tables`, { ...validTable, rows: [{ frequency_hz: 0.19, support_margin_mm: 4.68, result: 'FAIL' }] })).json()
		await f.editor.post(`/api/rooms/${f.boardId}/actions`, {
			actions: [{ tool: 'update_entity', id: 'engineering_entity:evtable-restore', fields: { reference: second.uploadId }, tableSummary: second.summary }],
		})
		const afterUpdate = await f.owner.get(`/api/rooms/${f.boardId}/semantic-context`)
		expect(afterUpdate.json().entities.find((item: { id: string }) => item.id === 'engineering_entity:evtable-restore').reference).toBe(second.uploadId)

		const history = await f.owner.get(`/api/boards/${f.boardId}/history`)
		const checkpointEvent = history.json().events.find((event: { eventType: string }) => event.eventType === 'checkpoint.created')
		const canvas = await f.owner.get(`/api/rooms/${f.boardId}/canvas`)
		const restored = await f.editor.post(`/api/boards/${f.boardId}/restore`, { eventId: checkpointEvent.id, expectedClock: canvas.json().clock })
		expect(restored.statusCode).toBe(200)

		const afterRestore = await f.owner.get(`/api/rooms/${f.boardId}/semantic-context`)
		const restoredEntity = afterRestore.json().entities.find((item: { id: string }) => item.id === 'engineering_entity:evtable-restore')
		expect(restoredEntity.reference).toBe(first.uploadId) // back to the artifact live at checkpoint time, not the newer one
		expect(restoredEntity.tableSummary).toEqual(first.summary)

		// And that old artifact is genuinely still on disk and readable - immutability is what
		// makes the restored reference resolve to real, correct data rather than a dangling id.
		const oldArtifact = await f.owner.get(`/api/boards/${f.boardId}/assets/${first.uploadId}`)
		expect(oldArtifact.statusCode).toBe(200)
		expect(evidenceTableSchema.parse(JSON.parse(oldArtifact.body)).rows).toHaveLength(2)
	})
})

/* ----------------------------------------- cross-board isolation (security fix regression) -- */

/**
 * Regression for the production-acceptance-found defect: a user who legitimately belongs to two
 * boards could read Board A's artifact through Board B's route, and could attach a Board A
 * artifact to a Board B Evidence entity. Root cause and the fix itself:
 * docs/reviews/2026-10-01-cross-board-asset-isolation-root-cause.md. The fixture's own owner is
 * deliberately used as the "member of both boards" identity in every test below - that is exactly
 * the case the original bug required and the case client-side hiding cannot fix, since it is the
 * same authenticated, legitimate user in both requests.
 */
describe('cross-board artifact isolation (security fix regression)', () => {
	it('reading an artifact through a different board\'s route is rejected (404) even for a user who legitimately belongs to both boards', async () => {
		const f = await fixture()
		const boardB = await f.owner.post('/api/boards', { name: 'Board B', id: 'cross-board-b-read' })
		expect(boardB.statusCode).toBe(200)
		const { uploadId } = (await f.owner.post(`/api/boards/${f.boardId}/evidence-tables`, validTable)).json()

		const sameBoard = await f.owner.get(`/api/boards/${f.boardId}/assets/${uploadId}`)
		expect(sameBoard.statusCode).toBe(200)

		const crossBoard = await f.owner.get(`/api/boards/cross-board-b-read/assets/${uploadId}`)
		expect(crossBoard.statusCode).toBe(404)
	})

	it('creating a Board B Evidence entity that references a Board A artifact is rejected (404), not silently accepted', async () => {
		const f = await fixture()
		const boardB = await f.owner.post('/api/boards', { name: 'Board B', id: 'cross-board-b-create' })
		expect(boardB.statusCode).toBe(200)
		const { uploadId } = (await f.owner.post(`/api/boards/${f.boardId}/evidence-tables`, validTable)).json()

		const response = await f.owner.post('/api/rooms/cross-board-b-create/actions', {
			actions: [{ tool: 'create_entity', id: 'engineering_entity:cross-board-ref', entityType: 'evidence', title: 'Should be rejected', fields: { kind: 'table', reference: uploadId } }],
		})
		expect(response.statusCode).toBe(404)

		// Confirm it was genuinely rejected, not partially applied.
		const context = await f.owner.get('/api/rooms/cross-board-b-create/semantic-context')
		expect(context.json().entities).toEqual([])
	})

	it('updating a Board B Evidence entity to reference a Board A artifact is rejected (404), leaving the entity unchanged', async () => {
		const f = await fixture()
		const boardB = await f.owner.post('/api/boards', { name: 'Board B', id: 'cross-board-b-update' })
		expect(boardB.statusCode).toBe(200)
		const boardBTable = (await f.owner.post('/api/boards/cross-board-b-update/evidence-tables', validTable)).json()
		await f.owner.post('/api/rooms/cross-board-b-update/actions', {
			actions: [{ tool: 'create_entity', id: 'engineering_entity:cross-board-update', entityType: 'evidence', title: 'Legit Board B table', fields: { kind: 'table', reference: boardBTable.uploadId }, tableSummary: boardBTable.summary }],
		})
		const boardATable = (await f.owner.post(`/api/boards/${f.boardId}/evidence-tables`, validTable)).json()

		const response = await f.owner.post('/api/rooms/cross-board-b-update/actions', {
			actions: [{ tool: 'update_entity', id: 'engineering_entity:cross-board-update', fields: { reference: boardATable.uploadId } }],
		})
		expect(response.statusCode).toBe(404)

		const context = await f.owner.get('/api/rooms/cross-board-b-update/semantic-context')
		const entity = context.json().entities.find((item: { id: string }) => item.id === 'engineering_entity:cross-board-update')
		expect(entity.reference).toBe(boardBTable.uploadId) // unchanged - the rejected update left it alone
	})

	it('a same-board reference still works after the fix - no false positive from the new check', async () => {
		const f = await fixture()
		const { uploadId, summary } = (await f.editor.post(`/api/boards/${f.boardId}/evidence-tables`, validTable)).json()
		const create = await f.editor.post(`/api/rooms/${f.boardId}/actions`, {
			actions: [{ tool: 'create_entity', id: 'engineering_entity:same-board-ref', entityType: 'evidence', title: 'Fine', fields: { kind: 'table', reference: uploadId }, tableSummary: summary }],
		})
		expect(create.statusCode).toBe(200)
		const second = (await f.editor.post(`/api/boards/${f.boardId}/evidence-tables`, validTable)).json()
		const update = await f.editor.post(`/api/rooms/${f.boardId}/actions`, {
			actions: [{ tool: 'update_entity', id: 'engineering_entity:same-board-ref', fields: { reference: second.uploadId }, tableSummary: second.summary }],
		})
		expect(update.statusCode).toBe(200)
	})

	it('non-table evidence kinds are unaffected by the new check (reference stays opaque/unverified for every other kind, as designed)', async () => {
		const f = await fixture()
		const response = await f.editor.post(`/api/rooms/${f.boardId}/actions`, {
			actions: [{ tool: 'create_entity', id: 'engineering_entity:non-table-ref', entityType: 'evidence', title: 'Ordinary evidence', fields: { kind: 'url', reference: 'https://example.invalid/anything' } }],
		})
		expect(response.statusCode).toBe(200)
	})

	it('same-board Viewer reads still work, Viewer writes still fail, and nonmember gets 404 - unchanged by the fix', async () => {
		const f = await fixture()
		const { uploadId } = (await f.editor.post(`/api/boards/${f.boardId}/evidence-tables`, validTable)).json()
		expect((await f.viewer.get(`/api/boards/${f.boardId}/assets/${uploadId}`)).statusCode).toBe(200)
		expect((await f.viewer.post(`/api/boards/${f.boardId}/evidence-tables`, validTable)).statusCode).toBe(403)
		expect((await f.nonmember.get(`/api/boards/${f.boardId}/assets/${uploadId}`)).statusCode).toBe(404)
	})

	it('checkpoint/restore to an older same-board artifact still works after the fix', async () => {
		const f = await fixture()
		const first = (await f.editor.post(`/api/boards/${f.boardId}/evidence-tables`, validTable)).json()
		await f.editor.post(`/api/rooms/${f.boardId}/actions`, {
			actions: [{ tool: 'create_entity', id: 'engineering_entity:restore-after-fix', entityType: 'evidence', title: 'x', fields: { kind: 'table', reference: first.uploadId }, tableSummary: first.summary }],
		})
		const checkpoint = await f.editor.post(`/api/boards/${f.boardId}/checkpoints`, { label: 'cp' })
		const second = (await f.editor.post(`/api/boards/${f.boardId}/evidence-tables`, { ...validTable, rows: [{ frequency_hz: 0.2 }] })).json()
		await f.editor.post(`/api/rooms/${f.boardId}/actions`, {
			actions: [{ tool: 'update_entity', id: 'engineering_entity:restore-after-fix', fields: { reference: second.uploadId }, tableSummary: second.summary }],
		})
		expect(checkpoint.statusCode).toBe(200)
		const history = await f.owner.get(`/api/boards/${f.boardId}/history`)
		const checkpointEvent = history.json().events.find((event: { eventType: string }) => event.eventType === 'checkpoint.created')
		const canvas = await f.owner.get(`/api/rooms/${f.boardId}/canvas`)
		const restored = await f.editor.post(`/api/boards/${f.boardId}/restore`, { eventId: checkpointEvent.id, expectedClock: canvas.json().clock })
		expect(restored.statusCode).toBe(200)
		const afterRestore = await f.owner.get(`/api/rooms/${f.boardId}/semantic-context`)
		expect(afterRestore.json().entities.find((item: { id: string }) => item.id === 'engineering_entity:restore-after-fix').reference).toBe(first.uploadId)
	})
})
