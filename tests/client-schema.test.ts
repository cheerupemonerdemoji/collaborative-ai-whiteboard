import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TLSyncClient } from '@tldraw/sync-core'
import { atom, createTLStore, defaultShapeUtils } from 'tldraw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHistoricalStore, recordsFromSnapshot } from '../client/history/historicalStore'
import { applyRoomActions } from '../server/canvas-api'
import {
	closeAllRooms,
	configureRoomDataDirectory,
	connectRoomSocket,
	createRoomCheckpoint,
	getRoomHandle,
	restoreRoomVersion,
	type RoomHandle,
	withRoomHistory,
} from '../server/rooms'
import { syncSchema } from '../shared/schema'

/*
 * The defect these tests pin: the browser built its tldraw store from tldraw's default schema, which
 * has no definition for `engineering_entity`. A default-schema store throws "Missing definition for
 * record type engineering_entity" the moment a snapshot containing one arrives, so a board holding a
 * semantic entity would not load in the browser at all. Server-side tests could not see this because
 * they built their clients from the server's own schema.
 */

;(globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame ??= (callback: (time: number) => void) => setTimeout(() => callback(Date.now()), 16)
;(globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame ??= (id: ReturnType<typeof setTimeout>) => clearTimeout(id)

const author = { actorUserId: 'user:author', displayName: 'Author' }
const MISSING = /Missing definition for record type engineering_entity/

let directory: string
let handle: RoomHandle
const clients: Array<{ close(): void }> = []

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), 'canvas-client-schema-'))
	configureRoomDataDirectory(directory)
	handle = getRoomHandle('board')
})
afterEach(() => {
	for (const client of clients.splice(0)) client.close()
	closeAllRooms()
	rmSync(directory, { recursive: true, force: true })
})

/** A real TLSyncClient over an in-memory loopback to the real room, backed by a real tldraw store. */
function connect(label: string, options: { schema?: typeof syncSchema; role?: 'owner' | 'editor' | 'viewer' } = {}) {
	const sessionId = `session-${label}`
	const store = options.schema ? createTLStore({ schema: options.schema }) : createTLStore({ shapeUtils: defaultShapeUtils })
	const statusListeners: Array<(event: { status: 'online' | 'offline' }) => void> = []
	const messageListeners: Array<(message: unknown) => void> = []
	const socket = {
		connectionStatus: 'offline' as 'online' | 'offline' | 'error',
		onStatusChange(listener: (event: { status: 'online' | 'offline' }) => void) { statusListeners.push(listener); return () => {} },
		onReceiveMessage(listener: (message: unknown) => void) { messageListeners.push(listener); return () => {} },
		sendMessage(message: unknown) { handle.room.handleSocketMessage(sessionId, JSON.stringify(message)) },
		restart() {},
		close() {},
	}
	const state = { loaded: false, error: null as string | null, deliveryErrors: [] as string[] }
	connectRoomSocket(handle, {
		sessionId,
		userId: `user-${label}`,
		displayName: label,
		role: options.role ?? 'editor',
		// Deliver asynchronously, like a real network, and record anything the client throws while handling a message.
		socket: {
			readyState: 1,
			send: (data: string) => {
				const message = JSON.parse(data)
				setTimeout(() => {
					for (const listener of messageListeners) {
						try { listener(message) } catch (error) { state.deliveryErrors.push(String((error as Error)?.message ?? error)) }
					}
				}, 0)
			},
			close() {},
		},
	})
	const client = new TLSyncClient({
		store,
		socket: socket as never,
		presence: atom('presence', null) as never,
		onLoad() { state.loaded = true },
		onLoadError(error: unknown) { state.error = String((error as Error)?.message ?? error) },
		onSyncError(reason: string) { state.error = reason },
		onAfterConnect() {},
		didCancel: () => false,
	} as never)
	clients.push(client)
	socket.connectionStatus = 'online'
	for (const listener of statusListeners) listener({ status: 'online' })
	return { store, state, client }
}

async function until(condition: () => boolean, timeoutMs = 2_000) {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (condition()) return
		await new Promise((resolve) => setTimeout(resolve, 20))
	}
	throw new Error('condition not met in time')
}

function createEntity(id: string, title: string, extra: Record<string, unknown> = {}) {
	return withRoomHistory(handle, { actorUserId: author.actorUserId, actorDisplayName: author.displayName, source: 'human' }, () =>
		applyRoomActions(handle.room, { actions: [{ tool: 'create_entity', id, entityType: 'component', title, ...extra }] }, author))
}

function entityInStore(store: { get(id: never): unknown }, id: string) {
	return store.get(id as never) as { title?: string; status?: string; entityType?: string } | undefined
}

