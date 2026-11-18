import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { createHistoricalStore } from '../client/history/historicalStore'
import { AuthDatabase } from '../server/auth-db'
import { registerCadRoutes } from '../server/cad-routes'
import { SlidingWindowRateLimiter } from '../server/security'
import { applyRoomActions } from '../server/canvas-api'
import { getRoomHandle } from '../server/rooms'
import { cadModelSchema, type CadModel } from '../shared/cad-model'
import { buildSampleAssemblyGlb, buildSampleGlb, SAMPLE_STEP_TEXT } from '../shared/cad-sample'
import { createAcceptanceFixture, type AcceptanceFixture, type FixtureIdentity } from './helpers/acceptance-fixture'
import { connectRoomClient, settle, until } from './helpers/room-client'

;(globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame ??= (callback: (time: number) => void) => setTimeout(() => callback(Date.now()), 16)
;(globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame ??= (id: ReturnType<typeof setTimeout>) => clearTimeout(id)

const fixtures: AcceptanceFixture[] = []
const closers: Array<{ close(): void }> = []
async function fixture(options: Parameters<typeof createAcceptanceFixture>[0] = { rateLimits: { upload: { limit: 1_000, windowMs: 60_000 }, write: { limit: 1_000, windowMs: 60_000 } } }) {
	const built = await createAcceptanceFixture(options)
	fixtures.push(built)
	return built
}
afterEach(async () => {
	for (const closer of closers.splice(0)) closer.close()
	for (const built of fixtures.splice(0)) await built.cleanup()
})

const sampleGlb = () => Buffer.from(buildSampleGlb())
const stepBytes = () => Buffer.from(SAMPLE_STEP_TEXT)
const OCTET = { 'content-type': 'application/octet-stream' }

function upload(who: FixtureIdentity, boardId: string, kind: string, body: Buffer, name = 'part') {
	return who.request('POST', `/api/boards/${boardId}/cad-artifacts/${kind}?name=${name}`, body, OCTET)
}

/** A one-pixel-tall PNG header, enough for the structural check; `height` makes each one distinct. */
function pngBytes(height = 1) {
	const bytes = Buffer.alloc(33)
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes)
	bytes.writeUInt32BE(13, 8)
	bytes.write('IHDR', 12, 'latin1')
	bytes.writeUInt32BE(64, 16)
	bytes.writeUInt32BE(height, 20)
	return bytes
}

async function createModel(f: AcceptanceFixture, who: FixtureIdentity = f.editor, extra: Record<string, unknown> = {}) {
	const glb = (await upload(who, f.boardId, 'glb', sampleGlb(), 'spacer.glb')).json().artifact
	const step = (await upload(who, f.boardId, 'step', stepBytes(), 'spacer.step')).json().artifact
	const thumb = (await upload(who, f.boardId, 'thumbnail', pngBytes())).json().artifact
	const response = await who.post(`/api/boards/${f.boardId}/cad-models`, {
		name: 'Machine spacer', units: 'mm', changeNote: 'Measured baseline',
		files: { glb: { assetId: glb.assetId, name: glb.name }, step: { assetId: step.assetId, name: step.name } },
		thumbnailAssetId: thumb.assetId,
		...extra,
	})
	return { response, glb, step, thumb, model: (response.statusCode === 201 ? response.json().model : null) as CadModel }
}
const recordKey = (model: CadModel) => model.id.slice('cad_model:'.length)
const modelUrl = (f: AcceptanceFixture, model: CadModel, tail = '') => `/api/boards/${f.boardId}/cad-models/${recordKey(model)}${tail}`
const stored = (f: AcceptanceFixture, id: string) => getRoomHandle(f.boardId).room.getCurrentSnapshot().documents.find((entry) => entry.state.id === id)?.state as unknown as CadModel | undefined

describe('CAD files are served only to people who may read the board', () => {
	it('lets owner, editor and viewer fetch an artifact, with the right content type and no sniffing', async () => {
		const f = await fixture()
		const { glb } = await createModel(f)
		for (const who of [f.owner, f.editor, f.viewer]) {
			const response = await who.get(`/api/boards/${f.boardId}/assets/${glb.assetId}`)
			expect(response.statusCode).toBe(200)
			expect(response.headers['content-type']).toBe('model/gltf-binary')
			expect(response.headers['x-content-type-options']).toBe('nosniff')
			expect(response.rawPayload.equals(sampleGlb())).toBe(true)
		}
	})

	it('refuses an anonymous user (401) and a signed-in nonmember (404), for the model, the source and the thumbnail', async () => {
		const f = await fixture()
		const { glb, step, thumb } = await createModel(f)
		for (const artifact of [glb, step, thumb]) {
			expect((await f.anonymous.get(`/api/boards/${f.boardId}/assets/${artifact.assetId}`)).statusCode).toBe(401)
			expect((await f.nonmember.get(`/api/boards/${f.boardId}/assets/${artifact.assetId}`)).statusCode).toBe(404)
		}
	})

	it('refuses a member of another board who asks for the file through their own board', async () => {
		const f = await fixture()
		const { glb } = await createModel(f)
		const own = await f.nonmember.post('/api/boards', { name: 'Elsewhere', id: 'elsewhere-board' })
		expect(own.statusCode).toBe(200)
		expect((await f.nonmember.get(`/api/boards/elsewhere-board/assets/${glb.assetId}`)).statusCode).toBe(404)
		expect((await f.nonmember.get(`/api/boards/${f.boardId}/assets/${glb.assetId}`)).statusCode).toBe(404)
	})

	it('stops serving a removed member immediately', async () => {
		const f = await fixture()
		const { glb } = await createModel(f)
		expect((await f.viewer.get(`/api/boards/${f.boardId}/assets/${glb.assetId}`)).statusCode).toBe(200)
		expect((await f.owner.put(`/api/boards/${f.boardId}/members/${f.viewer.userId}`, { role: null })).statusCode).toBe(200)
		expect((await f.viewer.get(`/api/boards/${f.boardId}/assets/${glb.assetId}`)).statusCode).toBe(404)
	})

	it('stops serving a deleted board', async () => {
		const f = await fixture()
		const { glb } = await createModel(f)
		expect((await f.owner.delete(`/api/boards/${f.boardId}`)).statusCode).toBeLessThan(300)
		expect((await f.editor.get(`/api/boards/${f.boardId}/assets/${glb.assetId}`)).statusCode).toBe(404)
	})

	it('does not serve a sample or any CAD file as a static asset', async () => {
		// The shipped client directory is what the static handler serves. Build it the way the tree is (public/ contents only).
		const { buildApp } = await import('../server/app')
		const { cpSync, mkdtempSync, rmSync, writeFileSync } = await import('node:fs')
		const { tmpdir } = await import('node:os')
		const { join } = await import('node:path')
		const root = mkdtempSync(join(tmpdir(), 'canvas-cad-client-'))
		const client = join(root, 'client')
		cpSync(join(process.cwd(), 'public'), client, { recursive: true })
		writeFileSync(join(client, 'index.html'), '<!doctype html><title>shell</title>')
		const app = await buildApp({ dataDirectory: join(root, 'data'), clientDirectory: client, serveClient: true, logger: false })
		try {
			for (const path of ['/cad/sample-machine-spacer.step', '/cad/sample-machine-spacer-r1.stl', '/cad/training-spacer.glb']) {
				const response = await app.inject({ method: 'GET', url: path })
				expect(response.body).not.toMatch(/ISO-10303|solid|glTF/)
				expect(response.headers['content-type']).toMatch(/text\/html/)
			}
		} finally { await app.close(); rmSync(root, { recursive: true, force: true }) }
	})
})

describe('CAD artifact upload', () => {
	it('requires a signed-in board writer', async () => {
		const f = await fixture()
		expect((await upload(f.anonymous, f.boardId, 'glb', sampleGlb())).statusCode).toBe(401)
		expect((await upload(f.nonmember, f.boardId, 'glb', sampleGlb())).statusCode).toBe(404)
		expect((await upload(f.viewer, f.boardId, 'glb', sampleGlb())).statusCode).toBe(403)
		expect((await upload(f.editor, f.boardId, 'glb', sampleGlb())).statusCode).toBe(201)
	})

	it('refuses a machine bearer token: these are browser routes', async () => {
		const f = await fixture()
		const bearer = { ...OCTET, authorization: `Bearer ${'a'.repeat(48)}` }
		expect((await f.anonymous.request('POST', `/api/boards/${f.boardId}/cad-artifacts/glb`, sampleGlb(), bearer)).statusCode).toBe(401)
		expect((await f.anonymous.request('POST', `/api/boards/${f.boardId}/cad-models`, {}, { authorization: `Bearer ${'a'.repeat(48)}` })).statusCode).toBe(401)
	})

	it('is content-addressed and idempotent', async () => {
		const f = await fixture()
		const first = (await upload(f.editor, f.boardId, 'glb', sampleGlb())).json().artifact
		const second = (await upload(f.owner, f.boardId, 'glb', sampleGlb())).json().artifact
		expect(second.assetId).toBe(first.assetId)
		expect(first.assetId).toBe(`cad-${first.sha256}.glb`)
		expect(first.bytes).toBe(sampleGlb().length)
	})

	it('validates the file server-side', async () => {
		const f = await fixture()
		expect((await upload(f.editor, f.boardId, 'glb', Buffer.from('not a glb'))).statusCode).toBe(422)
		expect((await upload(f.editor, f.boardId, 'step', Buffer.from('not step'))).statusCode).toBe(422)
		expect((await upload(f.editor, f.boardId, 'thumbnail', Buffer.from('not a png'))).statusCode).toBe(422)
		expect((await upload(f.editor, f.boardId, 'exe', Buffer.from('MZ'))).statusCode).toBe(400)
		expect((await upload(f.editor, f.boardId, 'thumbnail', Buffer.alloc(2_000_001))).statusCode).toBe(413)
	})

	it('cannot have a cad- artifact planted through the generic upload route', async () => {
		const f = await fixture()
		const planted = `cad-${'1'.repeat(64)}.glb`
		const response = await f.editor.request('POST', `/api/boards/${f.boardId}/uploads/${planted}`, Buffer.from('evil'), OCTET)
		expect(response.statusCode).toBe(400)
		expect((await f.editor.get(`/api/boards/${f.boardId}/assets/${planted}`)).statusCode).toBe(404)
	})

	it('caps the CAD artifacts one board may hold, and still accepts a repeat of one it already has', async () => {
		const f = await fixture()
		const first = (await upload(f.editor, f.boardId, 'thumbnail', pngBytes(1))).json().artifact
		for (let height = 2; height <= 300; height++) expect((await upload(f.editor, f.boardId, 'thumbnail', pngBytes(height))).statusCode).toBe(201)
		expect((await upload(f.editor, f.boardId, 'thumbnail', pngBytes(301))).statusCode).toBe(422)
		expect((await upload(f.editor, f.boardId, 'thumbnail', pngBytes(1))).json().artifact.assetId).toBe(first.assetId)
	}, 60_000)
})

describe('CAD artifact write failures', () => {
	/** Replaces the asset directory with a plain file, so any write into it fails with ENOTDIR (not EEXIST). */
	function breakAssetDirectory(f: AcceptanceFixture) {
		const assets = join(f.directory, 'assets')
		rmSync(assets, { recursive: true, force: true })
		writeFileSync(assets, 'not a directory')
		return () => { rmSync(assets, { force: true }); mkdirSync(assets) }
	}
	const cadRows = (f: AcceptanceFixture) => {
		const database = new AuthDatabase(join(f.directory, 'auth.sqlite'))
		try { return database.countBoardAssetsWithPrefix(f.boardId, 'cad-') } finally { database.close() }
	}
	const leftovers = (f: AcceptanceFixture) => readdirSync(join(f.directory, 'assets')).filter((name) => name.startsWith('cad-'))

	it('does not leave a registered row or spend quota when the file cannot be written', async () => {
		const f = await fixture()
		const repair = breakAssetDirectory(f)
		const failed = await upload(f.editor, f.boardId, 'glb', sampleGlb())
		expect(failed.statusCode).toBe(500)
		expect(cadRows(f)).toBe(0)
		repair()
		expect(leftovers(f)).toEqual([])
		// The same upload now succeeds, and is the first (and only) artifact the board holds.
		const retry = await upload(f.editor, f.boardId, 'glb', sampleGlb())
		expect(retry.statusCode).toBe(201)
		expect(cadRows(f)).toBe(1)
		expect((await f.viewer.get(`/api/boards/${f.boardId}/assets/${retry.json().artifact.assetId}`)).rawPayload.equals(sampleGlb())).toBe(true)
	})

	it('never spends more quota on failures than on successes, however many fail', async () => {
		const f = await fixture()
		const repair = breakAssetDirectory(f)
		for (let attempt = 0; attempt < 5; attempt++) expect((await upload(f.editor, f.boardId, 'thumbnail', pngBytes(attempt + 1))).statusCode).toBe(500)
		expect(cadRows(f)).toBe(0)
		repair()
		for (let height = 1; height <= 300; height++) expect((await upload(f.editor, f.boardId, 'thumbnail', pngBytes(height))).statusCode).toBe(201)
		expect(cadRows(f)).toBe(300)
		expect((await upload(f.editor, f.boardId, 'thumbnail', pngBytes(301))).statusCode).toBe(422)
	}, 60_000)

	it('keeps a registered upload when a later duplicate of it fails to write', async () => {
		const f = await fixture()
		const first = (await upload(f.editor, f.boardId, 'glb', sampleGlb())).json().artifact
		expect(cadRows(f)).toBe(1)
		const repair = breakAssetDirectory(f)
		// The first upload's file is gone with the broken directory, so this duplicate really does try to write.
		expect((await upload(f.owner, f.boardId, 'glb', sampleGlb())).statusCode).toBe(500)
		// The row was reserved by the first upload, not by this request, so this request must not take it away.
		expect(cadRows(f)).toBe(1)
		repair()
		expect((await upload(f.owner, f.boardId, 'glb', sampleGlb())).json().artifact.assetId).toBe(first.assetId)
		expect(cadRows(f)).toBe(1)
	})

	it('accepts the same upload many times at once and ends with one row and one intact file', async () => {
		const f = await fixture()
		const responses = await Promise.all(Array.from({ length: 8 }, (_, index) => upload(index % 2 ? f.editor : f.owner, f.boardId, 'glb', sampleGlb())))
		expect(responses.map((response) => response.statusCode)).toEqual(Array(8).fill(201))
		expect(new Set(responses.map((response) => response.json().artifact.assetId)).size).toBe(1)
		expect(cadRows(f)).toBe(1)
		expect(readFileSync(join(f.directory, 'assets', responses[0].json().artifact.assetId)).equals(sampleGlb())).toBe(true)
		expect(readdirSync(join(f.directory, 'assets')).filter((name) => name.endsWith('.tmp'))).toEqual([])
	})
})

describe('CAD artifact registration races', () => {
	/** The route on its own with in-memory registration, so each registration step can be timed deliberately. */
	async function bareRoute(belongs: (id: string, calls: number) => boolean) {
		const directory = mkdtempSync(join(tmpdir(), 'canvas-cad-race-'))
		const rows = new Set<string>()
		let calls = 0
		const app = fastify({ logger: false })
		app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: 20_000_000 }, (_request, body, done) => done(null, body))
		const limiter = new SlidingWindowRateLimiter(1_000, 60_000)
		registerCadRoutes(app, {
			currentSession: () => ({ user: { id: 'u1', displayName: 'U One' }, session: {} }) as never,
			boardRole: () => 'editor',
			assetBelongsToBoard: (id) => { calls += 1; return belongs(id, calls) || rows.has(id) },
			registerAssetIfUnderCap: (_board, id) => { rows.add(id); return true },
			unregisterAsset: (_board, id) => { rows.delete(id) },
			assetDirectory: directory,
			uploadLimiter: limiter,
			writeLimiter: limiter,
		})
		const post = () => app.inject({ method: 'POST', url: '/api/boards/b1/cad-artifacts/glb', payload: sampleGlb(), headers: OCTET })
		return { app, rows, directory, post, done: async () => { await app.close(); rmSync(directory, { recursive: true, force: true }) } }
	}

	it('re-registers the asset if a racing request gave the row back while this one was writing the file', async () => {
		// First check: the row exists (a sibling reserved it). Before the file lands, the sibling fails and removes it.
		const route = await bareRoute((_id, calls) => calls === 1)
		try {
			const response = await route.post()
			expect(response.statusCode).toBe(201)
			expect(route.rows.has(response.json().artifact.assetId)).toBe(true)
			expect(readdirSync(route.directory)).toEqual([response.json().artifact.assetId])
		} finally { await route.done() }
	})

	it('gives the reservation back, and keeps nothing on disk, when its own write fails', async () => {
		const route = await bareRoute(() => false)
		try {
			rmSync(route.directory, { recursive: true, force: true })
			writeFileSync(route.directory, 'not a directory')
			expect((await route.post()).statusCode).toBe(500)
			expect([...route.rows]).toEqual([])
		} finally { rmSync(route.directory, { force: true }); await route.app.close() }
	})
})

