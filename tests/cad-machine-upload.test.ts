import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isMachineRoute } from '../server/host-policy'
import { getRoomHandle } from '../server/rooms'
import { CAD_UPLOAD_CLOCK_ALLOWANCE_MS, CAD_UPLOAD_MAX_LIFETIME_DAYS, createClient, revokeClient, rotateClient } from '../server/token-store.mjs'
import { authorizeApiCapability } from '../server/tokens'
import { buildSampleGlb } from '../shared/cad-sample'
import { createAcceptanceFixture, type AcceptanceFixture } from './helpers/acceptance-fixture'

;(globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame ??= (callback: (time: number) => void) => setTimeout(() => callback(Date.now()), 16)
;(globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame ??= (id: ReturnType<typeof setTimeout>) => clearTimeout(id)

/**
 * Machine CAD upload (the machine CAD upload design note): a credential holding the `cad-upload` capability on one
 * board may store validated CAD artifacts and add a CAD model entry (with its card) to that board. Everything else about
 * CAD, and every signed-in route, behaves as before.
 */
const OCTET = { 'content-type': 'application/octet-stream' }
const DAY = 86_400_000
const CAP = CAD_UPLOAD_MAX_LIFETIME_DAYS
let f: AcceptanceFixture
let storeDirectory: string
let storeFile: string

beforeEach(async () => {
	f = await createAcceptanceFixture({ rateLimits: { upload: { limit: 1_000, windowMs: 60_000 }, write: { limit: 1_000, windowMs: 60_000 } } })
	storeDirectory = mkdtempSync(join(tmpdir(), 'cad-machine-store-'))
	storeFile = join(storeDirectory, 'api-tokens.json')
	process.env.CANVAS_API_TOKENS_FILE = storeFile
})
afterEach(async () => {
	await f.cleanup()
	rmSync(storeDirectory, { recursive: true, force: true })
})

/** A binary STL of `triangles` triangles (50 bytes each); `seed` changes the vertices so each file hashes differently. */
function stl(triangles = 2, seed = 0): Buffer {
	const bytes = Buffer.alloc(84 + triangles * 50)
	bytes.write('test stl', 0, 'latin1')
	bytes.writeUInt32LE(triangles, 80)
	for (let index = 0; index < triangles; index += 1) {
		const base = 84 + index * 50
		bytes.writeFloatLE(0, base); bytes.writeFloatLE(0, base + 4); bytes.writeFloatLE(1, base + 8)
		const vertices = [seed + index, 0, 0, seed + index + 1, 0, 0, seed + index, 1, 0]
		vertices.forEach((value, offset) => bytes.writeFloatLE(value, base + 12 + offset * 4))
	}
	return bytes
}
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const bearer = (token: string) => ({ authorization: `Bearer ${token}`, ...OCTET })
const machineUpload = (token: string, boardId: string, kind: string, body: Buffer | string, name = 'part.stl') =>
	f.app.inject({ method: 'POST', url: `/api/boards/${boardId}/cad-machine/artifacts/${kind}?name=${name}`, headers: bearer(token), payload: body })
const machineModel = (token: string, boardId: string, payload: unknown) =>
	f.app.inject({ method: 'POST', url: `/api/boards/${boardId}/cad-machine/models`, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, payload: payload as never })

async function cadClient(overrides: Record<string, unknown> = {}) {
	// A cad-upload credential must expire within the maximum, so every test credential does (7 days unless a test says otherwise).
	return createClient({ file: storeFile, name: 'cad-agent', rooms: [f.boardId], access: 'read-write', capabilities: ['cad-upload'], expiresAt: new Date(Date.now() + 7 * DAY), ...overrides } as Parameters<typeof createClient>[0])
}
const modelBody = (assetId: string, extra: Record<string, unknown> = {}) => ({
	name: 'Test part (visual only)', modelId: 'test-part', units: 'mm', changeNote: 'Visual only. Not collision or manufacturing evidence.',
	files: { stl: { assetId, name: 'part.stl' } }, placement: { pageId: 'page:page', x: 100, y: 200 }, ...extra,
})
const snapshot = () => getRoomHandle(f.boardId).room.getCurrentSnapshot().documents.map((entry) => entry.state as unknown as Record<string, unknown>)
const cadModels = () => snapshot().filter((state) => state.typeName === 'cad_model')
const cadCards = () => snapshot().filter((state) => state.typeName === 'shape' && state.type === 'cad-review')
const assetFiles = () => readdirSync(join(f.directory, 'assets')).filter((name) => name.startsWith('cad-') && !name.endsWith('.tmp'))

describe('who may hold the cad-upload capability', () => {
	it('is granted only with write access, only for one board, and only a known capability', async () => {
		await expect(cadClient({ access: 'read' })).rejects.toMatchObject({ code: 'invalid-capabilities' })
		await expect(cadClient({ rooms: [f.boardId, 'other-board'] })).rejects.toMatchObject({ code: 'invalid-capabilities' })
		await expect(cadClient({ capabilities: ['root'] })).rejects.toMatchObject({ code: 'invalid-capabilities' })
		await expect(cadClient({ capabilities: ['cad-upload', 'cad-upload'] })).rejects.toMatchObject({ code: 'invalid-capabilities' })
		await expect(cadClient({ capabilities: 'cad-upload' })).rejects.toMatchObject({ code: 'invalid-capabilities' })
		expect((await cadClient()).capabilities).toEqual(['cad-upload'])
	})

	it('is not in any access mode, and an ordinary credential never has it', async () => {
		const plain = await createClient({ file: storeFile, name: 'plain', rooms: [f.boardId], access: 'full' })
		expect(plain.capabilities).toBeUndefined()
		expect((await machineUpload(plain.token, f.boardId, 'stl', stl())).statusCode).toBe(401)
		expect(assetFiles()).toEqual([])
	})
})

describe('machine routes refuse everyone without the capability on this board', () => {
	it('refuses no bearer, a malformed one and a made-up one: 401 and nothing stored', async () => {
		await cadClient()
		const url = `/api/boards/${f.boardId}/cad-machine/artifacts/stl`
		expect((await f.app.inject({ method: 'POST', url, headers: OCTET, payload: stl() })).statusCode).toBe(401)
		expect((await f.app.inject({ method: 'POST', url, headers: { authorization: 'Bearer short', ...OCTET }, payload: stl() })).statusCode).toBe(401)
		expect((await machineUpload('z'.repeat(43), f.boardId, 'stl', stl())).statusCode).toBe(401)
		expect(assetFiles()).toEqual([])
	})

	it('refuses a valid credential on another board, with the same 401 as an unknown one', async () => {
		const { token } = await cadClient()
		const other = await f.owner.post('/api/boards', { name: 'Other board', id: 'other-board' })
		expect(other.statusCode).toBe(200)
		const wrong = await machineUpload(token, 'other-board', 'stl', stl())
		const unknown = await machineUpload(token, 'no-such-board', 'stl', stl())
		expect(wrong.statusCode).toBe(401)
		expect(unknown.statusCode).toBe(401)
		expect(wrong.json()).toEqual(unknown.json())
		expect(assetFiles()).toEqual([])
	})

	it('refuses an expired credential and one whose write access was removed', async () => {
		const { token } = await cadClient({ expiresAt: new Date(Date.now() + 60_000) })
		expect((await machineUpload(token, f.boardId, 'stl', stl(2, 1))).statusCode).toBe(201)
		const readOnly = await cadClient({ name: 'to-demote' })
		expect((await machineUpload(readOnly.token, f.boardId, 'stl', stl(2, 2))).statusCode).toBe(201)
		const rotated = await rotateClient({ file: storeFile, name: 'to-demote', access: 'read' })
		expect((await machineUpload(rotated.token, f.boardId, 'stl', stl(2, 3))).statusCode).toBe(401)
		const expiring = await cadClient({ name: 'expiring', expiresAt: new Date(Date.now() + 1_000) })
		await new Promise((resolve) => setTimeout(resolve, 1_300))
		expect((await machineUpload(expiring.token, f.boardId, 'stl', stl(2, 4))).statusCode).toBe(401)
		expect(assetFiles()).toHaveLength(2)
	})

	it('fails closed if the store ever lists the credential on a second board', async () => {
		const { token } = await cadClient()
		const other = await f.owner.post('/api/boards', { name: 'Other board', id: 'other-board' })
		expect(other.statusCode).toBe(200)
		const data = JSON.parse(readFileSync(storeFile, 'utf8')) as { clients: Array<{ rooms: string[] }> }
		data.clients[0].rooms.push('other-board')
		writeFileSync(storeFile, JSON.stringify(data))
		expect((await machineUpload(token, f.boardId, 'stl', stl(2, 5))).statusCode).toBe(401)
		expect((await machineUpload(token, 'other-board', 'stl', stl(2, 6))).statusCode).toBe(401)
		expect(assetFiles()).toEqual([])
	})

	it('fails closed if the store ever lists the capability on a credential without write access', async () => {
		const { token } = await cadClient()
		editStoredClient((client) => { client.permissions = ['read'] })
		expect((await machineUpload(token, f.boardId, 'stl', stl(2, 8))).statusCode).toBe(401)
		expect((await machineModel(token, f.boardId, modelBody('cad-0.stl'))).statusCode).toBe(401)
		expect(assetFiles()).toEqual([])
	})

	it('refuses a deleted board with 404 and stores nothing', async () => {
		const { token } = await cadClient()
		expect((await f.owner.delete(`/api/boards/${f.boardId}`)).statusCode).toBe(200)
		expect((await machineUpload(token, f.boardId, 'stl', stl(2, 7))).statusCode).toBe(404)
		expect((await machineModel(token, f.boardId, modelBody('cad-0.stl'))).statusCode).toBe(404)
		expect(assetFiles()).toEqual([])
	})

	it('ignores a browser session: the owner cookie is not a machine credential', async () => {
		const response = await f.owner.request('POST', `/api/boards/${f.boardId}/cad-machine/artifacts/stl`, stl(), OCTET)
		expect(response.statusCode).toBe(401)
		expect(assetFiles()).toEqual([])
	})

	it('keeps every signed-in route session-only: a capability bearer is refused there', async () => {
		const { token } = await cadClient()
		const artifact = await f.app.inject({ method: 'POST', url: `/api/boards/${f.boardId}/cad-artifacts/stl`, headers: bearer(token), payload: stl() })
		const model = await f.app.inject({ method: 'POST', url: `/api/boards/${f.boardId}/cad-models`, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, payload: modelBody('cad-0.stl') as never })
		const status = await f.app.inject({ method: 'POST', url: `/api/boards/${f.boardId}/cad-models/abc/revisions/rev-x/status`, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, payload: { to: 'approved' } })
		const generic = await f.app.inject({ method: 'POST', url: `/api/boards/${f.boardId}/uploads/part.stl`, headers: bearer(token), payload: stl() })
		for (const response of [artifact, model, status, generic]) expect([401, 403]).toContain(response.statusCode)
		expect(assetFiles()).toEqual([])
		expect(cadModels()).toEqual([])
	})

	it('serves exactly two machine paths on the machine hostname, and not the signed-in CAD routes', () => {
		expect(isMachineRoute('POST', '/api/boards/b1/cad-machine/artifacts/stl')).toBe(true)
		expect(isMachineRoute('POST', '/api/boards/b1/cad-machine/artifacts/glb?name=x')).toBe(true)
		expect(isMachineRoute('POST', '/api/boards/b1/cad-machine/models')).toBe(true)
		for (const path of ['/api/boards/b1/cad-artifacts/stl', '/api/boards/b1/cad-models', '/api/boards/b1/cad-machine/artifacts/exe', '/api/boards/b1/cad-machine/artifacts/stl/x', '/api/boards/b1/cad-machine/models/abc/revisions', '/api/boards/b1/uploads/x.stl', '/api/boards/b1/assets/cad-1.stl']) {
			expect(isMachineRoute('POST', path), path).toBe(false)
		}
		expect(isMachineRoute('GET', '/api/boards/b1/cad-machine/models')).toBe(false)
		expect(isMachineRoute('DELETE', '/api/boards/b1/cad-machine/models')).toBe(false)
	})
})

describe('uploads are validated like the signed-in path', () => {
	it('stores a good STL under its content hash and serves it back to the board', async () => {
		const { token } = await cadClient()
		const bytes = stl(5, 10)
		const response = await machineUpload(token, f.boardId, 'stl', bytes, 'burger_base.stl')
		expect(response.statusCode).toBe(201)
		const { artifact } = response.json()
		expect(artifact.sha256).toBe(sha(bytes))
		expect(artifact.assetId).toBe(`cad-${sha(bytes)}.stl`)
		expect(artifact.bytes).toBe(bytes.length)
		expect(artifact.name).toBe('burger_base.stl')
		const served = await f.editor.get(`/api/boards/${f.boardId}/assets/${artifact.assetId}`)
		expect(served.statusCode).toBe(200)
		expect(served.headers['content-type']).toBe('model/stl')
		expect(served.rawPayload.equals(bytes)).toBe(true)
		// A person who is not on the board still cannot read it.
		expect((await f.nonmember.get(`/api/boards/${f.boardId}/assets/${artifact.assetId}`)).statusCode).toBe(404)
	})

	it('treats a repeated upload of the same bytes as one file', async () => {
		const { token } = await cadClient()
		const bytes = stl(3, 20)
		const first = await machineUpload(token, f.boardId, 'stl', bytes)
		const second = await machineUpload(token, f.boardId, 'stl', bytes)
		expect(first.statusCode).toBe(201)
		expect(second.statusCode).toBe(201)
		expect(second.json().artifact.assetId).toBe(first.json().artifact.assetId)
		expect(assetFiles()).toEqual([first.json().artifact.assetId])
	})

	it('refuses malformed files with 422 and stores nothing', async () => {
		const { token } = await cadClient()
		const truncated = stl(4, 30).subarray(0, 120)
		const cases: Array<[string, Buffer | string]> = [
			['stl', Buffer.from('not an stl')],
			['stl', truncated],
			['stl', Buffer.alloc(84)],
			['glb', stl()],
			['glb', Buffer.from('glTF but not really a glb file at all......')],
			['step', stl()],
			['thumbnail', stl()],
		]
		for (const [kind, body] of cases) expect((await machineUpload(token, f.boardId, kind, body)).statusCode, kind).toBe(422)
		expect((await machineUpload(token, f.boardId, 'stl', Buffer.alloc(0))).statusCode).toBeGreaterThanOrEqual(400)
		const json = await f.app.inject({ method: 'POST', url: `/api/boards/${f.boardId}/cad-machine/artifacts/stl`, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, payload: { stl: 'x' } })
		expect(json.statusCode).toBe(422)
		expect(assetFiles()).toEqual([])
	})

	it('refuses an unknown kind', async () => {
		const { token } = await cadClient()
		expect((await machineUpload(token, f.boardId, 'exe', stl())).statusCode).toBe(400)
		expect(assetFiles()).toEqual([])
	})

	it('refuses an oversized file and stores nothing', async () => {
		const { token } = await cadClient()
		const huge = Buffer.alloc(20_000_001)
		huge.writeUInt32LE(1, 80)
		expect((await machineUpload(token, f.boardId, 'stl', huge)).statusCode).toBe(413)
		expect(assetFiles()).toEqual([])
	})

	it('shares the signed-in upload budget logic: the 429 comes per credential and board', async () => {
		await f.cleanup()
		f = await createAcceptanceFixture({ rateLimits: { upload: { limit: 2, windowMs: 60_000 }, write: { limit: 1_000, windowMs: 60_000 } } })
		process.env.CANVAS_API_TOKENS_FILE = storeFile
		const { token } = await cadClient()
		expect((await machineUpload(token, f.boardId, 'stl', stl(2, 40))).statusCode).toBe(201)
		expect((await machineUpload(token, f.boardId, 'stl', stl(2, 41))).statusCode).toBe(201)
		expect((await machineUpload(token, f.boardId, 'stl', stl(2, 42))).statusCode).toBe(429)
		expect(assetFiles()).toHaveLength(2)
	})
})

describe('a model entry and its card are written together, as an AI actor', () => {
	it('creates a visual-only model with a card at the requested place, attributed to the credential', async () => {
		const { token } = await cadClient()
		const bytes = stl(6, 50)
		const artifact = (await machineUpload(token, f.boardId, 'stl', bytes)).json().artifact
		const response = await machineModel(token, f.boardId, modelBody(artifact.assetId))
		expect(response.statusCode, response.body).toBe(201)
		const { model, card } = response.json()
		expect(model.modelId).toBe('test-part')
		expect(model.units).toBe('mm')
		expect(model.revisions[0].files.stl).toMatchObject({ assetId: artifact.assetId, sha256: sha(bytes), bytes: bytes.length })
		expect(model.revisions[0].files.step).toBeUndefined()
		expect(JSON.stringify(model.createdBy ?? model.revisions[0].createdBy)).toContain('"source":"ai"')
		const stored = cadModels()
		expect(stored).toHaveLength(1)
		const shapes = cadCards()
		expect(shapes).toHaveLength(1)
		expect(shapes[0]).toMatchObject({ id: card.id, parentId: 'page:page', x: 100, y: 200 })
		expect((shapes[0].props as { modelRecordId: string }).modelRecordId).toBe(model.id)
		const history = await f.owner.get(`/api/boards/${f.boardId}/history`)
		expect(history.statusCode).toBe(200)
		expect(JSON.stringify(history.json())).toContain('cad.model.created')
		expect(JSON.stringify(history.json())).toContain('token:cad-agent')
	})

	it('cannot approve: review stays with people, and a status change by the same credential is refused', async () => {
		const { token } = await cadClient()
		const artifact = (await machineUpload(token, f.boardId, 'stl', stl(2, 60))).json().artifact
		const { model } = (await machineModel(token, f.boardId, modelBody(artifact.assetId))).json()
		const recordId = (model.id as string).slice('cad_model:'.length)
		const url = `/api/boards/${f.boardId}/cad-models/${recordId}/revisions/${model.revisions[0].id}/status`
		const response = await f.app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, payload: { to: 'approved' } })
		expect([401, 403]).toContain(response.statusCode)
		expect((cadModels()[0] as { revisions: Array<{ status?: string; approval?: unknown }> }).revisions[0].status).not.toBe('approved')
	})

	it('needs a placement and an explicit model ID, and refuses extra fields', async () => {
		const { token } = await cadClient()
		const artifact = (await machineUpload(token, f.boardId, 'stl', stl(2, 70))).json().artifact
		const { placement: _placement, ...noPlacement } = modelBody(artifact.assetId)
		const { modelId: _modelId, ...noId } = modelBody(artifact.assetId)
		expect((await machineModel(token, f.boardId, noPlacement)).statusCode).toBe(422)
		expect((await machineModel(token, f.boardId, noId)).statusCode).toBe(422)
		expect((await machineModel(token, f.boardId, modelBody(artifact.assetId, { surprise: true }))).statusCode).toBe(422)
		expect((await machineModel(token, f.boardId, modelBody(artifact.assetId, { placement: { pageId: 'page:page', x: Number.NaN, y: 0 } }))).statusCode).toBe(422)
		expect((await machineModel(token, f.boardId, modelBody(artifact.assetId, { placement: { pageId: 'page:page', x: 5_000_000, y: 0 } }))).statusCode).toBe(422)
		expect(cadModels()).toEqual([])
		expect(cadCards()).toEqual([])
	})

	it('writes nothing when the page does not exist, and refuses a duplicate model ID without a second card', async () => {
		const { token } = await cadClient()
		const artifact = (await machineUpload(token, f.boardId, 'stl', stl(2, 80))).json().artifact
		const missing = await machineModel(token, f.boardId, modelBody(artifact.assetId, { placement: { pageId: 'page:nowhere', x: 0, y: 0 } }))
		expect(missing.statusCode).toBe(404)
		expect(cadModels()).toEqual([])
		expect(cadCards()).toEqual([])
		expect((await machineModel(token, f.boardId, modelBody(artifact.assetId))).statusCode).toBe(201)
		const again = await machineModel(token, f.boardId, modelBody(artifact.assetId))
		expect(again.statusCode).toBe(409)
		expect(cadModels()).toHaveLength(1)
		expect(cadCards()).toHaveLength(1)
	})

	it('refuses a file that was uploaded to another board', async () => {
		const { token } = await cadClient()
		const otherBoard = await f.owner.post('/api/boards', { name: 'Other', id: 'other-board' })
		expect(otherBoard.statusCode).toBe(200)
		const foreign = await cadClient({ name: 'cad-other', rooms: ['other-board'] })
		const artifact = (await machineUpload(foreign.token, 'other-board', 'stl', stl(2, 90))).json().artifact
		const response = await machineModel(token, f.boardId, modelBody(artifact.assetId))
		expect(response.statusCode).toBe(404)
		expect(cadModels()).toEqual([])
	})

	it('leaves existing signed-in behaviour alone: an editor still uploads and creates a model by session', async () => {
		const bytes = stl(2, 100)
		const artifact = (await f.editor.request('POST', `/api/boards/${f.boardId}/cad-artifacts/stl?name=part.stl`, bytes, OCTET)).json().artifact
		expect(artifact.assetId).toBe(`cad-${sha(bytes)}.stl`)
		const created = await f.editor.post(`/api/boards/${f.boardId}/cad-models`, { name: 'By hand', units: 'mm', files: { stl: { assetId: artifact.assetId } } })
		expect(created.statusCode).toBe(201)
		expect(cadCards()).toEqual([])
		expect(existsSync(join(f.directory, 'assets', artifact.assetId))).toBe(true)
		void buildSampleGlb
	})
})

