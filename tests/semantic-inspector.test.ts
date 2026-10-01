/**
 * Focused tests for the Semantic Inspector V1 support code. The inspector UI itself has no
 * jsdom/React-Testing-Library harness in this project (none existed before this feature, and
 * adding one is out of proportion to a deliberately small V1) -- its actual rendering was
 * verified through real local and production browser sessions instead (see
 * docs/development/semantic-inspector.md). What is tested here, in the project's existing
 * vitest-node style, is everything the inspector depends on but does not itself render:
 *
 *  - `ENTITY_FIELD_SPECS` (shared/entities.ts) cannot silently drift out of sync with the real
 *    per-type Zod schemas it describes -- every spec key must actually be accepted, an unknown
 *    key must still be rejected, and a field marked `required` must actually be required.
 *  - the scalar-map textarea encoding the inspector uses for `parameters`/`metrics` round-trips.
 *  - the exact actions the inspector issues (create_entity/update_entity/link_entities/
 *    unlink_entities) go through the real HTTP action path with real RBAC and appear in real
 *    board history, using the same acceptance fixture the app-auth work already established.
 */
import { TLSocketRoom } from '@tldraw/sync-core'
import type { TLRecord } from '@tldraw/tlschema'
import { afterEach, describe, expect, it } from 'vitest'
import { applyRoomActions, readRoomSemantics, type SemanticActor } from '../server/canvas-api'
import { schema } from '../server/rooms'
import { ENTITY_FIELD_SPECS, ENTITY_TYPES } from '../shared/entities'
import { ApiError } from '../client/auth'
import { fieldsForSubmit } from '../client/semantic/SemanticInspectorPanel'
import { formatApiError, formatScalarMapText, parseScalarMapText } from '../client/semantic/semanticApi'
import { createAcceptanceFixture, type AcceptanceFixture } from './helpers/acceptance-fixture'

/* --------------------------------------------------------------- field-spec drift guard -- */

const rooms: TLSocketRoom<TLRecord, void>[] = []
afterEach(() => { rooms.forEach((instance) => instance.close()); rooms.length = 0 })
function room() { const instance = new TLSocketRoom<TLRecord, void>({ schema }); rooms.push(instance); return instance }
const actor: SemanticActor = { actorUserId: 'user:inspector-test', displayName: 'Inspector Test' }

describe('ENTITY_FIELD_SPECS matches the real per-type schema', () => {
	for (const entityType of ENTITY_TYPES) {
		it(`${entityType}: every spec field is accepted by create_entity`, () => {
			const instance = room()
			const fields: Record<string, unknown> = {}
			for (const spec of ENTITY_FIELD_SPECS[entityType]) {
				if (spec.kind === 'enum') fields[spec.key] = spec.options?.[0]
				else if (spec.kind === 'scalarMap') fields[spec.key] = { example: 1 }
				else fields[spec.key] = 'example value'
			}
			const id = `engineering_entity:spec-check-${entityType}`
			expect(() => applyRoomActions(instance, { actions: [{ tool: 'create_entity', id, entityType, title: 'Spec check', fields }] }, actor)).not.toThrow()
			const [entity] = readRoomSemantics(instance, { ids: [id] }).entities
			expect(entity.entityType).toBe(entityType)
		})

		it(`${entityType}: an unmodeled field key is rejected (the spec table cannot silently claim more than the schema accepts)`, () => {
			const instance = room()
			const id = `engineering_entity:drift-check-${entityType}`
			expect(() => applyRoomActions(instance, {
				actions: [{ tool: 'create_entity', id, entityType, title: 'Drift check', fields: { totallyMadeUpFieldName: 'x' } }],
			}, actor)).toThrow()
		})

		const requiredSpecs = ENTITY_FIELD_SPECS[entityType].filter((spec) => spec.required)
		if (requiredSpecs.length) {
			it(`${entityType}: omitting a field the spec marks required is rejected`, () => {
				const instance = room()
				const id = `engineering_entity:required-check-${entityType}`
				expect(() => applyRoomActions(instance, {
					actions: [{ tool: 'create_entity', id, entityType, title: 'Required check' }],
				}, actor)).toThrow()
			})
		}

		// The inverse of the check above: for every field the spec marks *not* required, omitting
		// just that one field (while providing every other spec field) must still succeed. This
		// catches the case the previous two checks miss - a field the real schema actually
		// requires, but that ENTITY_FIELD_SPECS mismarks as optional, which would otherwise make
		// the create form silently produce a 422 for a field the UI never told the user was needed.
		for (const spec of ENTITY_FIELD_SPECS[entityType].filter((candidate) => !candidate.required)) {
			it(`${entityType}: "${spec.key}" is genuinely optional - omitting only it still succeeds`, () => {
				const instance = room()
				const fields: Record<string, unknown> = {}
				for (const other of ENTITY_FIELD_SPECS[entityType]) {
					if (other.key === spec.key) continue
					if (other.kind === 'enum') fields[other.key] = other.options?.[0]
					else if (other.kind === 'scalarMap') fields[other.key] = { example: 1 }
					else fields[other.key] = 'example value'
				}
				const id = `engineering_entity:optional-check-${entityType}-${spec.key.toLowerCase()}`
				expect(() => applyRoomActions(instance, { actions: [{ tool: 'create_entity', id, entityType, title: 'Optional check', fields }] }, actor)).not.toThrow()
			})
		}
	}
})