describe('agents and CAD cards inside other shapes', () => {
	it('refuses an agent deleting a frame that holds a CAD card, and still deletes an unrelated frame', async () => {
		const f = await fixture()
		const handle = getRoomHandle(f.boardId)
		const editor = connectRoomClient(handle, 'editor', 'editor')
		closers.push(editor.client)
		await until(() => editor.state.loaded)
		const { model } = await createModel(f)
		const page = editor.store.allRecords().find((record) => record.typeName === 'page')!
		const base = { typeName: 'shape', x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {} }
		editor.store.put([
			{ ...base, id: 'shape:outer', type: 'frame', index: 'a1', parentId: page.id, props: { w: 800, h: 600, name: 'Outer', color: 'black' } },
			{ ...base, id: 'shape:inner', type: 'frame', index: 'a1', parentId: 'shape:outer', props: { w: 500, h: 400, name: 'Inner', color: 'black' } },
			{ ...base, id: 'shape:cadcard', type: 'cad-review', index: 'a1', parentId: 'shape:inner', props: { w: 360, h: 300, modelRecordId: model.id } },
			{ ...base, id: 'shape:plain', type: 'frame', index: 'a2', parentId: page.id, props: { w: 100, h: 100, name: 'Plain', color: 'black' } },
		] as never[])
		const present = (id: string) => handle.room.getCurrentSnapshot().documents.some((entry) => entry.state.id === id)
		await until(() => present('shape:cadcard') && present('shape:plain'))
		const actor = { actorUserId: 'token:agent', displayName: 'agent' }
		const attempt = (id: string) => {
			try { applyRoomActions(handle.room, { actions: [{ tool: 'delete_shape', id }] }, actor) } catch (caught) { return caught as { statusCode?: number; code?: string } }
			return null
		}
		// The top-level frame holds the card two levels down: refused, and nothing is removed.
		expect(attempt('shape:outer')).toMatchObject({ statusCode: 403, code: 'cad_card_protected' })
		// Shapes nested in a frame are not addressable by the agent API at all.
		expect(attempt('shape:inner')).toMatchObject({ statusCode: 404 })
		for (const id of ['shape:outer', 'shape:inner', 'shape:cadcard']) expect(present(id)).toBe(true)
		applyRoomActions(handle.room, { actions: [{ tool: 'delete_shape', id: 'shape:plain' }] }, actor)
		expect(present('shape:plain')).toBe(false)
	})
})

