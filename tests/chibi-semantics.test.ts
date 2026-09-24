import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { FastifyInstance } from 'fastify'
import WebSocket from 'ws'
import { TLSocketRoom, getTlsyncProtocolVersion } from '@tldraw/sync-core'
import type { TLRecord } from '@tldraw/tlschema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { canvasActionSchema } from '../shared/ai'
import { ENTITY_TYPES, RELATION_TYPES, SEMANTIC_CONTEXT_LIMITS, SEMANTIC_WRITE_LIMITS } from '../shared/entities'
import { applyRoomActions, CanvasApiError, readRoomCanvas, readRoomSemantics, type SemanticActor } from '../server/canvas-api'
import { schema } from '../server/rooms'
import {
	closeAllRooms,
	configureRoomDataDirectory,
	getRoomHandle,
	restoreRoomVersion,
	withRoomHistory,
} from '../server/rooms'
import { buildApp, type BuildAppOptions } from '../server/app'

/* -------------------------------------------------------- shared-schema pin -- */

describe('existing visual actions are unaffected', () => {
	it('pins the exact set and shape of canvasActionSchema tools (shared/ai.ts was not modified by this feature)', () => {
		const tools = (canvasActionSchema as unknown as { options: Array<{ shape: { tool: { value: string } } }> }).options
			.map((option) => option.shape.tool.value)
			.sort()
		expect(tools).toEqual(
			['connect_shapes', 'create_arrow', 'create_shape', 'create_text', 'delete_shape', 'move_shape', 'resize_shape', 'update_text'].sort()
		)
	})
})

/* --------------------------------------------------------- in-memory room -- */

const rooms: TLSocketRoom<TLRecord, void>[] = []
afterEach(() => { rooms.forEach((room) => room.close()); rooms.length = 0 })
function room() { const instance = new TLSocketRoom<TLRecord, void>({ schema }); rooms.push(instance); return instance }

const owner: SemanticActor = { actorUserId: 'user:owner', displayName: 'Owner' }

function createComponent(instance: TLSocketRoom<TLRecord, void>, id: string, overrides: Record<string, unknown> = {}) {
	return applyRoomActions(instance, { actions: [{ tool: 'create_entity', id, entityType: 'component', title: 'A component', ...overrides }] }, owner)
}

describe('engineering_entity: schema validation', () => {
	it('creates one of each of the eight entity discriminants', () => {
		const instance = room()
		for (const entityType of ENTITY_TYPES) {
			const id = `engineering_entity:${entityType}-sample`
			const extra = entityType === 'evidence' ? { fields: { kind: 'document', reference: 'design-notes-v1' } } : {}
			expect(() => applyRoomActions(instance, { actions: [{ tool: 'create_entity', id, entityType, title: `Sample ${entityType}`, ...extra }] }, owner)).not.toThrow()
		}
		const context = readRoomSemantics(instance, {})
		expect(context.entities.map((entity) => entity.entityType).sort()).toEqual([...ENTITY_TYPES].sort())
	})

	it('rejects an invalid entity type', () => {
		const instance = room()
		expect(() => applyRoomActions(instance, { actions: [{ tool: 'create_entity', id: 'engineering_entity:bad', entityType: 'widget', title: 'Nope' }] }, owner)).toThrow()
	})

	it('rejects a malformed relationship: unknown relation type and a dangling target', () => {
		const instance = room()
		createComponent(instance, 'engineering_entity:comp-a')
		expect(() => applyRoomActions(instance, { actions: [
			{ tool: 'link_entities', id: 'engineering_entity:comp-a', relationType: 'orbits', targetId: 'engineering_entity:comp-a' },
		] }, owner)).toThrow()
		expect(() => applyRoomActions(instance, { actions: [
			{ tool: 'link_entities', id: 'engineering_entity:comp-a', relationType: 'contains', targetId: 'engineering_entity:does-not-exist' },
		] }, owner)).toThrow(CanvasApiError)
	})

	it('keeps entity IDs stable and separate from shape: IDs', () => {
		const instance = room()
		const result = createComponent(instance, 'engineering_entity:left-leg-servo')
		expect(result.applied).toBe(1)
		const [entity] = readRoomSemantics(instance, {}).entities
		expect(entity.id).toBe('engineering_entity:left-leg-servo')
		expect(entity.id.startsWith('engineering_entity:')).toBe(true)
		expect(entity.id.startsWith('shape:')).toBe(false)
	})

	it('leaves an ordinary board with zero semantic records fully functional', () => {
		const instance = room()
		applyRoomActions(instance, { actions: [{ tool: 'create_text', id: 'shape:plain', text: 'just a shape', x: 0, y: 0 }] }, owner)
		expect(readRoomCanvas(instance).objects).toHaveLength(1)
		expect(readRoomSemantics(instance, {}).entities).toEqual([])
	})

	it('mixes a visual action and a semantic action in one atomic batch', () => {
		const instance = room()
		applyRoomActions(instance, { actions: [
			{ tool: 'create_text', id: 'shape:anchor', text: 'Left leg', x: 0, y: 0 },
			{ tool: 'create_entity', id: 'engineering_entity:left-leg', entityType: 'component', title: 'Left leg', shapeId: 'shape:anchor' },
		] }, owner)
		expect(readRoomCanvas(instance).objects).toHaveLength(1)
		expect(readRoomSemantics(instance, {}).entities[0]).toMatchObject({ shapeId: 'shape:anchor' })
	})
})

