import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getTlsyncProtocolVersion, type WebSocketMinimal } from '@tldraw/sync-core'
import { applyRoomActions } from '../server/canvas-api'
import { closeAllRooms, configureRoomAuditReader, configureRoomDataDirectory, connectRoomSocket, getRoomHandle, restoreRoomVersion, schema, withRoomHistory } from '../server/rooms'

let directory: string
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), 'canvas-sync-history-'))
	configureRoomDataDirectory(directory)
})
afterEach(() => {
	closeAllRooms()
	configureRoomAuditReader(null)
	rmSync(directory, { recursive: true, force: true })
})

it('projects durable board metadata events once and recovers the cursor after reopening', () => {
	const events = [
		{ id: 1, eventId: 'audit-one', type: 'board.renamed', actorUserId: 'owner', subjectUserId: null, boardId: 'board', metadataJson: '{"name":"Renamed"}', createdAt: new Date().toISOString(), actorDisplayName: 'Owner' },
	]
	configureRoomAuditReader((_boardId, after) => events.filter((event) => event.id > after))
	const handle = getRoomHandle('board')
	expect(handle.history.listEvents().events.filter((event) => event.eventType === 'board.renamed')).toHaveLength(1)
	getRoomHandle('board')
	closeAllRooms()
	const reopened = getRoomHandle('board')
	expect(reopened.history.listEvents().events.filter((event) => event.eventType === 'board.renamed')).toHaveLength(1)
})

function connect(userId: string, role: 'owner' | 'editor' | 'viewer', expiresAt?: number) {
	const handle = getRoomHandle('board')
	const messages: string[] = []
	const socket: WebSocketMinimal = { readyState: 1, send: (data) => messages.push(data), close: vi.fn() }
	const sessionId = `session-${userId}`
	connectRoomSocket(handle, { sessionId, socket, userId, displayName: userId, role, expiresAt })
	handle.room.handleSocketMessage(sessionId, JSON.stringify({
		type: 'connect', connectRequestId: sessionId, lastServerClock: 0,
		protocolVersion: getTlsyncProtocolVersion(), schema: schema.serialize(),
	}))
	return { handle, sessionId, messages, socket }
}

it('disconnects an expired session without waiting for another incoming message', async () => {
	connect('owner', 'owner')
	const viewer = connect('expiring', 'viewer', Date.now() + 40)
	await new Promise((resolve) => setTimeout(resolve, 80))
	expect(viewer.socket.close).toHaveBeenCalled()
})

it('attributes real client pushes, broadcasts updates, and refuses viewer mutations', async () => {
	const owner = connect('owner', 'owner')
	const editor = connect('editor', 'editor')
	const viewer = connect('viewer', 'viewer')
	const page = owner.handle.room.getCurrentSnapshot().documents.find((entry) => entry.state.typeName === 'page')!.state
	const edit = { ...page, name: 'Edited by collaborator' }
	owner.handle.room.handleSocketMessage(editor.sessionId, JSON.stringify({ type: 'push', clientClock: 1, diff: { [page.id]: ['put', edit] } }))
	await new Promise((resolve) => setTimeout(resolve, 100))
	owner.handle.recorder.flush()
	expect(owner.handle.storage.getSnapshot().documents.find((entry) => entry.state.id === page.id)!.state).toMatchObject({ name: edit.name })
	expect(owner.handle.history.listEvents().events).toEqual(expect.arrayContaining([
		expect.objectContaining({ actorUserId: 'user:editor', source: 'human', changes: expect.arrayContaining([expect.objectContaining({ recordId: page.id })]) }),
	]))
	expect(owner.messages.join('')).toContain('Edited by collaborator')
	owner.handle.room.handleSocketMessage(viewer.sessionId, JSON.stringify({ type: 'push', clientClock: 1, diff: { [page.id]: ['put', { ...page, name: 'Forbidden' }] } }))
	await new Promise((resolve) => setTimeout(resolve, 20))
	expect(owner.handle.storage.getSnapshot().documents.find((entry) => entry.state.id === page.id)!.state).toMatchObject({ name: edit.name })
})

it('restores the chosen state, checkpoints the prior head, rejects stale clocks, and survives reopen', () => {
	const handle = getRoomHandle('board')
	const baseline = handle.history.latestEventId()!
	withRoomHistory(handle, { actorUserId: 'token:test', actorDisplayName: 'test', source: 'ai' }, () =>
		applyRoomActions(handle.room, { actions: [{ tool: 'create_text', id: 'shape:retained', text: 'Keep in history', x: 10, y: 20 }] }))
	const priorClock = handle.storage.getClock()
	const idsBefore = handle.history.listEvents().events.map((event) => event.id)
	const result = restoreRoomVersion(handle, { eventId: baseline, expectedClock: priorClock, userId: 'owner', displayName: 'Owner' })
	expect(handle.storage.getSnapshot().documents.some((entry) => entry.state.id === 'shape:retained')).toBe(false)
	const preserved = handle.history.listCheckpoints().find((checkpoint) => checkpoint.reason === 'pre_restore')!
	expect(handle.history.getCheckpoint(preserved.id)!.snapshot.documents.some((entry) => entry.state.id === 'shape:retained')).toBe(true)
	expect(handle.history.listEvents().events.map((event) => event.id)).toEqual(expect.arrayContaining(idsBefore))
	expect(result.event.actorUserId).toBe('user:owner')
	expect(() => restoreRoomVersion(handle, { eventId: baseline, expectedClock: priorClock, userId: 'owner', displayName: 'Owner' })).toThrow('Board changed')
	closeAllRooms()
	const reopened = getRoomHandle('board')
	expect(reopened.history.reconstruct({ eventId: result.event.id }).snapshot.documents.some((entry) => entry.state.id === 'shape:retained')).toBe(false)
})