/*
 * MVP policy decisions, pinned so a later change to any of them is deliberate. Each is described in
 * the CAD review design note ("Policy decisions").
 */
describe('CAD MVP policy decisions', () => {
	async function checkpoint(f: AcceptanceFixture, label: string) {
		expect((await f.editor.post(`/api/boards/${f.boardId}/checkpoints`, { label })).statusCode).toBe(200)
		const events = (await f.owner.get(`/api/boards/${f.boardId}/history`)).json().events as Array<{ id: number; eventType: string; metadata: { label?: string } }>
		return events.find((event) => event.eventType === 'checkpoint.created' && event.metadata.label === label)!.id
	}
	async function restoreTo(f: AcceptanceFixture, eventId: number, who: FixtureIdentity = f.editor) {
		const clock = (await f.owner.get(`/api/rooms/${f.boardId}/canvas`)).json().clock as number
		return who.post(`/api/boards/${f.boardId}/restore`, { eventId, expectedClock: clock })
	}
	const approve = async (f: AcceptanceFixture, model: CadModel, who: FixtureIdentity) => {
		const revision = model.revisions[0].id
		expect((await f.editor.post(modelUrl(f, model, `/revisions/${revision}/status`), { to: 'in-review' })).statusCode).toBe(200)
		return who.post(modelUrl(f, model, `/revisions/${revision}/status`), { to: 'approved' })
	}

	it('deleting a card is a human action that leaves the model and its files intact, and board history brings the card back', async () => {
		const f = await fixture()
		const handle = getRoomHandle(f.boardId)
		const editor = connectRoomClient(handle, 'editor', 'editor')
		closers.push(editor.client)
		await until(() => editor.state.loaded)
		const { model, glb } = await createModel(f)
		const page = editor.store.allRecords().find((record) => record.typeName === 'page')!
		editor.store.put([{ id: 'shape:card', typeName: 'shape', type: 'cad-review', x: 0, y: 0, rotation: 0, index: 'a1', parentId: page.id, isLocked: false, opacity: 1, meta: {}, props: { w: 360, h: 300, modelRecordId: model.id } } as never])
		const present = (id: string) => handle.room.getCurrentSnapshot().documents.some((entry) => entry.state.id === id)
		await until(() => present('shape:card'))
		const withCard = await checkpoint(f, 'card present')

		editor.store.remove(['shape:card' as never])
		await until(() => !present('shape:card'))
		expect(stored(f, model.id)).toEqual(model)
		expect((await f.viewer.get(`/api/boards/${f.boardId}/assets/${glb.assetId}`)).statusCode).toBe(200)
		handle.recorder.flush()
		const deletion = handle.history.listEvents({ limit: 100 }).events.find((event) => event.eventType === 'object.deleted')
		expect(deletion).toMatchObject({ source: 'human', actorUserId: expect.stringMatching(/^user:/) })

		expect((await restoreTo(f, withCard)).statusCode).toBe(200)
		expect(present('shape:card')).toBe(true)
		expect(stored(f, model.id)).toEqual(model)
	})

	it('restoring an older board version can roll an approval back, as an attributed restore taken after a safety checkpoint', async () => {
		const f = await fixture()
		const { model } = await createModel(f)
		const beforeApproval = await checkpoint(f, 'before approval')
		expect((await approve(f, model, f.owner)).statusCode).toBe(200)
		expect(stored(f, model.id)!.revisions[0].status).toBe('approved')

		expect((await restoreTo(f, beforeApproval, f.editor)).statusCode).toBe(200)
		expect(stored(f, model.id)!.revisions[0].status).toBe('draft')
		expect(stored(f, model.id)!.revisions[0].decision).toBeUndefined()

		const handle = getRoomHandle(f.boardId)
		handle.recorder.flush()
		const events = handle.history.listEvents({ limit: 200 }).events
		expect(events.find((event) => event.eventType === 'restore.completed')).toMatchObject({ source: 'human', actorUserId: `user:${f.editor.userId}` })
		const checkpoints = (await f.owner.get(`/api/boards/${f.boardId}/checkpoints`)).json().checkpoints as Array<{ reason: string }>
		expect(checkpoints.map((item) => item.reason)).toContain('pre_restore')
	})

	it('restore needs a board writer: a viewer cannot roll an approval back', async () => {
		const f = await fixture()
		const { model } = await createModel(f)
		const mark = await checkpoint(f, 'mark')
		expect((await approve(f, model, f.owner)).statusCode).toBe(200)
		expect((await restoreTo(f, mark, f.viewer)).statusCode).toBe(403)
		expect(stored(f, model.id)!.revisions[0].status).toBe('approved')
	})

	it('allows the author of a revision to approve it (self-approval is a documented MVP policy, attributed in the decision)', async () => {
		const f = await fixture()
		const { model } = await createModel(f, f.editor)
		expect(model.revisions[0].createdBy.userId).toBe(`user:${f.editor.userId}`)
		expect((await approve(f, model, f.editor)).statusCode).toBe(200)
		const decided = stored(f, model.id)!.revisions[0]
		expect(decided.decision?.by.userId).toBe(decided.createdBy.userId)
	})
})