describe('fieldsForSubmit: text/longText/scalarMap always send, enum omits when blank', () => {
	it('a blank text/longText field is sent as an explicit empty string, not omitted', () => {
		expect(fieldsForSubmit('component', { subsystem: '', description: '' })).toEqual({ subsystem: '', description: '' })
	})

	it('a blank scalarMap field is sent as an explicit empty object, not omitted', () => {
		const result = fieldsForSubmit('experiment', { objective: '', hypothesis: '', testType: '', parameters: '', metrics: '', passCriteria: '', result: '' })
		expect(result.parameters).toEqual({})
		expect(result.metrics).toEqual({})
	})

	it('a blank enum field is omitted - there is no valid "unset" value the server would accept', () => {
		const result = fieldsForSubmit('interface', { kind: '', description: '' })
		expect(result).not.toHaveProperty('kind')
		expect(result.description).toBe('')
	})

	it('a chosen enum value is sent through unchanged', () => {
		expect(fieldsForSubmit('interface', { kind: 'electrical', description: '' })).toEqual({ kind: 'electrical', description: '' })
	})
})

describe('editing can clear a previously-set field (regression: DeepSeek-flagged, verified, fixed)', () => {
	it('blanking a text field in the edit form actually clears it server-side, not just locally', () => {
		const instance = room()
		const id = 'engineering_entity:clear-check'
		applyRoomActions(instance, { actions: [{ tool: 'create_entity', id, entityType: 'component', title: 'Has a description', fields: { subsystem: 'balance', description: 'will be cleared' } }] }, actor)
		// This mirrors exactly what SemanticInspectorPanel's fieldsForSubmit now sends for a
		// blanked text field: the key present with an empty string, not omitted.
		applyRoomActions(instance, { actions: [{ tool: 'update_entity', id, fields: { description: '' } }] }, actor)
		const [entity] = readRoomSemantics(instance, { ids: [id] }).entities
		expect((entity as unknown as { description: string }).description).toBe('')
	})

	it('clearing a scalar-map field (parameters/metrics) actually empties it, not just leaves it unset', () => {
		const instance = room()
		const id = 'engineering_entity:clear-scalarmap-check'
		applyRoomActions(instance, { actions: [{ tool: 'create_entity', id, entityType: 'experiment', title: 'Has parameters', fields: { parameters: { seed: 7, amplitude_rad: 0.6 } } }] }, actor)
		applyRoomActions(instance, { actions: [{ tool: 'update_entity', id, fields: { parameters: {} } }] }, actor)
		const [entity] = readRoomSemantics(instance, { ids: [id] }).entities
		expect((entity as unknown as { parameters: unknown }).parameters).toEqual({})
	})
})

