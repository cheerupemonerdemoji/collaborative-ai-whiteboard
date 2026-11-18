import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createShapeId } from 'tldraw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeAllRooms, configureRoomDataDirectory, getRoomHandle, withRoomHistory, type RoomHandle } from '../server/rooms'
import { createCadModel, transitionCadRevision, type CadActor, type CadModel } from '../shared/cad-model'
import { extractCadAssembly } from '../server/cad-assembly'
import { buildSampleAssemblyGlb } from '../shared/cad-sample'
import { connectRoomClient, settle, until } from './helpers/room-client'

/*
 * The spike behind the CAD review design: can the room itself refuse a browser's writes to `cad_model` records,
 * so approval state and attribution are enforced by the server and not by the panel that renders them?
 * These tests drive a real room with real TLSyncClients over a loopback, the same harness as client-schema.
 */

;(globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame ??= (callback: (time: number) => void) => setTimeout(() => callback(Date.now()), 16)
;(globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame ??= (id: ReturnType<typeof setTimeout>) => clearTimeout(id)

const SHA = 'a'.repeat(64)
const alice: CadActor = { userId: 'user:alice', displayName: 'Alice', source: 'human' }
const agent: CadActor = { userId: 'token:agent', displayName: 'agent', source: 'ai' }

let directory: string
let handle: RoomHandle
const clients: Array<{ close(): void }> = []

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), 'canvas-cad-guard-'))
	configureRoomDataDirectory(directory)
	handle = getRoomHandle('board')
})
afterEach(() => {
	for (const client of clients.splice(0)) client.close()
	closeAllRooms()
	rmSync(directory, { recursive: true, force: true })
})

function connect(label: string, role: 'owner' | 'editor' | 'viewer' = 'editor') {
	const connection = connectRoomClient(handle, label, role)
	clients.push(connection.client)
	return connection
}

function sampleModel(id = 'cad_model:0123456789ab'): CadModel {
	return createCadModel({
		id, modelId: 'TRAIN-SPACER', name: 'Spacer', units: 'mm',
		revision: { id: 'rev-aaaaaa', files: { glb: { assetId: `cad-${SHA}.glb`, sha256: SHA, bytes: 1_000, name: 'spacer.glb' } }, changeNote: 'baseline' },
	}, alice, 1_000)
}

/** What the HTTP routes do: a server transaction, attributed to the session's user, never subject to the client veto. */
function serverWrite(model: CadModel, actor: CadActor, eventType: string) {
	return withRoomHistory(handle, { actorUserId: actor.userId, actorDisplayName: actor.displayName, source: actor.source, immediate: true, eventType, metadata: { modelId: model.id } }, () =>
		handle.room.storage.transaction((txn) => { txn.set(model.id, model as never) }))
}

const serverCopy = (id: string) => handle.room.getCurrentSnapshot().documents.find((entry) => entry.state.id === id)?.state as unknown as CadModel | undefined