describe('CAD state in the read-only history viewer', () => {
	it('rebuilds a card and the model it pointed at as they were at each earlier version', async () => {
		const f = await fixture()
		const handle = getRoomHandle(f.boardId)
		const editor = connectRoomClient(handle, 'editor', 'editor')
		closers.push(editor.client)
		await until(() => editor.state.loaded)
		const { model } = await createModel(f)
		const page = editor.store.allRecords().find((record) => record.typeName === 'page')!
		editor.store.put([{ id: 'shape:card', typeName: 'shape', type: 'cad-review', x: 0, y: 0, rotation: 0, index: 'a1', parentId: page.id, isLocked: false, opacity: 1, meta: {}, props: { w: 360, h: 300, modelRecordId: model.id } } as never])
		await until(() => handle.room.getCurrentSnapshot().documents.some((entry) => entry.state.id === 'shape:card'))
		handle.recorder.flush()
		const asDraft = handle.history.latestEventId()!

		const revision = model.revisions[0].id
		expect((await f.editor.post(modelUrl(f, model, `/revisions/${revision}/status`), { to: 'in-review' })).statusCode).toBe(200)
		expect((await f.owner.post(modelUrl(f, model, `/revisions/${revision}/status`), { to: 'approved' })).statusCode).toBe(200)
		handle.recorder.flush()
		const asApproved = handle.history.latestEventId()!
		expect(asApproved).toBeGreaterThan(asDraft)

		const statusIn = (eventId: number, wire: boolean) => {
			const reconstructed = handle.history.reconstruct({ eventId }).snapshot
			const store = createHistoricalStore(wire ? JSON.parse(JSON.stringify({ event: { id: eventId }, snapshot: reconstructed })) : reconstructed)
			expect(store.get('shape:card' as never)).toBeTruthy()
			return (store.get(model.id as never) as unknown as CadModel).revisions[0].status
		}
		expect(statusIn(asDraft, false)).toBe('draft')
		expect(statusIn(asApproved, false)).toBe('approved')
		expect(statusIn(asApproved, true)).toBe('approved')
	})
})

