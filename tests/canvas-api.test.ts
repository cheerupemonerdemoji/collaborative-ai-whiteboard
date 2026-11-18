import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TLSocketRoom } from '@tldraw/sync-core'
import type { TLRecord } from '@tldraw/tlschema'
import { afterEach, describe, expect, it } from 'vitest'
import { applyRoomActions, CanvasApiError, readRoomCanvas } from '../server/canvas-api'
import { schema } from '../server/rooms'
import { authorizeApiToken } from '../server/tokens'

const rooms: TLSocketRoom<TLRecord, void>[] = []
afterEach(() => { rooms.forEach((room) => room.close()); rooms.length = 0 })
function room() { const instance = new TLSocketRoom<TLRecord, void>({ schema }); rooms.push(instance); return instance }

describe('external canvas actions', () => {
	it('creates a readable chart and requires its revision for changes', () => {
		const instance = room()
		const chart = { kind: 'bar' as const, title: 'Run outcomes', source: 'results/many_seed.json', data: [{ label: 'stalled', value: 57 }, { label: 'slow', value: 3 }] }
		applyRoomActions(instance, { actions: [{ tool: 'create_chart', id: 'shape:chart', chart, x: 25, y: 40, width: 720, height: 500 }] })
		const created = readRoomCanvas(instance).objects[0]
		expect(created).toMatchObject({ id: 'shape:chart', type: 'data-chart', text: 'Run outcomes', x: 25, y: 40, width: 720, height: 500, chart })
		const next = { ...chart, title: 'Updated outcomes' }
		applyRoomActions(instance, { actions: [{ tool: 'update_chart', id: 'shape:chart', chart: next, expectedRevision: created.revision! }] })
		expect(readRoomCanvas(instance).objects[0].chart).toEqual(next)
		expect(() => applyRoomActions(instance, { actions: [{ tool: 'update_chart', id: 'shape:chart', chart, expectedRevision: created.revision! }] })).toThrow(CanvasApiError)
	})
	it('rejects unsafe or incomplete chart data atomically', () => {
		const instance = room()
		expect(() => applyRoomActions(instance, { actions: [
			{ tool: 'create_shape', id: 'shape:before-chart', type: 'rectangle', text: 'Before', x: 0, y: 0, width: 100, height: 100 },
			{ tool: 'create_chart', id: 'shape:invalid-chart', x: 200, y: 0, width: 720, height: 500,
				chart: { kind: 'scatter', title: 'Invalid', source: 'test', data: [{ label: 'A', value: 1 }] } },
		] })).toThrow()
		expect(readRoomCanvas(instance).objects).toEqual([])
	})
	it('creates native circles and arrows in one transaction and exposes the updated canvas', () => {
		const instance = room()
		const before = readRoomCanvas(instance)
		const result = applyRoomActions(instance, { expectedClock: before.clock, actions: [
			{ tool: 'create_shape', id: 'shape:left', type: 'ellipse', text: 'Left', x: 100, y: 100, width: 100, height: 100 },
			{ tool: 'create_shape', id: 'shape:right', type: 'ellipse', text: 'Right', x: 400, y: 100, width: 100, height: 100 },
			{ tool: 'connect_shapes', id: 'shape:link', fromId: 'shape:left', toId: 'shape:right' },
		] })
		const after = readRoomCanvas(instance)
		expect(result.applied).toBe(3)
		expect(after.clock).toBeGreaterThan(before.clock)
		expect(after.objects.map((shape) => shape.id)).toEqual(['shape:left', 'shape:right', 'shape:link'])
		expect(after.objects[0]).toMatchObject({ type: 'ellipse', text: 'Left', width: 100, height: 100 })
		expect(after.objects[2]).toMatchObject({ type: 'arrow', fromId: 'shape:left', toId: 'shape:right', startX: 200, endX: 400 })
	})
	it('moves, renames, resizes and deletes without allowing stale writes', () => {
		const instance = room()
		applyRoomActions(instance, { actions: [{ tool: 'create_shape', id: 'shape:test', type: 'rectangle', text: 'Before', x: 10, y: 20, width: 100, height: 80 }] })
		const clock = readRoomCanvas(instance).clock
		expect(() => applyRoomActions(instance, { expectedClock: clock - 1, actions: [{ tool: 'move_shape', id: 'shape:test', x: 50, y: 60 }] })).toThrow(CanvasApiError)
		applyRoomActions(instance, { expectedClock: clock, actions: [
			{ tool: 'move_shape', id: 'shape:test', x: 50, y: 60 },
			{ tool: 'update_text', id: 'shape:test', text: 'After' },
			{ tool: 'resize_shape', id: 'shape:test', width: 150, height: 90 },
		] })
		expect(readRoomCanvas(instance).objects[0]).toMatchObject({ x: 50, y: 60, text: 'After', width: 150, height: 90 })
		applyRoomActions(instance, { actions: [{ tool: 'delete_shape', id: 'shape:test' }] })
		expect(readRoomCanvas(instance).objects).toEqual([])
	})
	it('rolls back a batch containing an invalid reference', () => {
		const instance = room()
		expect(() => applyRoomActions(instance, { actions: [
			{ tool: 'create_shape', id: 'shape:valid', type: 'ellipse', text: 'Valid', x: 0, y: 0, width: 100, height: 100 },
			{ tool: 'move_shape', id: 'shape:missing', x: 10, y: 10 },
		] })).toThrow()
		expect(readRoomCanvas(instance).objects).toEqual([])
	})
})

describe('room-scoped client tokens', () => {
	it('requires a valid bearer token with the requested permission and room', () => {
		const directory = mkdtempSync(join(tmpdir(), 'canvas-token-test-'))
		const previous = process.env.CANVAS_API_TOKENS_FILE
		const token = 'a'.repeat(43)
		try {
			const file = join(directory, 'tokens.json')
			writeFileSync(file, JSON.stringify({ clients: [{ name: 'reader', tokenHash: createHash('sha256').update(token).digest('hex'), rooms: ['demo'], permissions: ['read'] }] }))
			process.env.CANVAS_API_TOKENS_FILE = file
			expect(authorizeApiToken(`Bearer ${token}`, 'demo', 'read')).toBe('reader')
			expect(authorizeApiToken(`Bearer ${token}`, 'demo', 'write')).toBeNull()
			expect(authorizeApiToken(`Bearer ${token}`, 'other', 'read')).toBeNull()
			expect(authorizeApiToken('Bearer invalid', 'demo', 'read')).toBeNull()
		} finally {
			if (previous === undefined) delete process.env.CANVAS_API_TOKENS_FILE
			else process.env.CANVAS_API_TOKENS_FILE = previous
			rmSync(directory, { recursive: true, force: true })
		}
	})
})
