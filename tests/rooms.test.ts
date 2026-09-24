import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { applyRoomActions, readRoomCanvas } from '../server/canvas-api'
import { closeAllRooms, configureRoomDataDirectory, getRoomHandle, sanitizeRoomId } from '../server/rooms'

describe('room persistence boundary', () => {
	it('accepts stable room IDs', () => expect(sanitizeRoomId('em636-team-4')).toBe('em636-team-4'))
	it('rejects path traversal and oversized IDs', () => { expect(() => sanitizeRoomId('../etc/passwd')).toThrow(); expect(() => sanitizeRoomId('x'.repeat(81))).toThrow() })
})

describe('closing a room quiesces its scheduled storage maintenance', () => {
	const directories: string[] = []
	const actor = { userId: 'lifecycle-user', displayName: 'Lifecycle', source: 'human' as const }

	afterEach(() => {
		closeAllRooms()
		for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
	})

	function isolatedRoomDirectory(): void {
		const directory = mkdtempSync(join(tmpdir(), 'canvas-room-lifecycle-'))
		directories.push(directory)
		configureRoomDataDirectory(directory)
	}

	it('leaves nothing scheduled against the database it just closed', async () => {
		// SQLiteSyncStorage prunes tombstones on a trailing-edge throttle with a
		// one-second window, and schedules it from tombstone-producing writes.
		// Nothing upstream cancels it, so if close does not quiesce it the timer
		// fires afterwards against a closed connection. better-sqlite3 throws
		// "The database connection is not open", and because the caller is a
		// timer there is nowhere for that to propagate: Node reports it as an
		// uncaught exception and the test process exits non-zero even though
		// every assertion passed.
		//
		// This asserts the observable consequence, not the internals: once a room
		// is closed, nothing belonging to it may throw for longer than the
		// throttle window. It is armed directly so the test does not depend on
		// which writes happen to schedule a prune.
		isolatedRoomDirectory()

		const uncaught: Error[] = []
		const capture = (error: Error) => uncaught.push(error)
		process.on('uncaughtException', capture)

		try {
			const handle = getRoomHandle('lifecycle-prune-race')
			const scheduled = (handle.storage as unknown as { delegate: { pruneTombstones?: () => void } }).delegate.pruneTombstones
			expect(typeof scheduled, 'the wrapped storage should still schedule tombstone pruning').toBe('function')
			scheduled?.()

			expect(handle.database.open).toBe(true)
			closeAllRooms()
			expect(handle.database.open).toBe(false)

			// Outlast the throttle window the prune was scheduled on.
			await new Promise((resolve) => setTimeout(resolve, 1400))
		} finally {
			process.off('uncaughtException', capture)
		}

		expect(
			uncaught.map((error) => error.message),
			'closing a room must not leave maintenance scheduled against its database'
		).toEqual([])
	}, 20_000)

	it('still persists, reopens and reads back after a close, and closes idempotently', async () => {
		// Closing is also how idle rooms are reclaimed, so quiescing must not cost
		// durability or make a room unreopenable - and dispose must tolerate being
		// reached twice.
		isolatedRoomDirectory()

		const first = getRoomHandle('lifecycle-reopen')
		applyRoomActions(first.room, { actions: [{ tool: 'create_text', id: 'shape:lifecycle-kept', text: 'kept across close', x: 10, y: 10 }] }, actor)
		applyRoomActions(first.room, { actions: [{ tool: 'create_text', id: 'shape:lifecycle-dropped', text: 'deleted to make a tombstone', x: 20, y: 20 }] }, actor)
		applyRoomActions(first.room, { actions: [{ tool: 'delete_shape', id: 'shape:lifecycle-dropped' }] }, actor)

		const uncaught: Error[] = []
		const capture = (error: Error) => uncaught.push(error)
		process.on('uncaughtException', capture)
		try {
			closeAllRooms()
			closeAllRooms()
			expect(first.database.open).toBe(false)
			await new Promise((resolve) => setTimeout(resolve, 1400))
		} finally {
			process.off('uncaughtException', capture)
		}
		expect(uncaught.map((error) => error.message)).toEqual([])

		const reopened = getRoomHandle('lifecycle-reopen')
		expect(reopened.database.open).toBe(true)
		const ids = readRoomCanvas(reopened.room).objects.map((object) => object.id)
		expect(ids).toContain('shape:lifecycle-kept')
		expect(ids).not.toContain('shape:lifecycle-dropped')
	}, 20_000)
})

describe('the room database path is only built from a validated ID', () => {
	let directory = ''

	afterEach(() => {
		closeAllRooms()
		rmSync(directory, { recursive: true, force: true })
	})

	it('getRoomHandle refuses hostile IDs before touching the filesystem', () => {
		directory = mkdtempSync(join(tmpdir(), 'canvas-room-path-'))
		configureRoomDataDirectory(directory)
		const hostile = ['../escape', '..\escape', 'a/b', 'a\b', 'room.sqlite', '.', '..', '', 'a b', 'a\0b', 'x'.repeat(81)]
		for (const id of hostile) expect(() => getRoomHandle(id), JSON.stringify(id)).toThrow('Invalid room ID')
		expect(readdirSync(join(directory, 'rooms'))).toEqual([])
		expect(existsSync(join(directory, 'escape.sqlite'))).toBe(false)
		expect(getRoomHandle('valid-room_1').boardId).toBe('valid-room_1')
		expect(readdirSync(join(directory, 'rooms')).some((name) => name.startsWith('valid-room_1.sqlite'))).toBe(true)
	})
})