describe('assembly review over HTTP', () => {
	const assemblyGlb = () => Buffer.from(buildSampleAssemblyGlb())
	async function createAssembly(f: AcceptanceFixture, who: FixtureIdentity = f.editor, bytes: Buffer = assemblyGlb(), extra: Record<string, unknown> = {}) {
		const glb = (await upload(who, f.boardId, 'glb', bytes, 'assembly.glb')).json().artifact
		const response = await who.post(`/api/boards/${f.boardId}/cad-models`, { name: 'Bracket assembly', units: 'mm', files: { glb: { assetId: glb.assetId, name: glb.name } }, ...extra })
		return { response, glb, model: (response.statusCode === 201 ? response.json().model : null) as CadModel }
	}
	const linkUrl = (f: AcceptanceFixture, model: CadModel, revisionId: string, tail = '') => `${modelUrl(f, model, `/revisions/${revisionId}/links`)}${tail}`

	it('reads parts and the declared bill of materials from the stored GLB, on the server', async () => {
		const f = await fixture()
		const { response, model } = await createAssembly(f)
		expect(response.statusCode).toBe(201)
		const assembly = model.revisions[0].assembly!
		expect(assembly.parts.map((part) => part.name)).toEqual(['Training bracket assembly', 'Base plate', 'Upright', 'Fasteners', 'Spacer', 'Bolt', 'Unnamed part (node 6)'])
		expect(assembly.bom.map((row) => [row.partNumber, row.quantity])).toEqual([['TRN-BASE-001', 1], ['TRN-UPR-002', 1], ['TRN-SPC-003', 2], ['TRN-BLT-004', 4]])
		expect(stored(f, model.id)).toEqual(model)
		const plain = (await createModel(f)).model
		expect(plain.revisions[0].assembly).toBeUndefined()
	})

	it('ignores no client claim about structure: an assembly or bill of materials in the request is refused', async () => {
		const f = await fixture()
		const glb = (await upload(f.editor, f.boardId, 'glb', assemblyGlb())).json().artifact
		const fake = { parts: [{ key: 'a', stable: true, node: 0, parent: null, name: 'A', named: true, mesh: true }, { key: 'b', stable: true, node: 1, parent: null, name: 'B', named: true, mesh: true }], bom: [{ partKey: 'a', partNumber: 'FAKE', quantity: 999, source: 'glb-extras' }] }
		const response = await f.editor.post(`/api/boards/${f.boardId}/cad-models`, { name: 'x', units: 'mm', files: { glb: { assetId: glb.assetId } }, assembly: fake })
		expect(response.statusCode).toBe(422)
		expect(getRoomHandle(f.boardId).room.getCurrentSnapshot().documents.filter((entry) => (entry.state as { typeName: string }).typeName === 'cad_model')).toHaveLength(0)
	})

	it('links a part to one exact component revision, attributed to the person, without touching either status', async () => {
		const f = await fixture()
		const { model: assembly } = await createAssembly(f)
		const component = (await createModel(f)).model
		const revision = assembly.revisions[0].id
		const response = await f.editor.post(linkUrl(f, assembly, revision), { partKey: 'bolt', modelRecordId: component.id, revisionId: component.revisions[0].id })
		expect(response.statusCode).toBe(201)
		const after = stored(f, assembly.id)!
		expect(after.revisions[0].links).toEqual([{ partKey: 'bolt', modelRecordId: component.id, revisionId: component.revisions[0].id, addedBy: expect.objectContaining({ userId: `user:${f.editor.userId}`, source: 'human' }), addedAt: expect.any(Number) }])
		expect(after.revisions[0].status).toBe('draft')
		expect(stored(f, component.id)).toEqual(component)
		const handle = getRoomHandle(f.boardId)
		handle.recorder.flush()
		expect(handle.history.listEvents({ limit: 200 }).events.find((event) => event.eventType === 'cad.component.linked')).toMatchObject({ actorUserId: `user:${f.editor.userId}`, source: 'human' })
		const removed = await f.editor.delete(linkUrl(f, assembly, revision, '/bolt'))
		expect(removed.statusCode).toBe(200)
		expect(stored(f, assembly.id)!.revisions[0].links).toBeUndefined()
		handle.recorder.flush()
		expect(handle.history.listEvents({ limit: 200 }).events.some((event) => event.eventType === 'cad.component.unlinked')).toBe(true)
	})

	it('keeps the assembly decision and the component decision separate, in both directions', async () => {
		const f = await fixture()
		const { model: assembly } = await createAssembly(f)
		const component = (await createModel(f)).model
		const revision = assembly.revisions[0].id
		expect((await f.editor.post(linkUrl(f, assembly, revision), { partKey: 'bolt', modelRecordId: component.id, revisionId: component.revisions[0].id })).statusCode).toBe(201)
		expect((await f.editor.post(modelUrl(f, assembly, `/revisions/${revision}/status`), { to: 'in-review' })).statusCode).toBe(200)
		expect((await f.owner.post(modelUrl(f, assembly, `/revisions/${revision}/status`), { to: 'approved' })).statusCode).toBe(200)
		expect(stored(f, assembly.id)!.revisions[0].status).toBe('approved')
		expect(stored(f, component.id)!.revisions[0].status).toBe('draft')
		const componentRevision = component.revisions[0].id
		expect((await f.editor.post(modelUrl(f, component, `/revisions/${componentRevision}/status`), { to: 'in-review' })).statusCode).toBe(200)
		expect((await f.owner.post(modelUrl(f, component, `/revisions/${componentRevision}/status`), { to: 'rejected', note: 'wrong thread' })).statusCode).toBe(200)
		expect(stored(f, component.id)!.revisions[0].status).toBe('rejected')
		expect(stored(f, assembly.id)!.revisions[0].status).toBe('approved')
	})

	it('freezes links once the assembly is in review or approved, and a new revision starts with none and its own approval', async () => {
		const f = await fixture()
		const { model: assembly } = await createAssembly(f)
		const component = (await createModel(f)).model
		const revision = assembly.revisions[0].id
		const body = { partKey: 'bolt', modelRecordId: component.id, revisionId: component.revisions[0].id }
		expect((await f.editor.post(linkUrl(f, assembly, revision), body)).statusCode).toBe(201)
		await f.editor.post(modelUrl(f, assembly, `/revisions/${revision}/status`), { to: 'in-review' })
		expect((await f.editor.post(linkUrl(f, assembly, revision), { ...body, partKey: 'spacer' })).statusCode).toBe(409)
		await f.owner.post(modelUrl(f, assembly, `/revisions/${revision}/status`), { to: 'approved' })
		const approvedCopy = JSON.stringify(stored(f, assembly.id)!.revisions[0])
		expect((await f.editor.post(linkUrl(f, assembly, revision), { ...body, partKey: 'spacer' })).statusCode).toBe(409)
		expect((await f.editor.delete(linkUrl(f, assembly, revision, '/bolt'))).statusCode).toBe(409)
		const revised = assemblyGlb(); revised.write('assemblx', revised.indexOf('training assembly') + 'training '.length, 'latin1')
		const next = (await upload(f.editor, f.boardId, 'glb', revised)).json().artifact
		const added = await f.editor.post(modelUrl(f, assembly, '/revisions'), { files: { glb: { assetId: next.assetId } }, changeNote: 'v2' })
		expect(added.statusCode).toBe(201)
		const after = stored(f, assembly.id)!
		expect(JSON.stringify(after.revisions[0])).toBe(approvedCopy)
		expect(after.revisions[1]).toMatchObject({ number: 2, status: 'draft' })
		expect(after.revisions[1].links).toBeUndefined()
		expect(after.revisions[1].assembly?.parts.length).toBe(7)
	})

	it('refuses links to things that are not there, and to the assembly itself', async () => {
		const f = await fixture()
		const { model: assembly } = await createAssembly(f)
		const revision = assembly.revisions[0].id
		const url = linkUrl(f, assembly, revision)
		expect((await f.editor.post(url, { partKey: 'bolt', modelRecordId: 'cad_model:ffffffffffff', revisionId: 'rev-aaaaaa' })).statusCode).toBe(404)
		expect((await f.editor.post(url, { partKey: 'bolt', modelRecordId: assembly.id, revisionId: revision })).statusCode).toBe(422)
		const component = (await createModel(f)).model
		expect((await f.editor.post(url, { partKey: 'ghost', modelRecordId: component.id, revisionId: component.revisions[0].id })).statusCode).toBe(404)
		expect((await f.editor.post(url, { partKey: 'node-6', modelRecordId: component.id, revisionId: component.revisions[0].id })).statusCode).toBe(422)
		expect((await f.editor.post(url, { partKey: 'bolt', modelRecordId: component.id, revisionId: 'rev-zzzzzz' })).statusCode).toBe(404)
		expect((await f.editor.post(url, { partKey: 'bolt', modelRecordId: component.id, revisionId: component.revisions[0].id, quantity: 9 })).statusCode).toBe(422)
		expect(stored(f, assembly.id)!.revisions[0].links).toBeUndefined()
	})

	it('refuses viewers, nonmembers, anonymous users and machine tokens every link change', async () => {
		const f = await fixture()
		const { model: assembly } = await createAssembly(f)
		const component = (await createModel(f)).model
		const revision = assembly.revisions[0].id
		const body = { partKey: 'bolt', modelRecordId: component.id, revisionId: component.revisions[0].id }
		expect((await f.editor.post(linkUrl(f, assembly, revision), body)).statusCode).toBe(201)
		for (const [who, expected] of [[f.viewer, 403], [f.nonmember, 404], [f.anonymous, 401]] as const) {
			expect((await who.post(linkUrl(f, assembly, revision), { ...body, partKey: 'spacer' })).statusCode).toBe(expected)
			expect((await who.delete(linkUrl(f, assembly, revision, '/bolt'))).statusCode).toBe(expected)
		}
		const bearer = { authorization: `Bearer ${'a'.repeat(48)}` }
		expect((await f.anonymous.request('POST', linkUrl(f, assembly, revision), { ...body, partKey: 'spacer' }, bearer)).statusCode).toBe(401)
		expect((await f.anonymous.request('DELETE', linkUrl(f, assembly, revision, '/bolt'), undefined, bearer)).statusCode).toBe(401)
		expect(stored(f, assembly.id)!.revisions[0].links).toHaveLength(1)
	})

	it('lets a viewer read the assembly and its file but nothing about it can be changed from a browser over sync', async () => {
		const f = await fixture()
		const { model: assembly, glb } = await createAssembly(f)
		expect((await f.viewer.get(`/api/boards/${f.boardId}/assets/${glb.assetId}`)).statusCode).toBe(200)
		const handle = getRoomHandle(f.boardId)
		const editor = connectRoomClient(handle, 'editor', 'editor')
		const viewer = connectRoomClient(handle, 'viewer', 'viewer')
		closers.push(editor.client, viewer.client)
		await until(() => Boolean(editor.store.get(assembly.id as never)) && Boolean(viewer.store.get(assembly.id as never)))
		const revision = assembly.revisions[0]
		const forgedBom = { ...assembly, revisions: [{ ...revision, assembly: { ...revision.assembly!, bom: revision.assembly!.bom.map((row) => (row.partKey === 'bolt' ? { ...row, quantity: 400 } : row)) } }] }
		const forgedLink = { ...assembly, revisions: [{ ...revision, links: [{ partKey: 'bolt', modelRecordId: 'cad_model:ba9876543210', revisionId: 'rev-cccccc', addedBy: assembly.createdBy, addedAt: 1 }] }] }
		editor.store.put([forgedBom as never]); await settle()
		viewer.store.put([forgedLink as never]); await settle()
		expect(stored(f, assembly.id)).toEqual(assembly)
	})
})