describe('the browser store must understand engineering_entity', () => {
	it('reproduces the defect: a default-schema store rejects a record it has no definition for', () => {
		createEntity('engineering_entity:reproduce', 'Reproduces the failure')
		const record = handle.room.getCurrentSnapshot().documents.find((entry) => entry.state.id === 'engineering_entity:reproduce')!.state
		const stock = createTLStore({ shapeUtils: defaultShapeUtils })
		// This is what the sync client does with every record in the snapshot the server sends.
		expect(() => stock.mergeRemoteChanges(() => stock.put([record as never]))).toThrow(MISSING)
		const app = createTLStore({ schema: syncSchema })
		expect(() => app.mergeRemoteChanges(() => app.put([record as never]))).not.toThrow()
	})

	it('reproduces the defect end to end: a default-schema sync client fails to load a board containing an entity', async () => {
		createEntity('engineering_entity:end-to-end', 'Reproduces the failure')
		const { store, state } = connect('stock', {})
		await until(() => state.deliveryErrors.length > 0)
		expect(state.deliveryErrors[0]).toMatch(MISSING)
		expect(state.loaded).toBe(false)
		expect(entityInStore(store, 'engineering_entity:end-to-end')).toBeUndefined()
	})

	it('loads the same board with the shared application schema and keeps the entity readable', async () => {
		createEntity('engineering_entity:readable', 'Left leg servo')
		const { store, state } = connect('app', { schema: syncSchema })
		await until(() => state.loaded)
		expect(state.error).toBeNull()
		expect(state.deliveryErrors).toEqual([])
		expect(entityInStore(store, 'engineering_entity:readable')).toMatchObject({ entityType: 'component', title: 'Left leg servo', status: 'proposed' })
	})

	it('still loads an ordinary board with no semantic records, with either schema', async () => {
		applyRoomActions(handle.room, { actions: [{ tool: 'create_text', id: 'shape:plain', text: 'ordinary', x: 1, y: 2 }] }, author)
		for (const [label, schema] of [['stockplain', undefined], ['appplain', syncSchema]] as const) {
			const { store, state } = connect(label, { schema })
			await until(() => state.loaded)
			expect(state.error).toBeNull()
		expect(state.deliveryErrors).toEqual([])
			expect(store.get('shape:plain' as never)).toBeTruthy()
			expect(store.allRecords().some((record) => (record.typeName as string) === 'engineering_entity')).toBe(false)
		}
	})

	it('delivers an entity created while the board is open to every connected client, and shapes still sync', async () => {
		const first = connect('first', { schema: syncSchema })
		const second = connect('second', { schema: syncSchema })
		await until(() => first.state.loaded && second.state.loaded)

		createEntity('engineering_entity:live', 'Created live')
		await until(() => !!entityInStore(second.store, 'engineering_entity:live') && !!entityInStore(first.store, 'engineering_entity:live'))

		applyRoomActions(handle.room, { actions: [{ tool: 'create_text', id: 'shape:beside', text: 'beside the entity', x: 5, y: 5 }] }, author)
		await until(() => !!second.store.get('shape:beside' as never))
		expect(first.state.error ?? second.state.error).toBeNull()
	})

	it('lets a viewer read entities and still refuses the viewer\'s writes', async () => {
		createEntity('engineering_entity:viewable', 'Visible to viewers')
		const viewer = connect('viewer', { schema: syncSchema, role: 'viewer' })
		await until(() => viewer.state.loaded)
		expect(entityInStore(viewer.store, 'engineering_entity:viewable')?.title).toBe('Visible to viewers')

		const page = viewer.store.allRecords().find((record) => record.typeName === 'page')!
		viewer.store.put([{ ...page, name: 'Viewer attempted rename' } as never])
		await new Promise((resolve) => setTimeout(resolve, 300))
		const serverPage = handle.room.getCurrentSnapshot().documents.find((entry) => entry.state.id === page.id)!.state as { name: string }
		expect(serverPage.name).not.toBe('Viewer attempted rename')
	})
})