describe('cad_model records are writable by the server only', () => {
	it('syncs a server-written model to editors and viewers', async () => {
		const editor = connect('editor')
		const viewer = connect('viewer', 'viewer')
		await until(() => editor.state.loaded && viewer.state.loaded)
		serverWrite(sampleModel(), alice, 'cad.model.created')
		await until(() => Boolean(editor.store.get('cad_model:0123456789ab' as never)) && Boolean(viewer.store.get('cad_model:0123456789ab' as never)))
		expect((editor.store.get('cad_model:0123456789ab' as never) as unknown as CadModel).name).toBe('Spacer')
	})

	it('refuses a browser creating a model, and the browser self-corrects', async () => {
		const editor = connect('editor')
		await until(() => editor.state.loaded)
		editor.store.put([sampleModel('cad_model:ffffffffffff') as never])
		expect(editor.store.get('cad_model:ffffffffffff' as never)).toBeDefined()
		await settle()
		expect(serverCopy('cad_model:ffffffffffff')).toBeUndefined()
		await until(() => editor.store.get('cad_model:ffffffffffff' as never) === undefined)
	})

	it('refuses a browser forging an approval on an existing model', async () => {
		const model = sampleModel()
		serverWrite(model, alice, 'cad.model.created')
		const editor = connect('editor')
		await until(() => editor.state.loaded && Boolean(editor.store.get(model.id as never)))
		const forged = { ...model, revisions: [{ ...model.revisions[0], status: 'approved', decision: { by: alice, at: 5, note: 'forged' } }] }
		editor.store.put([forged as never])
		await settle()
		expect(serverCopy(model.id)!.revisions[0].status).toBe('draft')
		await until(() => (editor.store.get(model.id as never) as unknown as CadModel).revisions[0].status === 'draft')
	})

	it('refuses a browser rewriting the verified exploded-view groups, so the file cannot be re-grouped from the client', async () => {
		const assembly = extractCadAssembly(Buffer.from(buildSampleAssemblyGlb()))!
		const model = createCadModel({ id: 'cad_model:0123456789ab', modelId: 'ASSY-1', name: 'Assembly', units: 'mm', revision: { id: 'rev-aaaaaa', files: { glb: { assetId: `cad-${SHA}.glb`, sha256: SHA, bytes: 1_000, name: 'a.glb' } }, assembly, changeNote: '' } }, alice, 1_000)
		expect(model.revisions[0].assembly!.explode).toEqual(['base-plate', 'upright', 'node-3', 'node-6'])
		serverWrite(model, alice, 'cad.model.created')
		const editor = connect('editor')
		await until(() => editor.state.loaded && Boolean(editor.store.get(model.id as never)))
		// an inconsistent grouping never even gets into the browser's own store
		const inconsistent = { ...model, revisions: [{ ...model.revisions[0], assembly: { ...assembly, explode: ['base-plate', 'upright'] } }] }
		expect(() => editor.store.put([inconsistent as never])).toThrow()
		// a consistent but different grouping is written locally and then refused by the room, which restores the server's value
		const regrouped = { ...model, revisions: [{ ...model.revisions[0], assembly: { ...assembly, explode: ['node-6', 'node-3', 'upright', 'base-plate'] } }] }
		editor.store.put([regrouped as never])
		await settle()
		expect(serverCopy(model.id)!.revisions[0].assembly!.explode).toEqual(['base-plate', 'upright', 'node-3', 'node-6'])
		await until(() => (editor.store.get(model.id as never) as unknown as CadModel).revisions[0].assembly!.explode![0] === 'base-plate')
	})

	it('refuses a browser editing the files of an approved revision', async () => {
		const draft = sampleModel()
		const inReview = transitionCadRevision(draft, 'rev-aaaaaa', 'in-review', alice, '', 2_000)
		const approved = transitionCadRevision(inReview, 'rev-aaaaaa', 'approved', alice, 'ok', 3_000)
		serverWrite(approved, alice, 'cad.revision.status_changed')
		const editor = connect('editor')
		await until(() => editor.state.loaded && Boolean(editor.store.get(approved.id as never)))
		const swapped = { ...approved, revisions: [{ ...approved.revisions[0], files: { glb: { ...approved.revisions[0].files.glb!, sha256: 'b'.repeat(64), assetId: `cad-${'b'.repeat(64)}.glb` } } }] }
		editor.store.put([swapped as never])
		await settle()
		expect(serverCopy(approved.id)!.revisions[0].files.glb!.sha256).toBe(SHA)
		expect(serverCopy(approved.id)!.revisions[0].status).toBe('approved')
	})

	it('refuses a browser deleting a model', async () => {
		const model = sampleModel()
		serverWrite(model, alice, 'cad.model.created')
		const editor = connect('editor')
		await until(() => editor.state.loaded && Boolean(editor.store.get(model.id as never)))
		editor.store.remove([model.id as never])
		await settle()
		expect(serverCopy(model.id)).toBeDefined()
		await until(() => Boolean(editor.store.get(model.id as never)))
	})

	it('still lets editors draw ordinary shapes, so the veto does not break normal sync', async () => {
		const editor = connect('editor')
		await until(() => editor.state.loaded)
		const id = createShapeId('plain')
		const page = editor.store.allRecords().find((record) => record.typeName === 'page')!
		editor.store.put([{
			id, typeName: 'shape', type: 'geo', x: 10, y: 20, rotation: 0, index: 'a1', parentId: page.id, isLocked: false, opacity: 1, meta: {},
			props: { geo: 'rectangle', w: 100, h: 80, color: 'black', labelColor: 'black', fill: 'none', dash: 'draw', size: 'm', font: 'draw', align: 'middle', verticalAlign: 'middle', growY: 0, url: '', scale: 1, flipX: false, flipY: false, richText: { type: 'doc', content: [{ type: 'paragraph' }] } },
		} as never])
		await until(() => Boolean(handle.room.getCurrentSnapshot().documents.find((entry) => entry.state.id === id)))
	})

	it('attributes the server write to the signed-in person, and records nothing for vetoed browser writes', async () => {
		const model = sampleModel()
		serverWrite(model, alice, 'cad.model.created')
		handle.recorder.flush()
		const before = handle.history.listEvents({ limit: 100 }).events.filter((event) => event.eventType.startsWith('cad.') || event.changes.some((change) => (change.after as { typeName?: string } | null)?.typeName === 'cad_model'))
		expect(before).toHaveLength(1)
		expect(before[0]).toMatchObject({ eventType: 'cad.model.created', actorUserId: 'user:alice', source: 'human' })
		const editor = connect('editor')
		await until(() => editor.state.loaded && Boolean(editor.store.get(model.id as never)))
		editor.store.put([{ ...model, name: 'Renamed by a browser' } as never])
		await settle()
		handle.recorder.flush()
		const after = handle.history.listEvents({ limit: 100 }).events.filter((event) => event.changes.some((change) => (change.after as { typeName?: string } | null)?.typeName === 'cad_model'))
		expect(after).toHaveLength(1)
	})

	it('records an AI-sourced server write as AI, never as a person', async () => {
		serverWrite(sampleModel(), agent, 'cad.revision.added')
		handle.recorder.flush()
		const events = handle.history.listEvents({ limit: 100 }).events.filter((event) => event.eventType === 'cad.revision.added')
		expect(events).toHaveLength(1)
		expect(events[0]).toMatchObject({ actorUserId: 'token:agent', source: 'ai' })
	})
})