describe('creating a model', () => {
	it('stores a valid record, attributed to the signed-in editor', async () => {
		const f = await fixture()
		const { response, model, glb } = await createModel(f)
		expect(response.statusCode).toBe(201)
		expect(cadModelSchema.safeParse(model).success).toBe(true)
		expect(stored(f, model.id)).toEqual(model)
		expect(model.createdBy).toMatchObject({ userId: `user:${f.editor.userId}`, source: 'human' })
		expect(model.revisions[0]).toMatchObject({ number: 1, status: 'draft', files: { glb: { sha256: glb.sha256, bytes: glb.bytes } } })
		const handle = getRoomHandle(f.boardId)
		handle.recorder.flush()
		const event = handle.history.listEvents({ limit: 100 }).events.find((item) => item.eventType === 'cad.model.created')
		expect(event).toMatchObject({ actorUserId: `user:${f.editor.userId}`, source: 'human' })
	})

	it('takes sizes from the stored file, never from the client', async () => {
		const f = await fixture()
		const glb = (await upload(f.editor, f.boardId, 'glb', sampleGlb())).json().artifact
		const response = await f.editor.post(`/api/boards/${f.boardId}/cad-models`, { name: 'x', units: 'mm', files: { glb: { assetId: glb.assetId, name: 'x.glb', bytes: 1 } } })
		expect(response.statusCode).toBe(422)
		const ok = await f.editor.post(`/api/boards/${f.boardId}/cad-models`, { name: 'x', units: 'mm', files: { glb: { assetId: glb.assetId, name: 'x.glb' } } })
		expect(ok.json().model.revisions[0].files.glb.bytes).toBe(sampleGlb().length)
	})

	it('refuses viewers, nonmembers and anonymous users', async () => {
		const f = await fixture()
		const glb = (await upload(f.editor, f.boardId, 'glb', sampleGlb())).json().artifact
		const body = { name: 'x', units: 'mm', files: { glb: { assetId: glb.assetId } } }
		expect((await f.viewer.post(`/api/boards/${f.boardId}/cad-models`, body)).statusCode).toBe(403)
		expect((await f.nonmember.post(`/api/boards/${f.boardId}/cad-models`, body)).statusCode).toBe(404)
		expect((await f.anonymous.post(`/api/boards/${f.boardId}/cad-models`, body)).statusCode).toBe(401)
	})

	it('refuses files that were not uploaded to this board, a wrong slot, a preview-less revision and extra fields', async () => {
		const f = await fixture()
		const glb = (await upload(f.editor, f.boardId, 'glb', sampleGlb())).json().artifact
		const step = (await upload(f.editor, f.boardId, 'step', stepBytes())).json().artifact
		const post = (body: unknown) => f.editor.post(`/api/boards/${f.boardId}/cad-models`, body)
		expect((await post({ name: 'x', units: 'mm', files: { glb: { assetId: `cad-${'9'.repeat(64)}.glb` } } })).statusCode).toBe(404)
		expect((await post({ name: 'x', units: 'mm', files: { glb: { assetId: step.assetId } } })).statusCode).toBe(422)
		expect((await post({ name: 'x', units: 'mm', files: { step: { assetId: step.assetId } } })).statusCode).toBe(422)
		expect((await post({ name: 'x', units: 'mm', files: { glb: { assetId: glb.assetId } }, status: 'approved' })).statusCode).toBe(422)
		expect((await post({ name: 'x', units: 'furlongs', files: { glb: { assetId: glb.assetId } } })).statusCode).toBe(422)
		const other = await f.nonmember.post('/api/boards', { name: 'Elsewhere', id: 'elsewhere-board' })
		expect(other.statusCode).toBe(200)
		const foreign = await f.nonmember.post('/api/boards/elsewhere-board/cad-models', { name: 'x', units: 'mm', files: { glb: { assetId: glb.assetId } } })
		expect(foreign.statusCode).toBe(404)
	})

	it('keeps model IDs unique on a board', async () => {
		const f = await fixture()
		expect((await createModel(f, f.editor, { modelId: 'SPACER-1' })).response.statusCode).toBe(201)
		expect((await createModel(f, f.editor, { modelId: 'spacer-1' })).response.statusCode).toBe(409)
	})
})