describe('history, checkpoints and restore with entities', () => {
	it('shows a historical state containing entities in the read-only viewer store', () => {
		createEntity('engineering_entity:historic', 'Historic entity')
		handle.recorder.flush()
		const eventId = handle.history.latestEventId()!
		const reconstructed = handle.history.reconstruct({ eventId }).snapshot

		const store = createHistoricalStore(reconstructed)
		expect(entityInStore(store, 'engineering_entity:historic')?.title).toBe('Historic entity')

		// The history API wraps the snapshot in a JSON envelope; the viewer accepts that shape too.
		const wire = JSON.parse(JSON.stringify({ event: { id: eventId }, snapshot: reconstructed }))
		expect(recordsFromSnapshot(wire).some((record) => record.id === 'engineering_entity:historic')).toBe(true)
		expect(entityInStore(createHistoricalStore(wire), 'engineering_entity:historic')).toBeTruthy()

		// A store built the old way could not have displayed this version.
		expect(() => createTLStore({ initialData: Object.fromEntries(recordsFromSnapshot(reconstructed).map((record) => [record.id, record])) as never, shapeUtils: defaultShapeUtils })).toThrow(MISSING)
	})

	it('displays an explicit checkpoint containing entities, and an ordinary version with none', () => {
		withRoomHistory(handle, { actorUserId: author.actorUserId, actorDisplayName: author.displayName, source: 'human' }, () =>
			applyRoomActions(handle.room, { actions: [{ tool: 'create_text', id: 'shape:before', text: 'before', x: 1, y: 1 }] }, author))
		handle.recorder.flush()
		const ordinary = handle.history.reconstruct({ eventId: handle.history.latestEventId()! }).snapshot
		expect(recordsFromSnapshot(ordinary).some((record) => (record.typeName as string) === 'engineering_entity')).toBe(false)
		expect(createHistoricalStore(ordinary).get('shape:before' as never)).toBeTruthy()

		createEntity('engineering_entity:checkpointed', 'In a checkpoint')
		const checkpoint = createRoomCheckpoint(handle, { userId: 'author', displayName: 'Author' }, 'With an entity')
		const stored = handle.history.getCheckpoint(checkpoint.id)!
		expect(entityInStore(createHistoricalStore(stored.snapshot), 'engineering_entity:checkpointed')?.title).toBe('In a checkpoint')
	})

	it('keeps a connected client consistent through changes and a restore, and a fresh client reads the restored state', async () => {
		createEntity('engineering_entity:restore-me', 'Original title')
		handle.recorder.flush()
		const baseline = handle.history.latestEventId()!
		const client = connect('restorer', { schema: syncSchema })
		await until(() => client.state.loaded)

		withRoomHistory(handle, { actorUserId: author.actorUserId, actorDisplayName: author.displayName, source: 'human' }, () =>
			applyRoomActions(handle.room, { actions: [{ tool: 'update_entity', id: 'engineering_entity:restore-me', title: 'Changed title' }, { tool: 'update_status', id: 'engineering_entity:restore-me', status: 'active' }] }, author))
		await until(() => entityInStore(client.store, 'engineering_entity:restore-me')?.title === 'Changed title')

		restoreRoomVersion(handle, { eventId: baseline, expectedClock: handle.storage.getClock(), userId: 'author', displayName: 'Author' })
		await until(() => entityInStore(client.store, 'engineering_entity:restore-me')?.title === 'Original title')
		expect(entityInStore(client.store, 'engineering_entity:restore-me')?.status).toBe('proposed')
		expect(client.state.error).toBeNull()

		const fresh = connect('freshafter', { schema: syncSchema })
		await until(() => fresh.state.loaded)
		expect(entityInStore(fresh.store, 'engineering_entity:restore-me')?.title).toBe('Original title')
	})

	it('removes an entity from a connected client when restoring to a state before it existed', async () => {
		handle.recorder.flush()
		const before = handle.history.latestEventId()!
		const client = connect('remover', { schema: syncSchema })
		await until(() => client.state.loaded)
		createEntity('engineering_entity:ephemeral', 'Will be rolled back')
		await until(() => !!entityInStore(client.store, 'engineering_entity:ephemeral'))

		restoreRoomVersion(handle, { eventId: before, expectedClock: handle.storage.getClock(), userId: 'author', displayName: 'Author' })
		await until(() => !entityInStore(client.store, 'engineering_entity:ephemeral'))
		expect(client.state.error).toBeNull()
	})
})

describe('no client path may build a store from the default schema', () => {
	function sourceFiles(directory: string): string[] {
		return readdirSync(directory).flatMap((name) => {
			const path = join(directory, name)
			if (statSync(path).isDirectory()) return sourceFiles(path)
			return /\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts') ? [path] : []
		})
	}

	it('every useSync/createTLStore call in client/ passes the shared syncSchema', () => {
		const offenders: string[] = []
		let inspected = 0
		for (const file of sourceFiles(join(__dirname, '..', 'client'))) {
			readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, index) => {
				if (!/\b(useSync|createTLStore)\(/.test(line) || /^\s*(import|\/\/|\*)/.test(line)) return
				inspected += 1
				if (!line.includes('syncSchema')) offenders.push(`${file}:${index + 1}`)
			})
		}
		expect(inspected).toBeGreaterThanOrEqual(2) // Room.tsx (useSync) and historicalStore.ts (createTLStore)
		expect(offenders).toEqual([])
	})
})