/* ------------------------------------------------------------------- scalar-map round trip -- */

describe('scalar-map textarea encoding', () => {
	it('parses key: value lines into typed scalars', () => {
		expect(parseScalarMapText('seed: 7\nfrequency_hz: 0.25\nnote: hello world\nflag: true\nabsent: null')).toEqual({
			seed: 7, frequency_hz: 0.25, note: 'hello world', flag: true, absent: null,
		})
	})

	it('ignores blank lines and trims whitespace around key/value', () => {
		expect(parseScalarMapText('\n  amplitude_rad : 0.60 \n\n  \n')).toEqual({ amplitude_rad: 0.60 })
	})

	it('round-trips format -> parse for a representative sweep-style record', () => {
		const original = { run_id: 'weight_shift_20260929T195024', seed: 7, duration_s: 8, passed: false }
		const text = formatScalarMapText(original)
		const parsed = parseScalarMapText(text)
		expect(parsed).toEqual(original)
	})
})

/* --------------------------------------------------------------------- error formatting -- */

describe('formatApiError', () => {
	it('extracts the real per-field message from a Zod validation failure, not the generic "Invalid request"', () => {
		// ApiError.details is the whole parsed response body (see apiRequest in client/auth.tsx),
		// and the server's ZodError branch sends { error: 'Invalid request', details: ZodIssue[] }
		// -- this reproduces that exact shape, which a real inspector submission hit live during
		// browser acceptance (a non-https evidence reference).
		const error = new ApiError('Invalid request', 422, {
			error: 'Invalid request',
			details: [{ path: ['reference'], message: 'Only https:// URLs are accepted as URL-shaped evidence references' }],
		})
		expect(formatApiError(error)).toBe('reference: Only https:// URLs are accepted as URL-shaped evidence references')
	})

	it('falls back to the plain message for a non-Zod error (e.g. CanvasApiError, which has no details array)', () => {
		const error = new ApiError('Entity ID already exists: engineering_entity:dup', 409, { error: 'Entity ID already exists: engineering_entity:dup' })
		expect(formatApiError(error)).toBe('Entity ID already exists: engineering_entity:dup')
	})
})

/* ------------------------------------------------------- inspector actions over real HTTP -- */

const fixtures: AcceptanceFixture[] = []
async function fixture() { const built = await createAcceptanceFixture(); fixtures.push(built); return built }
afterEach(async () => { for (const built of fixtures.splice(0)) await built.cleanup() })