describe('review workflow over HTTP', () => {
	async function inReview(f: AcceptanceFixture) {
		const { model } = await createModel(f)
		const revisionId = model.revisions[0].id
		expect((await f.editor.post(modelUrl(f, model, `/revisions/${revisionId}/status`), { to: 'in-review' })).statusCode).toBe(200)
		return { model, revisionId }
	}

	it('lets an editor submit and an owner approve, stamping the decision from the session', async () => {
		const f = await fixture()
		const { model, revisionId } = await inReview(f)
		const response = await f.owner.post(modelUrl(f, model, `/revisions/${revisionId}/status`), { to: 'approved', note: 'Matches the part' })
		expect(response.statusCode).toBe(200)
		expect(stored(f, model.id)!.revisions[0]).toMatchObject({ status: 'approved', decision: { by: { userId: `user:${f.owner.userId}`, source: 'human' }, note: 'Matches the part' } })
		const handle = getRoomHandle(f.boardId)
		handle.recorder.flush()
		const event = handle.history.listEvents({ limit: 100 }).events.find((item) => item.eventType === 'cad.revision.status_changed' && (item.metadata as { to?: string }).to === 'approved')
		expect(event).toMatchObject({ actorUserId: `user:${f.owner.userId}`, source: 'human' })
	})

	it('ignores any identity the client claims: the body schema is strict', async () => {
		const f = await fixture()
		const { model, revisionId } = await inReview(f)
		const forged = await f.editor.post(modelUrl(f, model, `/revisions/${revisionId}/status`), { to: 'approved', by: { userId: 'user:someone-else', displayName: 'CEO', source: 'human' } })
		expect(forged.statusCode).toBe(422)
		expect(stored(f, model.id)!.revisions[0].status).toBe('in-review')
	})

	it('refuses viewers, nonmembers and anonymous users every mutation', async () => {
		const f = await fixture()
		const { model, revisionId } = await inReview(f)
		const calls: Array<[string, unknown]> = [
			[modelUrl(f, model, `/revisions/${revisionId}/status`), { to: 'approved' }],
			[modelUrl(f, model, '/comments'), { revisionId, body: 'hi' }],
			[modelUrl(f, model, '/evidence'), { kind: 'note', label: 'x' }],
			[modelUrl(f, model, '/revisions'), { files: { glb: { assetId: model.revisions[0].files.glb!.assetId } } }],
		]
		for (const [url, body] of calls) {
			expect((await f.viewer.post(url, body)).statusCode).toBe(403)
			expect((await f.nonmember.post(url, body)).statusCode).toBe(404)
			expect((await f.anonymous.post(url, body)).statusCode).toBe(401)
		}
		expect(stored(f, model.id)!.revisions[0].status).toBe('in-review')
		expect(stored(f, model.id)!.comments).toEqual([])
	})

	it('treats approval as final and keeps an approved revision byte-identical when a new one is added', async () => {
		const f = await fixture()
		const { model, revisionId } = await inReview(f)
		expect((await f.owner.post(modelUrl(f, model, `/revisions/${revisionId}/status`), { to: 'approved' })).statusCode).toBe(200)
		const approvedCopy = JSON.stringify(stored(f, model.id)!.revisions[0])
		for (const to of ['draft', 'in-review', 'rejected']) expect((await f.owner.post(modelUrl(f, model, `/revisions/${revisionId}/status`), { to })).statusCode).toBe(409)

		const revised = sampleGlb()
		revised.write('sampl2', revised.indexOf('training sample') + 'training '.length, 'latin1')
		const glb2 = (await upload(f.editor, f.boardId, 'glb', revised)).json().artifact
		expect(glb2.assetId).not.toBe(model.revisions[0].files.glb!.assetId)
		const second = await f.editor.post(modelUrl(f, model, '/revisions'), { files: { glb: { assetId: glb2.assetId } }, changeNote: 'Longer bore' })
		expect(second.statusCode).toBe(201)
		const after = stored(f, model.id)!
		expect(after.revisions).toHaveLength(2)
		expect(JSON.stringify(after.revisions[0])).toBe(approvedCopy)
		expect(after.revisions[1]).toMatchObject({ number: 2, status: 'draft', createdBy: { userId: `user:${f.editor.userId}` } })
		expect((await f.owner.post(modelUrl(f, model, `/revisions/${revisionId}/status`), { to: 'rejected' })).statusCode).toBe(409)
		expect((await f.owner.post(modelUrl(f, model, `/revisions/${after.revisions[1].id}/status`), { to: 'approved' })).statusCode).toBe(409)
	})

	it('records comments and evidence as the signed-in person, and only links things on this board', async () => {
		const f = await fixture()
		const { model, revisionId } = await inReview(f)
		const comment = await f.editor.post(modelUrl(f, model, '/comments'), { revisionId, body: 'Bore is 0.2 mm tight' })
		expect(comment.statusCode).toBe(201)
		expect(stored(f, model.id)!.comments[0]).toMatchObject({ body: 'Bore is 0.2 mm tight', author: { userId: `user:${f.editor.userId}`, source: 'human' } })
		expect((await f.editor.post(modelUrl(f, model, '/comments'), { revisionId: 'rev-nothere', body: 'x' })).statusCode).toBe(404)
		expect((await f.editor.post(modelUrl(f, model, '/comments'), { revisionId, body: 'x', author: 'CEO' })).statusCode).toBe(422)

		expect((await f.editor.post(modelUrl(f, model, '/evidence'), { kind: 'note', label: 'Caliper: 59.98 mm' })).statusCode).toBe(201)
		expect((await f.editor.post(modelUrl(f, model, '/evidence'), { kind: 'entity', label: 'Test', ref: 'engineering_entity:nope' })).statusCode).toBe(404)
		expect((await f.editor.post(modelUrl(f, model, '/evidence'), { kind: 'asset', label: 'Photo', ref: 'someone-elses-upload.png' })).statusCode).toBe(404)
		expect((await f.editor.post(modelUrl(f, model, '/evidence'), { kind: 'asset', label: 'Source', ref: model.revisions[0].files.step!.assetId })).statusCode).toBe(201)
	})

	it('answers an unknown model with 404', async () => {
		const f = await fixture()
		expect((await f.editor.post(`/api/boards/${f.boardId}/cad-models/ffffffffffff/comments`, { revisionId: 'rev-aaaaaa', body: 'x' })).statusCode).toBe(404)
	})
})