describe('experiment validation', () => {
	it('accepts a well-formed experiment with bounded parameters/metrics and a valid testType', () => {
		const instance = room()
		expect(() => applyRoomActions(instance, { actions: [{
			tool: 'create_entity', id: 'engineering_entity:balance-test-04', entityType: 'experiment', title: 'Standing Balance Test 04',
			fields: { objective: 'Verify standing balance', hypothesis: 'Lower CoG improves stability', testType: 'physical', parameters: { trials: 5, surface: 'foam' }, metrics: { wobbleDeg: 3.2 }, passCriteria: 'wobble < 5deg' },
		}] }, owner)).not.toThrow()
	})

	it('rejects an invalid testType', () => {
		const instance = room()
		expect(() => applyRoomActions(instance, { actions: [{
			tool: 'create_entity', id: 'engineering_entity:bad-test', entityType: 'experiment', title: 'Bad', fields: { testType: 'astrological' },
		}] }, owner)).toThrow()
	})

	it('records an experiment result through the dedicated action and reflects it in fields.result', () => {
		const instance = room()
		applyRoomActions(instance, { actions: [{ tool: 'create_entity', id: 'engineering_entity:exp-1', entityType: 'experiment', title: 'Balance test' }] }, owner)
		applyRoomActions(instance, { actions: [{ tool: 'record_experiment_result', id: 'engineering_entity:exp-1', result: 'PASS: wobble 3.2deg', status: 'completed' }] }, owner)
		const [entity] = readRoomSemantics(instance, { ids: ['engineering_entity:exp-1'] }).entities
		expect(entity).toMatchObject({ status: 'completed', result: 'PASS: wobble 3.2deg' })
	})
})

describe('evidence reference validation', () => {
	it('accepts an https URL and a plain code-path reference', () => {
		const instance = room()
		expect(() => applyRoomActions(instance, { actions: [
			{ tool: 'create_entity', id: 'engineering_entity:ev-url', entityType: 'evidence', title: 'Design doc', fields: { kind: 'url', reference: 'https://example.invalid/doc' } },
			{ tool: 'create_entity', id: 'engineering_entity:ev-path', entityType: 'evidence', title: 'Firmware file', fields: { kind: 'file_path', reference: 'firmware/balance_controller.c' } },
		] }, owner)).not.toThrow()
	})

	it('rejects a non-https URL scheme and a control-character reference', () => {
		const instance = room()
		expect(() => applyRoomActions(instance, { actions: [{ tool: 'create_entity', id: 'engineering_entity:ev-bad', entityType: 'evidence', title: 'Bad', fields: { kind: 'url', reference: 'javascript:alert(1)' } }] }, owner)).toThrow()
		expect(() => applyRoomActions(instance, { actions: [{ tool: 'create_entity', id: 'engineering_entity:ev-bad2', entityType: 'evidence', title: 'Bad', fields: { kind: 'file_path', reference: 'oops\x00null' } }] }, owner)).toThrow()
	})

	it('attach_evidence links an experiment to an evidence entity and refuses linking to a non-evidence entity', () => {
		const instance = room()
		applyRoomActions(instance, { actions: [
			{ tool: 'create_entity', id: 'engineering_entity:exp-2', entityType: 'experiment', title: 'Exp' },
			{ tool: 'create_entity', id: 'engineering_entity:ev-2', entityType: 'evidence', title: 'Log', fields: { kind: 'document', reference: 'log-2026-09-22' } },
			{ tool: 'create_entity', id: 'engineering_entity:comp-2', entityType: 'component', title: 'Not evidence' },
		] }, owner)
		applyRoomActions(instance, { actions: [{ tool: 'attach_evidence', id: 'engineering_entity:exp-2', evidenceId: 'engineering_entity:ev-2' }] }, owner)
		const [exp] = readRoomSemantics(instance, { ids: ['engineering_entity:exp-2'] }).entities
		expect(exp.relations).toEqual([{ type: 'supported_by', targetId: 'engineering_entity:ev-2' }])
		expect(() => applyRoomActions(instance, { actions: [{ tool: 'attach_evidence', id: 'engineering_entity:exp-2', evidenceId: 'engineering_entity:comp-2' }] }, owner)).toThrow(CanvasApiError)
	})
})

