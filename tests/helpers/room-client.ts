import { TLSyncClient } from '@tldraw/sync-core'
import { atom, createTLStore } from 'tldraw'
import { connectRoomSocket, type RoomHandle } from '../../server/rooms'
import { syncSchema } from '../../shared/schema'

/** A real TLSyncClient over an in-memory loopback to a real room, backed by a real tldraw store built from the app schema. */
export function connectRoomClient(handle: RoomHandle, label: string, role: 'owner' | 'editor' | 'viewer' = 'editor') {
	const sessionId = `session-${label}`
	const store = createTLStore({ schema: syncSchema })
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
	const state = { loaded: false, error: null as string | null }
	connectRoomSocket(handle, {
		sessionId,
		userId: `user-${label}`,
		displayName: label,
		role,
		socket: {
			readyState: 1,
			send: (data: string) => {
				const message = JSON.parse(data)
				setTimeout(() => { for (const listener of messageListeners) listener(message) }, 0)
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
	socket.connectionStatus = 'online'
	for (const listener of statusListeners) listener({ status: 'online' })
	return { store, state, client }
}

export async function until(condition: () => boolean, timeoutMs = 2_000) {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (condition()) return
		await new Promise((resolve) => setTimeout(resolve, 20))
	}
	throw new Error('condition not met in time')
}

export const settle = () => new Promise((resolve) => setTimeout(resolve, 150))