describe('what a browser can do over sync, and what an agent can do', () => {
	it('shows a model written by a route to a connected viewer, and lets that viewer change nothing', async () => {
		const f = await fixture()
		const handle = getRoomHandle(f.boardId)
		const viewer = connectRoomClient(handle, 'viewer', 'viewer')
		const editor = connectRoomClient(handle, 'editor', 'editor')
		closers.push(viewer.client, editor.client)
		await until(() => viewer.state.loaded && editor.state.loaded)
		const { model } = await createModel(f)
		await until(() => Boolean(viewer.store.get(model.id as never)) && Boolean(editor.store.get(model.id as never)))
		const forged = { ...model, revisions: [{ ...model.revisions[0], status: 'approved', decision: { by: model.createdBy, at: 1, note: '' } }] }
		editor.store.put([forged as never])
		viewer.store.put([forged as never])
		await settle()
		expect(stored(f, model.id)!.revisions[0].status).toBe('draft')
	})

	it('refuses an agent deleting a CAD card, approved or not, and still lets it move one', async () => {
		const f = await fixture()
		const handle = getRoomHandle(f.boardId)
		const editor = connectRoomClient(handle, 'editor', 'editor')
		closers.push(editor.client)
		await until(() => editor.state.loaded)
		const { model } = await createModel(f)
		const page = editor.store.allRecords().find((record) => record.typeName === 'page')!
		const shapeId = 'shape:cadcard'
		editor.store.put([{
			id: shapeId, typeName: 'shape', type: 'cad-review', x: 0, y: 0, rotation: 0, index: 'a1', parentId: page.id, isLocked: false, opacity: 1, meta: {},
			props: { w: 360, h: 260, modelRecordId: model.id },
		} as never])
		await until(() => Boolean(handle.room.getCurrentSnapshot().documents.find((entry) => entry.state.id === shapeId)))
		const actor = { actorUserId: 'token:agent', displayName: 'agent' }
		let error: { statusCode?: number; code?: string; message: string } | null = null
		try { applyRoomActions(handle.room, { actions: [{ tool: 'delete_shape', id: shapeId }] }, actor) } catch (caught) { error = caught as typeof error }
		expect(error).toMatchObject({ statusCode: 403, code: 'cad_card_protected' })
		expect(handle.room.getCurrentSnapshot().documents.some((entry) => entry.state.id === shapeId)).toBe(true)
		expect(() => applyRoomActions(handle.room, { actions: [{ tool: 'move_shape', id: shapeId, x: 40, y: 50 }] }, actor)).not.toThrow()
		expect(stored(f, model.id)).toEqual(model)
	})
})