describe('the exact actions the inspector issues, over the real action API', () => {
	it('editor can create, edit, and link/unlink through the same tool calls the inspector uses; viewer cannot', async () => {
		const f = await fixture()
		const create = await f.editor.post(`/api/rooms/${f.boardId}/actions`, {
			actions: [{ tool: 'create_entity', id: 'engineering_entity:insp-req', entityType: 'requirement', title: 'Inspector requirement', fields: { statement: 'must work' } }],
		})
		expect(create.statusCode).toBe(200)

		const viewerCreate = await f.viewer.post(`/api/rooms/${f.boardId}/actions`, {
			actions: [{ tool: 'create_entity', id: 'engineering_entity:insp-viewer-blocked', entityType: 'task', title: 'Should be blocked' }],
		})
		expect(viewerCreate.statusCode).toBe(403)

		const createComponent = await f.editor.post(`/api/rooms/${f.boardId}/actions`, {
			actions: [{ tool: 'create_entity', id: 'engineering_entity:insp-comp', entityType: 'component', title: 'Inspector component' }],
		})
		expect(createComponent.statusCode).toBe(200)

		const link = await f.editor.post(`/api/rooms/${f.boardId}/actions`, {
			actions: [{ tool: 'link_entities', id: 'engineering_entity:insp-comp', relationType: 'satisfies', targetId: 'engineering_entity:insp-req' }],
		})
		expect(link.statusCode).toBe(200)

		const viewerUnlink = await f.viewer.post(`/api/rooms/${f.boardId}/actions`, {
			actions: [{ tool: 'unlink_entities', id: 'engineering_entity:insp-comp', relationType: 'satisfies', targetId: 'engineering_entity:insp-req' }],
		})
		expect(viewerUnlink.statusCode).toBe(403)

		const unlink = await f.editor.post(`/api/rooms/${f.boardId}/actions`, {
			actions: [{ tool: 'unlink_entities', id: 'engineering_entity:insp-comp', relationType: 'satisfies', targetId: 'engineering_entity:insp-req' }],
		})
		expect(unlink.statusCode).toBe(200)

		const edit = await f.editor.post(`/api/rooms/${f.boardId}/actions`, {
			actions: [{ tool: 'update_entity', id: 'engineering_entity:insp-comp', title: 'Renamed via inspector', status: 'archived' }],
		})
		expect(edit.statusCode).toBe(200)

		// The default semantic-context read excludes archived entities (matching the app's
		// existing includeArchived filter), so the edit is checked with that filter set --
		// this is also the known V1 inspector limitation recorded in the design doc: without an
		// "include archived" toggle in the inspector itself, an archived entity silently drops
		// out of its list.
		const context = await f.owner.get(`/api/rooms/${f.boardId}/semantic-context?includeArchived=true`)
		const edited = context.json().entities.find((entity: { id: string }) => entity.id === 'engineering_entity:insp-comp')
		expect(edited).toMatchObject({ title: 'Renamed via inspector', status: 'archived', relations: [] })

		// Every mutation above must be real, attributed history, not a client-only illusion.
		const history = await f.owner.get(`/api/boards/${f.boardId}/history`)
		const eventTypes = history.json().events.map((event: { eventType: string }) => event.eventType)
		expect(eventTypes).toEqual(expect.arrayContaining(['entity.created', 'entity.updated']))

		// Viewer can still read everything the inspector's list/detail view would show.
		const viewerRead = await f.viewer.get(`/api/rooms/${f.boardId}/semantic-context`)
		expect(viewerRead.statusCode).toBe(200)
		expect(viewerRead.json().entities.map((entity: { id: string }) => entity.id)).toContain('engineering_entity:insp-req')
	})

	it('server validation errors (not client prediction) are what the inspector must surface: an invalid evidence kind is rejected with details', async () => {
		const f = await fixture()
		const response = await f.editor.post(`/api/rooms/${f.boardId}/actions`, {
			actions: [{ tool: 'create_entity', id: 'engineering_entity:insp-bad-evidence', entityType: 'evidence', title: 'Bad evidence', fields: { kind: 'not_a_real_kind', reference: 'x' } }],
		})
		expect(response.statusCode).toBe(422)
		expect(response.json().details).toBeTruthy()
	})

	it('a board with many existing semantic records of every type round-trips cleanly (regression for "board looks empty")', async () => {
		const f = await fixture()
		const actions = ENTITY_TYPES.map((entityType, index) => {
			const fields: Record<string, unknown> = {}
			for (const spec of ENTITY_FIELD_SPECS[entityType]) {
				if (spec.kind === 'enum') fields[spec.key] = spec.options?.[0]
				else if (spec.kind !== 'scalarMap') fields[spec.key] = `value ${index}`
			}
			return { tool: 'create_entity' as const, id: `engineering_entity:regression-${entityType}`, entityType, title: `Regression ${entityType}`, fields }
		})
		const created = await f.owner.post(`/api/rooms/${f.boardId}/actions`, { actions })
		expect(created.statusCode).toBe(200)
		const context = await f.owner.get(`/api/rooms/${f.boardId}/semantic-context`)
		expect(context.json().entities).toHaveLength(ENTITY_TYPES.length)
		expect(context.json().entities.map((entity: { entityType: string }) => entity.entityType).sort()).toEqual([...ENTITY_TYPES].sort())
	})
})