/** Edits the one stored client by hand, as an operator or an older tool might. */
function editStoredClient(change: (client: Record<string, unknown>) => void) {
	const data = JSON.parse(readFileSync(storeFile, 'utf8')) as { clients: Array<Record<string, unknown>> }
	change(data.clients[0])
	writeFileSync(storeFile, JSON.stringify(data))
}

describe('a cad-upload credential must expire, within the maximum', () => {
	it('pins the policy at 365 days: the longest expiry the Agents page offers any agent (raised from 30 on 2026-11-08, ADR 013)', () => {
		expect(CAD_UPLOAD_MAX_LIFETIME_DAYS).toBe(365)
	})

	it('is refused at mint without an expiry, or with one beyond the maximum, and nothing is written', async () => {
		await expect(cadClient({ expiresAt: undefined })).rejects.toMatchObject({ code: 'invalid-expiry', message: expect.stringContaining(`${CAP} days`) })
		await expect(cadClient({ expiresAt: new Date(Date.now() + (CAP + 1) * DAY) })).rejects.toMatchObject({ code: 'invalid-expiry' })
		await expect(cadClient({ expiresAt: new Date(Date.now() + 10 * 365 * DAY) })).rejects.toMatchObject({ code: 'invalid-expiry' })
		await expect(cadClient({ expiresAt: new Date(Date.now() - DAY) })).rejects.toMatchObject({ code: 'invalid-expiry' })
		expect(existsSync(storeFile)).toBe(false)
	})

	it('allows the maximum, and a one-hour allowance for a requester whose clock runs ahead, and not a millisecond more (clock pinned)', async () => {
		const now = new Date('2026-11-07T12:00:00.000Z')
		const maximum = new Date(now.getTime() + CAP * DAY)
		await expect(cadClient({ now, expiresAt: maximum })).resolves.toMatchObject({ capabilities: ['cad-upload'], expiresAt: maximum.toISOString() })
		const limit = new Date(maximum.getTime() + CAD_UPLOAD_CLOCK_ALLOWANCE_MS)
		expect(CAD_UPLOAD_CLOCK_ALLOWANCE_MS).toBe(3_600_000)
		await expect(cadClient({ name: 'at-the-limit', now, expiresAt: limit })).resolves.toMatchObject({ expiresAt: limit.toISOString() })
		await expect(cadClient({ name: 'one-ms-over', now, expiresAt: new Date(limit.getTime() + 1) })).rejects.toMatchObject({ code: 'invalid-expiry' })
	})

	it("accepts the exact expiry of the Otto board's existing agent token, which is under a year away (clock pinned to when it was asked for)", async () => {
		const now = new Date('2026-11-08T18:35:00.000Z')
		const sameAsTheAgentToken = new Date('2027-10-29T19:52:02.707Z')
		expect((sameAsTheAgentToken.getTime() - now.getTime()) / DAY).toBeLessThan(CAP)
		await expect(cadClient({ now, expiresAt: sameAsTheAgentToken })).resolves.toMatchObject({ capabilities: ['cad-upload'], expiresAt: '2027-10-29T19:52:02.707Z' })
	})

	it('leaves ordinary credentials alone: no expiry and an expiry far beyond the maximum are both still allowed for them', async () => {
		await expect(createClient({ file: storeFile, name: 'plain-forever', rooms: [f.boardId], access: 'read-write' })).resolves.toMatchObject({ name: 'plain-forever' })
		await expect(createClient({ file: storeFile, name: 'plain-long', rooms: [f.boardId], access: 'read-write', expiresAt: new Date(Date.now() + 10 * 365 * DAY) })).resolves.toMatchObject({ name: 'plain-long' })
	})

	it('keeps the rule on rotation: beyond the maximum is refused; a longer one inside it, an unchanged one and a shorter one keep the capability', async () => {
		await cadClient({ expiresAt: new Date(Date.now() + 10 * DAY) })
		await expect(rotateClient({ file: storeFile, name: 'cad-agent', expiresAt: new Date(Date.now() + (CAP + 30) * DAY) })).rejects.toMatchObject({ code: 'invalid-expiry' })
		const longer = await rotateClient({ file: storeFile, name: 'cad-agent', expiresAt: new Date(Date.now() + (CAP - 10) * DAY) })
		expect(longer.capabilities).toEqual(['cad-upload'])
		expect((await machineUpload(longer.token, f.boardId, 'stl', stl(2, 10))).statusCode).toBe(201)
		const kept = await rotateClient({ file: storeFile, name: 'cad-agent' })
		expect(kept.capabilities).toEqual(['cad-upload'])
		expect((await machineUpload(kept.token, f.boardId, 'stl', stl(2, 11))).statusCode).toBe(201)
		const shorter = await rotateClient({ file: storeFile, name: 'cad-agent', expiresAt: new Date(Date.now() + 3 * DAY) })
		expect(shorter.capabilities).toEqual(['cad-upload'])
		expect((await machineUpload(shorter.token, f.boardId, 'stl', stl(2, 12))).statusCode).toBe(201)
	})

	it('takes the capability away with write access, so putting write back does not bring CAD upload back', async () => {
		await cadClient()
		const demoted = await rotateClient({ file: storeFile, name: 'cad-agent', access: 'read' })
		expect(demoted.capabilities).toBeUndefined()
		expect(demoted.droppedCapabilities).toEqual(['cad-upload'])
		expect(JSON.parse(readFileSync(storeFile, 'utf8')).clients[0].capabilities).toBeUndefined()
		const restored = await rotateClient({ file: storeFile, name: 'cad-agent', access: 'read-write' })
		expect(restored.capabilities).toBeUndefined()
		expect(restored.droppedCapabilities).toBeUndefined()
		expect((await machineUpload(restored.token, f.boardId, 'stl', stl(2, 18))).statusCode).toBe(401)
		expect(assetFiles()).toEqual([])
	})

	it('does not drop it when the new access still includes write, and a demotion needs no valid expiry because nothing is left to limit', async () => {
		await cadClient()
		const kept = await rotateClient({ file: storeFile, name: 'cad-agent', access: 'read-write-history' })
		expect(kept.capabilities).toEqual(['cad-upload'])
		expect(kept.droppedCapabilities).toBeUndefined()
		editStoredClient((client) => { client.expiresAt = new Date(Date.now() + (CAP + 60) * DAY).toISOString() })
		const demoted = await rotateClient({ file: storeFile, name: 'cad-agent', access: 'read' })
		expect(demoted.droppedCapabilities).toEqual(['cad-upload'])
	})

	it('refuses to rotate a capability credential that has lost its expiry or sits past the maximum, until a valid one is given', async () => {
		await cadClient()
		editStoredClient((client) => { delete client.expiresAt })
		await expect(rotateClient({ file: storeFile, name: 'cad-agent' })).rejects.toMatchObject({ code: 'invalid-expiry' })
		editStoredClient((client) => { client.expiresAt = new Date(Date.now() + (CAP + 60) * DAY).toISOString() })
		await expect(rotateClient({ file: storeFile, name: 'cad-agent' })).rejects.toMatchObject({ code: 'invalid-expiry' })
		const fixed = await rotateClient({ file: storeFile, name: 'cad-agent', expiresAt: new Date(Date.now() + 5 * DAY) })
		expect((await machineUpload(fixed.token, f.boardId, 'stl', stl(2, 17))).statusCode).toBe(201)
	})

	it('refuses at use a credential whose expiry was removed, garbled or pushed past the maximum by hand, and honours one inside the window, a year-long one included', async () => {
		const { token } = await cadClient()
		editStoredClient((client) => { delete client.expiresAt })
		expect((await machineUpload(token, f.boardId, 'stl', stl(2, 13))).statusCode).toBe(401)
		editStoredClient((client) => { client.expiresAt = new Date(Date.now() + (CAP + 60) * DAY).toISOString() })
		expect((await machineUpload(token, f.boardId, 'stl', stl(2, 14))).statusCode).toBe(401)
		editStoredClient((client) => { client.expiresAt = 'next tuesday' })
		expect((await machineUpload(token, f.boardId, 'stl', stl(2, 15))).statusCode).toBe(401)
		expect(assetFiles()).toEqual([])
		editStoredClient((client) => { client.expiresAt = new Date(Date.now() + 20 * DAY).toISOString() })
		expect((await machineUpload(token, f.boardId, 'stl', stl(2, 16))).statusCode).toBe(201)
		expect(assetFiles()).toHaveLength(1)
		editStoredClient((client) => { client.expiresAt = new Date(Date.now() + (CAP - 10) * DAY).toISOString() })
		expect((await machineUpload(token, f.boardId, 'stl', stl(2, 19))).statusCode).toBe(201)
		expect(assetFiles()).toHaveLength(2)
	})

	it('draws the use-time line at the same place as the mint: the maximum plus the allowance from now', async () => {
		const { token } = await cadClient()
		const at = Date.now()
		editStoredClient((client) => { client.expiresAt = new Date(at + CAP * DAY + CAD_UPLOAD_CLOCK_ALLOWANCE_MS).toISOString() })
		expect(authorizeApiCapability(`Bearer ${token}`, f.boardId, 'cad-upload', at)).toBe('cad-agent')
		expect(authorizeApiCapability(`Bearer ${token}`, f.boardId, 'cad-upload', at - 1)).toBeNull()
	})
})