describe('relationships and one-hop traversal', () => {
	it('link_entities and unlink_entities are idempotent and reversible', () => {
		const instance = room()
		createComponent(instance, 'engineering_entity:a')
		createComponent(instance, 'engineering_entity:b')
		applyRoomActions(instance, { actions: [{ tool: 'link_entities', id: 'engineering_entity:a', relationType: 'connects_to', targetId: 'engineering_entity:b' }] }, owner)
		applyRoomActions(instance, { actions: [{ tool: 'link_entities', id: 'engineering_entity:a', relationType: 'connects_to', targetId: 'engineering_entity:b' }] }, owner) // duplicate is a no-op
		expect(readRoomSemantics(instance, { ids: ['engineering_entity:a'] }).entities[0].relations).toHaveLength(1)
		applyRoomActions(instance, { actions: [{ tool: 'unlink_entities', id: 'engineering_entity:a', relationType: 'connects_to', targetId: 'engineering_entity:b' }] }, owner)
		expect(readRoomSemantics(instance, { ids: ['engineering_entity:a'] }).entities[0].relations).toEqual([])
	})

	it('relationsFor returns both outgoing and incoming one-hop edges, and referenced neighbor summaries', () => {
		const instance = room()
		createComponent(instance, 'engineering_entity:hub')
		createComponent(instance, 'engineering_entity:leaf-out')
		createComponent(instance, 'engineering_entity:leaf-in')
		applyRoomActions(instance, { actions: [{ tool: 'link_entities', id: 'engineering_entity:hub', relationType: 'contains', targetId: 'engineering_entity:leaf-out' }] }, owner)
		applyRoomActions(instance, { actions: [{ tool: 'link_entities', id: 'engineering_entity:leaf-in', relationType: 'depends_on', targetId: 'engineering_entity:hub' }] }, owner)
		const context = readRoomSemantics(instance, { relationsFor: 'engineering_entity:hub' })
		expect(context.relationships).toEqual(expect.arrayContaining([
			{ from: 'engineering_entity:hub', type: 'contains', to: 'engineering_entity:leaf-out' },
			{ from: 'engineering_entity:leaf-in', type: 'depends_on', to: 'engineering_entity:hub' },
		]))
		expect(context.referenced.map((entity) => entity.id).sort()).toEqual(['engineering_entity:leaf-in', 'engineering_entity:leaf-out'])
		// a two-hop neighbor (leaf-out's own relations) must not appear -- one-hop only
		expect(context.relationships.every((edge) => edge.from === 'engineering_entity:hub' || edge.to === 'engineering_entity:hub')).toBe(true)
	})

	it('deleting is archive-only, so relation targets are never dangling', () => {
		const instance = room()
		createComponent(instance, 'engineering_entity:risky-target')
		createComponent(instance, 'engineering_entity:pointer')
		applyRoomActions(instance, { actions: [{ tool: 'link_entities', id: 'engineering_entity:pointer', relationType: 'blocks', targetId: 'engineering_entity:risky-target' }] }, owner)
		applyRoomActions(instance, { actions: [{ tool: 'update_status', id: 'engineering_entity:risky-target', status: 'archived' }] }, owner)
		// archived by default is excluded from a plain read, but the relation is never broken
		expect(readRoomSemantics(instance, {}).entities.map((entity) => entity.id)).not.toContain('engineering_entity:risky-target')
		const withArchived = readRoomSemantics(instance, { includeArchived: true })
		expect(withArchived.entities.map((entity) => entity.id)).toContain('engineering_entity:risky-target')
		expect(readRoomSemantics(instance, { ids: ['engineering_entity:pointer'] }).entities[0].relations).toEqual([{ type: 'blocks', targetId: 'engineering_entity:risky-target' }])
	})

	it('every RELATION_TYPES value round-trips through link_entities', () => {
		const instance = room()
		createComponent(instance, 'engineering_entity:src')
		createComponent(instance, 'engineering_entity:dst')
		for (const relationType of RELATION_TYPES) {
			expect(() => applyRoomActions(instance, { actions: [{ tool: 'link_entities', id: 'engineering_entity:src', relationType, targetId: 'engineering_entity:dst' }] }, owner)).not.toThrow()
		}
		expect(readRoomSemantics(instance, { ids: ['engineering_entity:src'] }).entities[0].relations).toHaveLength(RELATION_TYPES.length)
	})
})

