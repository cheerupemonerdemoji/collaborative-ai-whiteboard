import { TLSyncClient, type TLPersistentClientSocket, type TLSocketClientSentEvent, type TLSocketServerSentEvent, type TLSocketStatusListener } from '@tldraw/sync-core'
import { atom, createTLStore, type TLRecord } from 'tldraw'
import WebSocket from 'ws'
import { syncSchema } from '../../shared/schema'

/** Real sync client and store over authenticated loopback WebSockets, with explicit reconnect control. */
export function networkRoomClient(url: string, cookie: string) {
	const store = createTLStore({ schema: syncSchema })
	const statusListeners = new Set<TLSocketStatusListener>()
	const messageListeners = new Set<(message: TLSocketServerSentEvent<TLRecord>) => void>()
	let ws: WebSocket
	let disposed = false
	const state = { loaded: false, error: '', readonly: false }
	const socket: TLPersistentClientSocket<TLSocketClientSentEvent<TLRecord>, TLSocketServerSentEvent<TLRecord>> = {
		connectionStatus: 'offline',
		onStatusChange(listener) { statusListeners.add(listener); return () => { statusListeners.delete(listener) } },
		onReceiveMessage(listener) { messageListeners.add(listener); return () => { messageListeners.delete(listener) } },
		sendMessage(message) { ws.send(JSON.stringify(message)) },
		restart() { if (!disposed) { ws?.terminate(); connect() } },
		close() { disposed = true; ws?.terminate() },
	}
	function connect() {
		const current = new WebSocket(url, { headers: { cookie, origin: 'http://127.0.0.1:8787' } })
		ws = current
		current.on('open', () => {
			if (current !== ws || disposed) return
			socket.connectionStatus = 'online'
			for (const listener of statusListeners) listener({ status: 'online' })
		})
		current.on('message', (data) => {
			if (current !== ws || disposed) return
			const message = JSON.parse(data.toString()) as TLSocketServerSentEvent<TLRecord>
			for (const listener of messageListeners) listener(message)
		})
		current.on('close', () => {
			if (current !== ws || disposed) return
			socket.connectionStatus = 'offline'
			for (const listener of statusListeners) listener({ status: 'offline' })
		})
		current.on('error', (error) => { state.error = error.message })
	}
	const client = new TLSyncClient({
		store, socket, presence: atom<TLRecord | null>('presence', null),
		onLoad() { state.loaded = true },
		onSyncError(reason) { state.error = reason },
		onAfterConnect(_client, details) { state.readonly = details.isReadonly },
	})
	connect()
	return { store, state, socket, disconnect: () => ws.terminate(), reconnect: connect, close() { client.close(); socket.close() } }
}