describe('a credential that lasts as long as the Otto board\'s agent token does everything a short one does, and nothing more', () => {
	const longExpiry = () => new Date(Date.now() + 355 * DAY)

	it('uploads, creates a model and its card, and is attributed to the credential', async () => {
		const { token } = await cadClient({ expiresAt: longExpiry() })
		const bytes = stl(6, 70)
		const artifact = (await machineUpload(token, f.boardId, 'stl', bytes)).json().artifact
		expect(artifact.sha256).toBe(sha(bytes))
		const response = await machineModel(token, f.boardId, modelBody(artifact.assetId, { modelId: 'long-lived-part' }))
		expect(response.statusCode, response.body).toBe(201)
		expect(JSON.stringify(response.json().model.revisions[0].createdBy)).toContain('"source":"ai"')
		expect(cadCards()).toHaveLength(1)
		const history = await f.owner.get(`/api/boards/${f.boardId}/history`)
		expect(JSON.stringify(history.json())).toContain('token:cad-agent')
	})

	it('is refused on any other board, however long it lasts', async () => {
		const { token } = await cadClient({ expiresAt: longExpiry() })
		expect((await f.owner.post('/api/boards', { name: 'Other board', id: 'other-board' })).statusCode).toBe(200)
		expect((await machineUpload(token, 'other-board', 'stl', stl(2, 71))).statusCode).toBe(401)
		expect(assetFiles()).toEqual([])
	})

	it('still needs write access and exactly one board to be minted', async () => {
		await expect(cadClient({ access: 'read', expiresAt: longExpiry() })).rejects.toMatchObject({ code: 'invalid-capabilities' })
		await expect(cadClient({ rooms: [f.boardId, 'other-board'], expiresAt: longExpiry() })).rejects.toMatchObject({ code: 'invalid-capabilities' })
		expect(existsSync(storeFile)).toBe(false)
	})

	it('is refused after revocation, like any other credential', async () => {
		const { token } = await cadClient({ expiresAt: longExpiry() })
		expect((await machineUpload(token, f.boardId, 'stl', stl(2, 72))).statusCode).toBe(201)
		await revokeClient(storeFile, 'cad-agent')
		expect([401, 403]).toContain((await machineUpload(token, f.boardId, 'stl', stl(2, 73))).statusCode)
		expect(assetFiles()).toHaveLength(1)
	})

	it('is not matched by an ordinary credential with the same long expiry: the expiry grants nothing', async () => {
		const plain = await createClient({ file: storeFile, name: 'plain-long', rooms: [f.boardId], access: 'full', expiresAt: longExpiry() })
		expect((await machineUpload(plain.token, f.boardId, 'stl', stl(2, 74))).statusCode).toBe(401)
		expect(assetFiles()).toEqual([])
	})
})