describe('compact semantic context: read/write budgets', () => {
	it('fails explicitly rather than silently truncating when a selection exceeds the entity cap', () => {
		const instance = room()
		for (let index = 0; index < SEMANTIC_CONTEXT_LIMITS.maxEntities + 1; index++) {
			createComponent(instance, `engineering_entity:bulk-${index}`)
		}
		expect(() => readRoomSemantics(instance, {})).toThrow(CanvasApiError)
	})

	it('rejects a single entity whose serialized size exceeds the per-record write budget', () => {
		const instance = room()
		const hugeDescription = 'x'.repeat(SEMANTIC_WRITE_LIMITS.maxEntityBytes)
		expect(() => applyRoomActions(instance, { actions: [{
			tool: 'create_entity', id: 'engineering_entity:huge', entityType: 'component', title: 'Huge', fields: { description: hugeDescription },
		}] }, owner)).toThrow()
	})

	it('filters by entityTypes and status', () => {
		const instance = room()
		createComponent(instance, 'engineering_entity:c1', { status: 'active' })
		createComponent(instance, 'engineering_entity:c2', { status: 'deprecated' })
		applyRoomActions(instance, { actions: [{ tool: 'create_entity', id: 'engineering_entity:r1', entityType: 'requirement', title: 'Req' }] }, owner)
		const activeComponents = readRoomSemantics(instance, { entityTypes: ['component'], status: ['active'] })
		expect(activeComponents.entities.map((entity) => entity.id)).toEqual(['engineering_entity:c1'])
	})
})

describe('multiplayer synchronization', () => {
	it('broadcasts a semantically-created entity to another connected client', async () => {
		const instance = room()
		const inbound: string[] = []
		const socket = { readyState: 1, send: (data: string) => inbound.push(data), close: () => {} }
		instance.handleSocketConnect({ sessionId: 'viewer-socket', socket: socket as never, isReadonly: true })
		instance.handleSocketMessage('viewer-socket', JSON.stringify({
			type: 'connect', connectRequestId: 'viewer-socket', lastServerClock: 0,
			protocolVersion: getTlsyncProtocolVersion(), schema: schema.serialize(),
		}))
		applyRoomActions(instance, { actions: [{ tool: 'create_entity', id: 'engineering_entity:live', entityType: 'component', title: 'Live-created' }] }, owner)
		await new Promise((resolve) => setTimeout(resolve, 50))
		expect(inbound.join('')).toContain('engineering_entity:live')
	})
})

/* --------------------------------------------- history, checkpoint, restore -- */

describe('history attribution and checkpoint/restore of semantic state', () => {
	let directory: string
	beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'chibi-semantics-history-')); configureRoomDataDirectory(directory) })
	afterEach(() => { closeAllRooms(); rmSync(directory, { recursive: true, force: true }) })

	it('records entity.created / entity.updated history events with human and AI attribution', () => {
		const handle = getRoomHandle('board')
		withRoomHistory(handle, { actorUserId: 'user:owner', actorDisplayName: 'Owner', source: 'human' }, () =>
			applyRoomActions(handle.room, { actions: [{ tool: 'create_entity', id: 'engineering_entity:tracked', entityType: 'component', title: 'Tracked' }] }, owner))
		withRoomHistory(handle, { actorUserId: 'token:sim-agent', actorDisplayName: 'Simulation Agent', source: 'ai' }, () =>
			applyRoomActions(handle.room, { actions: [{ tool: 'update_status', id: 'engineering_entity:tracked', status: 'active' }] }, { actorUserId: 'token:sim-agent', displayName: 'Simulation Agent' }))
		const events = handle.history.listEvents().events
		expect(events).toEqual(expect.arrayContaining([
			expect.objectContaining({ eventType: 'entity.created', actorUserId: 'user:owner', source: 'human' }),
			expect.objectContaining({ eventType: 'entity.updated', actorUserId: 'token:sim-agent', source: 'ai' }),
		]))
	})

	it('restore rolls back a semantic entity while a pre-restore checkpoint preserves it, and restored state survives reopen', () => {
		const handle = getRoomHandle('board')
		const baseline = handle.history.latestEventId()!
		withRoomHistory(handle, { actorUserId: 'user:owner', actorDisplayName: 'Owner', source: 'human' }, () =>
			applyRoomActions(handle.room, { actions: [{ tool: 'create_entity', id: 'engineering_entity:will-be-reverted', entityType: 'component', title: 'Temp' }] }, owner))
		const priorClock = handle.storage.getClock()
		expect(readRoomSemantics(handle.room, {}).entities.map((entity) => entity.id)).toContain('engineering_entity:will-be-reverted')

		restoreRoomVersion(handle, { eventId: baseline, expectedClock: priorClock, userId: 'owner', displayName: 'Owner' })
		expect(readRoomSemantics(handle.room, {}).entities.map((entity) => entity.id)).not.toContain('engineering_entity:will-be-reverted')

		const preserved = handle.history.listCheckpoints().find((checkpoint) => checkpoint.reason === 'pre_restore')!
		expect(handle.history.getCheckpoint(preserved.id)!.snapshot.documents.some((entry) => entry.state.id === 'engineering_entity:will-be-reverted')).toBe(true)

		closeAllRooms()
		const reopened = getRoomHandle('board')
		expect(readRoomSemantics(reopened.room, {}).entities.map((entity) => entity.id)).not.toContain('engineering_entity:will-be-reverted')
	})
})

/* ------------------------------------------------------------------- RBAC -- */

describe('board-role and AI-token authorization for semantic actions', () => {
	const cleanupDirectories: string[] = []
	const apps: FastifyInstance[] = []
	const previousTokenFile = process.env.CANVAS_API_TOKENS_FILE

	afterEach(async () => {
		for (const app of apps.splice(0)) { try { await app.close() } catch { /* already closed */ } }
		for (const directory of cleanupDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
		if (previousTokenFile === undefined) delete process.env.CANVAS_API_TOKENS_FILE
		else process.env.CANVAS_API_TOKENS_FILE = previousTokenFile
	})

	async function createApp(prepare: (directory: string) => void = () => {}, rateLimits?: BuildAppOptions['rateLimits']) {
		const directory = mkdtempSync(join(tmpdir(), 'chibi-semantics-app-'))
		cleanupDirectories.push(directory)
		prepare(directory)
		mkdirSync(join(directory, 'client'), { recursive: true })
		writeFileSync(join(directory, 'client', 'index.html'), '<!doctype html><html><body>canvas</body></html>')
		const app = await buildApp({ dataDirectory: directory, clientDirectory: join(directory, 'client'), logger: false, rateLimits })
		const originalInject = app.inject.bind(app)
		app.inject = ((options: Parameters<FastifyInstance['inject']>[0]) => {
			if (typeof options === 'string') return originalInject(options)
			const method = String(options.method ?? 'GET').toUpperCase()
			const mutates = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE'
			return originalInject({ ...options, headers: { ...(mutates ? { origin: 'http://127.0.0.1:8787' } : {}), ...options.headers } })
		}) as FastifyInstance['inject']
		apps.push(app)
		return { directory, app }
	}

	async function registerOwner(app: FastifyInstance, login = 'Owner') {
		const response = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { login, displayName: 'Board Owner', password: 'correct horse battery staple' } })
		const cookie = response.cookies[0]
		return { body: response.json(), cookie: `${cookie.name}=${cookie.value}` }
	}

	async function inviteAndJoin(app: FastifyInstance, ownerCookie: string, boardId: string, role: 'editor' | 'viewer', login: string) {
		const invite = await app.inject({ method: 'POST', url: '/api/invitations', headers: { cookie: ownerCookie }, payload: { boardId, role } })
		const registered = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { login, displayName: login, password: 'another secure password', invitationToken: invite.json().token } })
		return `canvas_session=${registered.cookies[0].value}`
	}

	it('owner and editor can write semantic actions; viewer and a non-member cannot', async () => {
		const { app } = await createApp()
		const owner = await registerOwner(app)
		await app.inject({ method: 'POST', url: '/api/boards', headers: { cookie: owner.cookie }, payload: { name: 'Chibi', id: 'chibi' } })
		const editorCookie = await inviteAndJoin(app, owner.cookie, 'chibi', 'editor', 'editor-user')
		const viewerCookie = await inviteAndJoin(app, owner.cookie, 'chibi', 'viewer', 'viewer-user')
		const accountInvite = await app.inject({ method: 'POST', url: '/api/invitations', headers: { cookie: owner.cookie }, payload: {} })
		const outsiderRegistered = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { login: 'Outsider', displayName: 'Outsider', password: 'another secure password', invitationToken: accountInvite.json().token } })
		const outsider = { cookie: `canvas_session=${outsiderRegistered.cookies[0].value}` } // registered, but never joined 'chibi'

		const createAction = { actions: [{ tool: 'create_entity', id: 'engineering_entity:rbac-1', entityType: 'component', title: 'RBAC test' }] }

		const ownerWrite = await app.inject({ method: 'POST', url: '/api/rooms/chibi/actions', headers: { cookie: owner.cookie }, payload: createAction })
		expect(ownerWrite.statusCode).toBe(200)

		const editorWrite = await app.inject({ method: 'POST', url: '/api/rooms/chibi/actions', headers: { cookie: editorCookie }, payload: { actions: [{ tool: 'update_status', id: 'engineering_entity:rbac-1', status: 'active' }] } })
		expect(editorWrite.statusCode).toBe(200)

		const viewerWrite = await app.inject({ method: 'POST', url: '/api/rooms/chibi/actions', headers: { cookie: viewerCookie }, payload: { actions: [{ tool: 'update_status', id: 'engineering_entity:rbac-1', status: 'archived' }] } })
		expect(viewerWrite.statusCode).toBe(403)

		const outsiderWrite = await app.inject({ method: 'POST', url: '/api/rooms/chibi/actions', headers: { cookie: outsider.cookie }, payload: createAction })
		expect([403, 404]).toContain(outsiderWrite.statusCode) // nonmembers are hidden, matching the existing E9-E14 convention

		// the semantic-context read endpoint follows the same read authorization as the canvas endpoint
		const viewerRead = await app.inject({ method: 'GET', url: '/api/rooms/chibi/semantic-context', headers: { cookie: viewerCookie } })
		expect(viewerRead.statusCode).toBe(200)
		expect(viewerRead.json().entities).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'engineering_entity:rbac-1', status: 'active' })]))

		const outsiderRead = await app.inject({ method: 'GET', url: '/api/rooms/chibi/semantic-context', headers: { cookie: outsider.cookie } })
		expect([403, 404]).toContain(outsiderRead.statusCode)
	})

	it('attributes an AI bearer-token write to the token client and enforces its scope', async () => {
		const token = randomBytes(24).toString('base64url')
		const { app, directory } = await createApp((dir) => {
			const file = join(dir, 'tokens.json')
			writeFileSync(file, JSON.stringify({ clients: [
				{ name: 'sim-agent', tokenHash: createHash('sha256').update(token).digest('hex'), rooms: ['chibi'], permissions: ['read', 'write'] },
				{ name: 'read-only-agent', tokenHash: createHash('sha256').update('r'.repeat(32)).digest('hex'), rooms: ['chibi'], permissions: ['read'] },
			] }))
			process.env.CANVAS_API_TOKENS_FILE = file
		})
		const owner = await registerOwner(app)
		await app.inject({ method: 'POST', url: '/api/boards', headers: { cookie: owner.cookie }, payload: { name: 'Chibi', id: 'chibi' } })

		const aiWrite = await app.inject({
			method: 'POST', url: '/api/rooms/chibi/actions',
			headers: { authorization: `Bearer ${token}` },
			payload: { actions: [{ tool: 'create_entity', id: 'engineering_entity:ai-made', entityType: 'risk', title: 'Left foot load imbalance' }] },
		})
		expect(aiWrite.statusCode).toBe(200)

		const history = await app.inject({ method: 'GET', url: '/api/boards/chibi/history', headers: { cookie: owner.cookie } })
		expect(history.json().events).toEqual(expect.arrayContaining([expect.objectContaining({ eventType: 'entity.created', source: 'ai', actorUserId: 'token:sim-agent' })]))

		const readOnlyWrite = await app.inject({
			method: 'POST', url: '/api/rooms/chibi/actions',
			headers: { authorization: `Bearer ${'r'.repeat(32)}` },
			payload: { actions: [{ tool: 'update_status', id: 'engineering_entity:ai-made', status: 'closed' }] },
		})
		expect(readOnlyWrite.statusCode).toBe(403)
		void directory
	})
})
