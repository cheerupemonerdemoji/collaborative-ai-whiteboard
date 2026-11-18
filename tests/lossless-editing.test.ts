/**
 * Lossless agent editing, through the real application. The incident this closes: an agent read a long browser-created text through the
 * canvas read (a 500-character, paragraph-flattened preview that did not say so), treated it as the whole value, and replaced the original
 * with its own shorter text. Here: the preview says what it is, a replacement made from a preview is refused, the full content is readable
 * losslessly, History returns exact earlier content, one shape can be recovered without rolling anything else back, and an agent can learn
 * its own permissions (and an owner can change them deliberately) before it needs them.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getRoomHandle, withRoomHistory } from '../server/rooms'
import { assessContent, canonicalJson, contentDigest, legacyPreview, plainContent } from '../server/shape-content'
import { createClient } from '../server/token-store.mjs'
import { createAcceptanceFixture, type AcceptanceFixture } from './helpers/acceptance-fixture'

let f: AcceptanceFixture
let storeDirectory: string
let storeFile: string

const sid = (name: string) => `shape:${name}`
/** The structure a browser writes: default paragraph direction on the document and every paragraph. */
const browserRich = (lines: string[]) => ({ type: 'doc', attrs: { dir: 'auto' }, content: lines.map((text) => (text ? { type: 'paragraph', attrs: { dir: 'auto' }, content: [{ type: 'text', text }] } : { type: 'paragraph', attrs: { dir: 'auto' } })) })
const LONG_LINES = Array.from({ length: 57 }, (_, i) => (i % 5 === 4 ? '' : `Line ${i + 1}: ${'lorem ipsum dolor '.repeat(4)}`))
const LONG_LENGTH = LONG_LINES.join('\n').length

function textRecord(id: string, lines: string[], page: string, extra: Record<string, unknown> = {}) {
	return { id, typeName: 'shape', type: 'text', x: 1278, y: 242, rotation: 0, index: 'a5', parentId: page, isLocked: false, opacity: 1, meta: {}, props: { color: 'black', size: 'm', font: 'draw', textAlign: 'start', w: 1145, richText: browserRich(lines), scale: 1, autoSize: false }, ...extra }
}

/** A write made the way a browser session makes it: attributed to the signed-in person. */
function humanWrite(write: (txn: { get(id: string): any; set(id: string, record: any): void; values(): Iterable<any> }, page: string) => void) {
	const handle = getRoomHandle(f.boardId)
	withRoomHistory(handle, { actorUserId: `user:${f.owner.userId}`, actorDisplayName: 'Owner', sessionId: null, source: 'human', immediate: true }, () => handle.room.storage.transaction((txn) => {
		const page = [...txn.values()].find((record) => (record as { typeName: string }).typeName === 'page') as { id: string }
		write(txn as never, page.id)
	}))
}

const records = () => getRoomHandle(f.boardId).room.getCurrentSnapshot().documents.map((d) => d.state) as Array<Record<string, any>>
const record = (id: string) => records().find((r) => r.id === id) as Record<string, any>
const revisionOf = (id: string) => getRoomHandle(f.boardId).room.getCurrentSnapshot().documents.find((d) => (d.state as { id: string }).id === id)!.lastChangedClock
const events = () => getRoomHandle(f.boardId).database.prepare('SELECT id, event_type AS type, source, actor_user_id AS actor, metadata_json AS meta, changes_json AS changes FROM history_events ORDER BY id').all() as Array<{ id: number; type: string; source: string; actor: string; meta: string; changes: string }>
const clock = () => getRoomHandle(f.boardId).room.getCurrentSnapshot().documentClock

async function token(name: string, access: 'read' | 'read-write' | 'read-write-history' | 'full' | 'read-history') {
	return (await createClient({ file: storeFile, name, rooms: [f.boardId], access })).token
}
const call = (bearer: string, method: 'GET' | 'POST', url: string, payload?: unknown) => f.app.inject({ method, url, headers: { authorization: `Bearer ${bearer}` }, ...(payload === undefined ? {} : { payload }) })
const act = (bearer: string, actions: unknown[]) => call(bearer, 'POST', `/api/rooms/${f.boardId}/actions`, { actions })
const canvasObject = async (bearer: string, id: string) => (await call(bearer, 'GET', `/api/rooms/${f.boardId}/canvas`)).json().objects.find((o: any) => o.id === id)
const content = (bearer: string, id: string) => call(bearer, 'GET', `/api/rooms/${f.boardId}/shapes/${id}`)
const shapeHistory = (bearer: string, id: string, query = '') => call(bearer, 'GET', `/api/boards/${f.boardId}/shapes/${id}/history${query}`)
const restore = (bearer: string, id: string, body: unknown) => call(bearer, 'POST', `/api/boards/${f.boardId}/shapes/${id}/restore`, body)

beforeEach(async () => {
	f = await createAcceptanceFixture()
	storeDirectory = mkdtempSync(join(tmpdir(), 'lossless-store-'))
	storeFile = join(storeDirectory, 'api-tokens.json')
	process.env.CANVAS_API_TOKENS_FILE = storeFile
})
afterEach(async () => {
	await f.cleanup()
	rmSync(storeDirectory, { recursive: true, force: true })
})

describe('what counts as lossy (the pure assessment)', () => {
	const plain = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })

	it('is not "long": a short single paragraph is exact, whether an API or a browser wrote it', () => {
		for (const rich of [plain('short note'), browserRich(['short note'])]) {
			expect(assessContent(rich)).toEqual({ originalLength: 10, textTruncated: false, contentLossy: false, lossReasons: [] })
		}
	})
	it('is lossy when paragraphs were joined, even under 500 characters', () => {
		const a = assessContent(browserRich(['one', 'two', 'three']))
		expect(a).toMatchObject({ textTruncated: false, contentLossy: true, lossReasons: ['paragraph_structure_omitted'], originalLength: 13 })
	})
	it('is lossy when formatting would be dropped, and names it', () => {
		const bold = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'strong', marks: [{ type: 'bold' }] }] }] }
		expect(assessContent(bold)).toMatchObject({ contentLossy: true, lossReasons: ['formatting_omitted'] })
		const list = { type: 'doc', content: [{ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }] }] }] }
		expect(assessContent(list).lossReasons).toContain('formatting_omitted')
	})
	it('is truncated exactly when the legacy preview was cut, and reports the true length', () => {
		const at = assessContent(plain('a'.repeat(500)))
		const over = assessContent(plain('a'.repeat(501)))
		expect(at).toMatchObject({ textTruncated: false, contentLossy: false, originalLength: 500 })
		expect(over).toMatchObject({ textTruncated: true, contentLossy: true, originalLength: 501, lossReasons: ['truncated'] })
	})
	it('is lossy when the preview cannot rebuild the content (text split into runs gains a space)', () => {
		const runs = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'foo' }, { type: 'text', text: 'bar' }] }] }
		expect(assessContent(runs)).toMatchObject({ contentLossy: true, lossReasons: ['content_not_exactly_representable'] })
	})
	it('keeps the legacy preview byte for byte, and digests the complete structure (so formatting changes the digest)', () => {
		expect(legacyPreview(browserRich(['alpha', '', 'beta']))).toBe('alpha beta')
		expect(legacyPreview(plain('z'.repeat(900)))).toHaveLength(500)
		expect(plainContent(browserRich(['a', '', 'b']))).toEqual({ text: 'a\n\nb', paragraphs: 3 })
		const withMark = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'bold' }] }] }] }
		expect(contentDigest(plain('x'))).not.toBe(contentDigest(withMark))
		expect(contentDigest({ b: 1, a: 2 })).toBe(contentDigest({ a: 2, b: 1 }))
		expect(canonicalJson({ b: [1, { d: 1, c: 2 }], a: null })).toBe('{"a":null,"b":[1,{"c":2,"d":1}]}')
	})
})

describe('the canvas read says when it is only a preview', () => {
	it('marks a long browser-created text as truncated, with its exact length, a revision, and the legacy preview unchanged', async () => {
		humanWrite((txn, page) => txn.set(sid('todo'), textRecord(sid('todo'), LONG_LINES, page)))
		const writer = await token('le-writer', 'read-write')
		const o = await canvasObject(writer, sid('todo'))
		expect(o).toMatchObject({ textTruncated: true, originalLength: LONG_LENGTH, contentLossy: true, revision: revisionOf(sid('todo')) })
		expect(o.lossReasons).toEqual(expect.arrayContaining(['truncated', 'paragraph_structure_omitted']))
		expect(o.text).toBe(LONG_LINES.filter(Boolean).join(' ').slice(0, 500))
		expect(o.text).toHaveLength(500)
		expect(LONG_LENGTH).toBeGreaterThan(3000)
	})

	it('reports a short single paragraph as exact, and a short multi-paragraph one as lossy although it is not truncated', async () => {
		humanWrite((txn, page) => {
			txn.set(sid('one'), textRecord(sid('one'), ['just one line'], page))
			txn.set(sid('three'), textRecord(sid('three'), ['first', 'second', 'third'], page))
		})
		const writer = await token('le-writer', 'read-write')
		expect(await canvasObject(writer, sid('one'))).toMatchObject({ textTruncated: false, originalLength: 13, contentLossy: false, lossReasons: [] })
		expect(await canvasObject(writer, sid('three'))).toMatchObject({ textTruncated: false, originalLength: 18, contentLossy: true, lossReasons: ['paragraph_structure_omitted'] })
	})

	it('never returns the proof digest from a canvas read', async () => {
		humanWrite((txn, page) => txn.set(sid('todo'), textRecord(sid('todo'), LONG_LINES, page)))
		const writer = await token('le-writer', 'read-write')
		const body = (await call(writer, 'GET', `/api/rooms/${f.boardId}/canvas`)).body
		expect(body).not.toContain(contentDigest(record(sid('todo')).props.richText))
		expect(body).not.toMatch(/contentDigest|richText/)
	})
})

describe('lossless read of one shape', () => {
	it('returns the exact full content, the same id, the same revision a canvas read reports, and the digest', async () => {
		humanWrite((txn, page) => txn.set(sid('todo'), textRecord(sid('todo'), LONG_LINES, page)))
		const writer = await token('le-writer', 'read-write')
		const response = await content(writer, sid('todo'))
		expect(response.statusCode, response.body).toBe(200)
		const body = response.json()
		expect(body).toMatchObject({ id: sid('todo'), type: 'text', representation: 'lossless', originalLength: LONG_LENGTH, paragraphs: 57 })
		expect(body.text).toBe(LONG_LINES.join('\n'))
		expect(body.text).toHaveLength(LONG_LENGTH)
		expect(body.richText).toEqual(record(sid('todo')).props.richText)
		expect(body.revision).toBe((await canvasObject(writer, sid('todo'))).revision)
		expect(body.contentDigest).toBe(contentDigest(record(sid('todo')).props.richText))
		expect(response.headers['cache-control']).toBe('no-store')
		expect(Object.keys(body)).not.toContain('props')
	})

	it('needs read, answers 404 for a missing shape, 422 for a shape without text, 400 for a malformed id', async () => {
		humanWrite((txn, page) => txn.set(sid('todo'), textRecord(sid('todo'), ['x'], page)))
		const writeOnly = await createClient({ file: storeFile, name: 'le-write-only', rooms: [f.boardId], access: 'write' })
		const writer = await token('le-writer', 'read-write')
		expect((await content(writeOnly.token, sid('todo'))).statusCode).toBe(403)
		expect((await content(writer, sid('nope'))).statusCode).toBe(404)
		expect((await call(writer, 'GET', `/api/rooms/${f.boardId}/shapes/not-a-shape`)).statusCode).toBe(400)
		await act(writer, [{ tool: 'create_shape', id: sid('a'), type: 'rectangle', text: 'a', x: 0, y: 0, width: 100, height: 100 }, { tool: 'create_shape', id: sid('b'), type: 'rectangle', text: 'b', x: 300, y: 0, width: 100, height: 100 }, { tool: 'connect_shapes', id: sid('link'), fromId: sid('a'), toId: sid('b') }])
		const arrow = await content(writer, sid('link'))
		expect(arrow.statusCode).toBe(422)
		expect(arrow.json().code).toBe('unsupported_shape_type')
	})

	it('is available to an editor, a viewer and an anonymous caller is refused', async () => {
		humanWrite((txn, page) => txn.set(sid('todo'), textRecord(sid('todo'), ['x'], page)))
		const url = `/api/rooms/${f.boardId}/shapes/${sid('todo')}`
		expect((await f.viewer.get(url)).statusCode).toBe(200)
		expect((await f.editor.get(url)).statusCode).toBe(200)
		expect((await f.anonymous.get(url)).statusCode).toBe(401)
		expect((await f.nonmember.get(url)).statusCode).toBe(404)
	})
})

describe('a lossy preview may never authorize a replacement', () => {
	beforeEach(() => humanWrite((txn, page) => txn.set(sid('todo'), textRecord(sid('todo'), LONG_LINES, page))))

	it('refuses update_text built from the 500-character preview, and the original stays byte-identical', async () => {
		const writer = await token('le-writer', 'read-write')
		const before = JSON.stringify(record(sid('todo')))
		const preview = (await canvasObject(writer, sid('todo'))).text as string
		for (const extra of [{}, { expectedRevision: revisionOf(sid('todo')) }]) {
			const response = await act(writer, [{ tool: 'update_text', id: sid('todo'), text: preview, ...extra }])
			expect(response.statusCode, response.body).toBe(409)
			expect(response.json()).toMatchObject({ code: 'source_truncated', details: { id: sid('todo'), originalLength: LONG_LENGTH } })
		}
		expect(JSON.stringify(record(sid('todo')))).toBe(before)
	})

	it('also refuses it when only paragraph structure was omitted (short text), under a different code', async () => {
		humanWrite((txn, page) => txn.set(sid('short'), textRecord(sid('short'), ['first', 'second'], page)))
		const writer = await token('le-writer', 'read-write')
		const response = await act(writer, [{ tool: 'update_text', id: sid('short'), text: 'first second' }])
		expect(response.statusCode).toBe(409)
		expect(response.json().code).toBe('source_lossy')
		expect(plainContent(record(sid('short')).props.richText).text).toBe('first\nsecond')
	})

	it('an acknowledgement or a digest still needs expectedRevision: it never replaces concurrency protection', async () => {
		const writer = await token('le-writer', 'read-write')
		const before = JSON.stringify(record(sid('todo')))
		const digest = contentDigest(record(sid('todo')).props.richText)
		for (const extra of [{ overwriteTruncatedSource: true }, { expectedContentDigest: digest }]) {
			const response = await act(writer, [{ tool: 'update_text', id: sid('todo'), text: 'replacement', ...extra }])
			expect(response.statusCode, response.body).toBe(422)
			expect(response.json().code).toBe('expected_revision_required')
		}
		expect(JSON.stringify(record(sid('todo')))).toBe(before)
	})

	it('allows a deliberate full replacement with the explicit acknowledgement and the right revision, and rejects a stale revision even with it', async () => {
		const writer = await token('le-writer', 'read-write')
		const stale = revisionOf(sid('todo'))
		humanWrite((txn) => txn.set(sid('todo'), { ...txn.get(sid('todo')), x: 10 }))
		const before = JSON.stringify(record(sid('todo')))
		const refused = await act(writer, [{ tool: 'update_text', id: sid('todo'), text: 'new', overwriteTruncatedSource: true, expectedRevision: stale }])
		expect(refused.statusCode).toBe(409)
		expect(refused.json()).toMatchObject({ code: 'revision_conflict', details: { expectedRevision: stale, currentRevision: revisionOf(sid('todo')) } })
		expect(JSON.stringify(record(sid('todo')))).toBe(before)
		const accepted = await act(writer, [{ tool: 'update_text', id: sid('todo'), text: 'new', overwriteTruncatedSource: true, expectedRevision: revisionOf(sid('todo')) }])
		expect(accepted.statusCode, accepted.body).toBe(200)
		expect(plainContent(record(sid('todo')).props.richText).text).toBe('new')
	})

	it('allows an edit made from the lossless read: the digest proves the full content was read, and the text can exceed 500 characters', async () => {
		const writer = await token('le-writer', 'read-write')
		const full = (await content(writer, sid('todo'))).json()
		const edited = `${full.text}\nAn added closing line.`
		const response = await act(writer, [{ tool: 'update_text', id: sid('todo'), text: edited, expectedRevision: full.revision, expectedContentDigest: full.contentDigest }])
		expect(response.statusCode, response.body).toBe(200)
		expect(plainContent(record(sid('todo')).props.richText).text).toBe(edited.trim())
		expect(edited.length).toBeGreaterThan(3000)
	})

	it('rejects a digest that is not the current content\'s, a stale revision, and a digest taken before someone else edited', async () => {
		const writer = await token('le-writer', 'read-write')
		const full = (await content(writer, sid('todo'))).json()
		const wrong = await act(writer, [{ tool: 'update_text', id: sid('todo'), text: 'x', expectedRevision: full.revision, expectedContentDigest: '0'.repeat(64) }])
		expect(wrong.statusCode).toBe(409)
		expect(wrong.json().code).toBe('content_digest_mismatch')
		humanWrite((txn) => { const r = txn.get(sid('todo')); txn.set(sid('todo'), { ...r, props: { ...r.props, richText: browserRich(['someone edited this']) } }) })
		const stale = await act(writer, [{ tool: 'update_text', id: sid('todo'), text: 'x', expectedRevision: full.revision, expectedContentDigest: full.contentDigest }])
		expect(stale.statusCode).toBe(409)
		expect(stale.json().code).toBe('revision_conflict')
		expect(plainContent(record(sid('todo')).props.richText).text).toBe('someone edited this')
	})
})

describe('update_text for text that is not lossy keeps working, with optional concurrency', () => {
	it('needs no revision for exact text (existing callers are unaffected), but honours one when given', async () => {
		const writer = await token('le-writer', 'read-write')
		await act(writer, [{ tool: 'create_text', id: sid('plain'), text: 'before', x: 0, y: 0 }])
		expect((await act(writer, [{ tool: 'update_text', id: sid('plain'), text: 'after' }])).statusCode).toBe(200)
		const rev = revisionOf(sid('plain'))
		expect((await act(writer, [{ tool: 'update_text', id: sid('plain'), text: 'again', expectedRevision: rev + 5 }])).statusCode).toBe(409)
		expect((await act(writer, [{ tool: 'update_text', id: sid('plain'), text: 'again', expectedRevision: rev }])).statusCode).toBe(200)
	})

	it('allows up to 20,000 characters when updating, still refuses 20,001, and creating text keeps its 500-character limit', async () => {
		const writer = await token('le-writer', 'read-write')
		await act(writer, [{ tool: 'create_text', id: sid('big'), text: 'seed', x: 0, y: 0 }])
		expect((await act(writer, [{ tool: 'update_text', id: sid('big'), text: 'y'.repeat(20_000) }])).statusCode).toBe(200)
		expect((await act(writer, [{ tool: 'update_text', id: sid('big'), text: 'y'.repeat(20_001) }])).statusCode).toBe(422)
		expect((await act(writer, [{ tool: 'create_text', id: sid('big2'), text: 'y'.repeat(501), x: 0, y: 0 }])).statusCode).toBe(422)
	})
})

describe('History permission and exact shape history', () => {
	beforeEach(() => humanWrite((txn, page) => txn.set(sid('todo'), textRecord(sid('todo'), LONG_LINES, page))))

	it('read+write cannot inspect History (403); adding history can (200) without restore, and board-wide restore stays denied', async () => {
		const writer = await token('le-writer', 'read-write')
		const historian = await token('le-historian', 'read-write-history')
		expect((await call(writer, 'GET', `/api/boards/${f.boardId}/history`)).statusCode).toBe(403)
		expect((await shapeHistory(writer, sid('todo'))).statusCode).toBe(403)
		expect((await call(historian, 'GET', `/api/boards/${f.boardId}/history`)).statusCode).toBe(200)
		expect((await shapeHistory(historian, sid('todo'))).statusCode).toBe(200)
		expect((await call(historian, 'POST', `/api/boards/${f.boardId}/restore`, { eventId: 1, expectedClock: clock() })).statusCode).toBe(403)
	})

	it('returns the EXACT original content of every revision, never a preview, with who, when and what changed', async () => {
		const writer = await token('le-writer', 'read-write')
		const historian = await token('le-historian', 'read-write-history')
		const original = JSON.stringify(record(sid('todo')).props.richText)
		await act(writer, [{ tool: 'update_text', id: sid('todo'), text: 'damaged', overwriteTruncatedSource: true, expectedRevision: revisionOf(sid('todo')) }])
		const body = (await shapeHistory(historian, sid('todo'))).json()
		expect(body.shapeId).toBe(sid('todo'))
		expect(body.current).toEqual({ exists: true, revision: revisionOf(sid('todo')) })
		expect(body.events).toHaveLength(2)
		const [damage, creation] = body.events
		expect(damage).toMatchObject({ action: 'edited', source: 'ai', actorUserId: 'token:le-writer', changedFields: ['props.richText'], recovery: null })
		expect(damage.content.text).toBe('damaged')
		expect(creation).toMatchObject({ action: 'created', source: 'human', actorUserId: `user:${f.owner.userId}` })
		expect(JSON.stringify(creation.content.richText)).toBe(original)
		expect(creation.content.text).toBe(LONG_LINES.join('\n'))
		expect(creation.content.originalLength).toBe(LONG_LENGTH)
		expect(creation.content.contentDigest).toBe(contentDigest(browserRich(LONG_LINES)))
		expect(creation.revision).toBeLessThan(damage.revision)
		expect(body.actors.map((a: any) => a.id).sort()).toEqual([`user:${f.owner.userId}`, 'token:le-writer'].sort())
	})

	it('pages with limit and before, and refuses malformed filters', async () => {
		const writer = await token('le-writer', 'read-write')
		const historian = await token('le-historian', 'read-write-history')
		for (let i = 0; i < 3; i += 1) await act(writer, [{ tool: 'update_text', id: sid('todo'), text: `v${i}`, overwriteTruncatedSource: true, expectedRevision: revisionOf(sid('todo')) }])
		const first = (await shapeHistory(historian, sid('todo'), '?limit=2')).json()
		expect(first.events).toHaveLength(2)
		expect(first.nextCursor).toBe(first.events[1].eventId)
		const rest = (await shapeHistory(historian, sid('todo'), `?limit=2&before=${first.nextCursor}`)).json()
		expect(rest.events.map((e: any) => e.eventId)).toEqual([events().filter((e) => e.changes.includes(sid('todo')))[1].id, events().filter((e) => e.changes.includes(sid('todo')))[0].id].filter((id) => id < first.nextCursor))
		expect((await shapeHistory(historian, sid('todo'), '?limit=abc')).statusCode).toBe(400)
	})
})

describe('recovering one shape, and nothing else', () => {
	/** The Maze sequence: a person writes a long text, an agent damages it, other things change, then the one shape is recovered. */
	async function damaged() {
		humanWrite((txn, page) => {
			txn.set(sid('todo'), textRecord(sid('todo'), LONG_LINES, page))
			txn.set(sid('architecture'), { ...textRecord(sid('architecture'), ['architecture'], page), x: 0, y: 0 })
			txn.set(sid('notes'), { ...textRecord(sid('notes'), ['notes'], page), x: 0, y: 100 })
		})
		const writer = await token('le-writer', 'read-write')
		const historian = await token('le-recoverer', 'read-write-history')
		const original = JSON.stringify(record(sid('todo')).props.richText)
		const preDamageRevision = revisionOf(sid('todo'))
		const damage = await act(writer, [{ tool: 'update_text', id: sid('todo'), text: 'short replacement', overwriteTruncatedSource: true, expectedRevision: preDamageRevision }])
		expect(damage.statusCode, damage.body).toBe(200)
		return { writer, historian, original, preDamageRevision }
	}

	it('restores the SAME shape\'s exact text, keeps every unrelated later change, adds no duplicate, and records the recovery while the damage stays visible', async () => {
		const { writer, historian, original, preDamageRevision } = await damaged()
		// meanwhile: other shapes change (by an agent and a person), and the damaged shape is moved by a person
		await act(writer, [{ tool: 'move_shape', id: sid('architecture'), x: 500, y: 600 }])
		humanWrite((txn) => { txn.set(sid('notes'), { ...txn.get(sid('notes')), x: 77, y: 88 }); txn.set(sid('todo'), { ...txn.get(sid('todo')), x: 300, y: 400 }) })
		const countBefore = records().filter((r) => r.typeName === 'shape').length
		const others = JSON.stringify([records().find((r) => r.id === sid('architecture')), records().find((r) => r.id === sid('notes'))])
		const damageEventsBefore = events().length

		const response = await restore(historian, sid('todo'), { revision: preDamageRevision, expectedCurrentRevision: revisionOf(sid('todo')) })
		expect(response.statusCode, response.body).toBe(200)
		expect(response.json()).toMatchObject({ shapeId: sid('todo'), mode: 'content', restored: true, changed: true, changedFields: ['props.richText'] })

		const now = record(sid('todo'))
		expect(now.id).toBe(sid('todo'))
		expect(JSON.stringify(now.props.richText)).toBe(original)
		expect(plainContent(now.props.richText).text).toBe(LONG_LINES.join('\n'))
		expect([now.x, now.y]).toEqual([300, 400])
		expect(records().filter((r) => r.typeName === 'shape')).toHaveLength(countBefore)
		expect(JSON.stringify([records().find((r) => r.id === sid('architecture')), records().find((r) => r.id === sid('notes'))])).toBe(others)

		const all = events()
		expect(all).toHaveLength(damageEventsBefore + 1)
		const last = all.at(-1)!
		expect(last).toMatchObject({ type: 'object.edited', source: 'ai', actor: 'token:le-recoverer' })
		expect(JSON.parse(last.meta)).toMatchObject({ recovery: true, recoveryMode: 'content', targetShapeId: sid('todo'), sourceRevision: preDamageRevision, previousLength: 17, restoredLength: LONG_LENGTH })
		expect(JSON.parse(last.changes).map((c: any) => c.recordId)).toEqual([sid('todo')])
		const history = (await shapeHistory(historian, sid('todo'))).json()
		// newest first: the recovery, the person's move of the shape, the agent's damaging edit (still visible), and the original creation
		expect(history.events.map((e: any) => [e.action, e.content?.originalLength ?? null, e.recovery ? 'recovery' : 'edit'])).toEqual([['edited', LONG_LENGTH, 'recovery'], ['edited', 17, 'edit'], ['edited', 17, 'edit'], ['created', LONG_LENGTH, 'edit']])
		expect(history.events.map((e: any) => e.changedFields)).toEqual([['props.richText'], ['x', 'y'], ['props.richText'], expect.arrayContaining(['id'])])
	})

	it('content-and-placement also restores position, but still not parent, layer or any other shape', async () => {
		const { historian, preDamageRevision } = await damaged()
		humanWrite((txn) => txn.set(sid('todo'), { ...txn.get(sid('todo')), x: 300, y: 400 }))
		const index = record(sid('todo')).index
		const response = await restore(historian, sid('todo'), { revision: preDamageRevision, expectedCurrentRevision: revisionOf(sid('todo')), mode: 'content-and-placement' })
		expect(response.statusCode, response.body).toBe(200)
		expect([record(sid('todo')).x, record(sid('todo')).y]).toEqual([1278, 242])
		expect(record(sid('todo')).index).toBe(index)
		expect(JSON.parse(events().at(-1)!.meta)).toMatchObject({ recovery: true, recoveryMode: 'content-and-placement' })
	})

	it('rejects a stale expectedCurrentRevision with 409 and changes nothing: not the record, the clock or History', async () => {
		const { historian, preDamageRevision } = await damaged()
		const selected = revisionOf(sid('todo'))
		humanWrite((txn) => txn.set(sid('todo'), { ...txn.get(sid('todo')), x: 999 }))
		const snapshot = JSON.stringify(record(sid('todo'))), eventCount = events().length, at = clock()
		const response = await restore(historian, sid('todo'), { revision: preDamageRevision, expectedCurrentRevision: selected })
		expect(response.statusCode).toBe(409)
		expect(response.json()).toMatchObject({ code: 'revision_conflict', details: { expectedCurrentRevision: selected, currentRevision: revisionOf(sid('todo')) } })
		expect(JSON.stringify(record(sid('todo')))).toBe(snapshot)
		expect(events()).toHaveLength(eventCount)
		expect(clock()).toBe(at)
	})

	it('dryRun previews exactly what would change, including what else happened since, and writes nothing', async () => {
		const { writer, historian, preDamageRevision } = await damaged()
		await act(writer, [{ tool: 'move_shape', id: sid('architecture'), x: 500, y: 600 }])
		const snapshot = JSON.stringify(record(sid('todo'))), eventCount = events().length, at = clock()
		const response = await restore(historian, sid('todo'), { revision: preDamageRevision, expectedCurrentRevision: revisionOf(sid('todo')), dryRun: true })
		expect(response.statusCode, response.body).toBe(200)
		const body = response.json()
		expect(body).toMatchObject({ dryRun: true, restored: false, changed: true, changedFields: ['props.richText'], mode: 'content' })
		expect(body.current).toMatchObject({ originalLength: 17, revision: revisionOf(sid('todo')) })
		expect(body.source).toMatchObject({ originalLength: LONG_LENGTH, revision: preDamageRevision, eventSource: 'human' })
		expect(body.preserved).toEqual(expect.arrayContaining(['x', 'y', 'rotation', 'index', 'parentId']))
		expect(body.unrelatedChangesSinceSource).toMatchObject({ otherRecordsTouched: 1, eventsBySource: { ai: 2 } })
		expect(JSON.stringify(record(sid('todo')))).toBe(snapshot)
		expect(events()).toHaveLength(eventCount)
		expect(clock()).toBe(at)
	})

	it('is a no-op (nothing written) when the shape already has that content', async () => {
		const { historian, preDamageRevision } = await damaged()
		await restore(historian, sid('todo'), { revision: preDamageRevision, expectedCurrentRevision: revisionOf(sid('todo')) })
		const eventCount = events().length
		const again = await restore(historian, sid('todo'), { revision: preDamageRevision, expectedCurrentRevision: revisionOf(sid('todo')) })
		expect(again.statusCode).toBe(200)
		expect(again.json()).toMatchObject({ changed: false, restored: false })
		expect(events()).toHaveLength(eventCount)
	})

	it('refuses what it cannot recover: a missing revision, a deletion, a deleted shape, an arrow, and a body that names no source', async () => {
		const { writer, historian, preDamageRevision } = await damaged()
		const current = revisionOf(sid('todo'))
		expect((await restore(historian, sid('todo'), { revision: 99_999, expectedCurrentRevision: current })).json().code).toBe('revision_not_found')
		expect((await restore(historian, sid('todo'), { expectedCurrentRevision: current })).statusCode).toBe(422)
		expect((await restore(historian, sid('todo'), { revision: preDamageRevision, expectedCurrentRevision: current, mode: 'everything' })).statusCode).toBe(422)
		expect((await restore(historian, sid('todo'), { revision: preDamageRevision, eventId: 1, expectedCurrentRevision: current })).statusCode).toBe(404)
		expect((await restore(historian, sid('todo'), { revision: preDamageRevision, expectedCurrentRevision: current, unknown: 1 })).statusCode).toBe(422)
		await act(writer, [{ tool: 'create_shape', id: sid('a'), type: 'rectangle', text: 'a', x: 0, y: 0, width: 100, height: 100 }, { tool: 'create_shape', id: sid('b'), type: 'rectangle', text: 'b', x: 300, y: 0, width: 100, height: 100 }, { tool: 'connect_shapes', id: sid('link'), fromId: sid('a'), toId: sid('b') }])
		const linkRevision = revisionOf(sid('link'))
		expect((await restore(historian, sid('link'), { revision: linkRevision, expectedCurrentRevision: linkRevision })).json().code).toBe('unsupported_shape_type')
		await act(writer, [{ tool: 'delete_shape', id: sid('todo') }])
		const gone = await restore(historian, sid('todo'), { revision: preDamageRevision, expectedCurrentRevision: current })
		expect(gone.statusCode).toBe(404)
		expect(gone.json().code).toBe('shape_not_found')
	})

	it('needs history AND write to recover, history alone to preview; board-wide restore is never involved', async () => {
		const { preDamageRevision } = await damaged()
		const body = { revision: preDamageRevision, expectedCurrentRevision: revisionOf(sid('todo')) }
		const readHistory = await token('le-readhistory', 'read-history')
		const writeOnly = await token('le-writeonly', 'read-write')
		const fullAccess = await token('le-full', 'full')
		expect((await restore(readHistory, sid('todo'), body)).statusCode).toBe(403)
		expect((await restore(writeOnly, sid('todo'), body)).statusCode).toBe(403)
		expect((await restore(writeOnly, sid('todo'), { ...body, dryRun: true })).statusCode).toBe(403)
		expect((await restore(readHistory, sid('todo'), { ...body, dryRun: true })).statusCode).toBe(200)
		expect(plainContent(record(sid('todo')).props.richText).text).toBe('short replacement')
		expect((await restore(fullAccess, sid('todo'), body)).statusCode).toBe(200)
		// people: a viewer may preview but not recover; an editor may recover; others are refused
		humanWrite((txn) => txn.set(sid('todo'), { ...txn.get(sid('todo')), props: { ...txn.get(sid('todo')).props, richText: browserRich(['changed again']) } }))
		const next = { revision: preDamageRevision, expectedCurrentRevision: revisionOf(sid('todo')) }
		expect((await f.viewer.post(`/api/boards/${f.boardId}/shapes/${sid('todo')}/restore`, next)).statusCode).toBe(403)
		expect((await f.viewer.post(`/api/boards/${f.boardId}/shapes/${sid('todo')}/restore`, { ...next, dryRun: true })).statusCode).toBe(200)
		expect((await f.anonymous.post(`/api/boards/${f.boardId}/shapes/${sid('todo')}/restore`, next)).statusCode).toBe(401)
		expect((await f.nonmember.post(`/api/boards/${f.boardId}/shapes/${sid('todo')}/restore`, next)).statusCode).toBe(404)
		const editor = await f.editor.post(`/api/boards/${f.boardId}/shapes/${sid('todo')}/restore`, next)
		expect(editor.statusCode, editor.body).toBe(200)
		expect(events().at(-1)).toMatchObject({ source: 'human', actor: `user:${f.editor.userId}` })
	})
})

describe('an agent can learn its own permissions', () => {
	it('reports exactly the effective scopes and derived capabilities for each access level', async () => {
		const cases: Array<['read' | 'read-write' | 'read-write-history' | 'full', Record<string, boolean>]> = [
			['read-write', { canRead: true, canWrite: true, canViewHistory: false, canRecoverShapes: false, canRestoreBoard: false }],
			['read-write-history', { canRead: true, canWrite: true, canViewHistory: true, canRecoverShapes: true, canRestoreBoard: false }],
			['full', { canRead: true, canWrite: true, canViewHistory: true, canRecoverShapes: true, canRestoreBoard: true }],
		]
		for (const [access, expected] of cases) {
			const bearer = await token(`le-${access}`, access)
			const body = (await call(bearer, 'GET', `/api/agent-session?boardId=${f.boardId}`)).json()
			expect(body).toMatchObject({ agent: `le-${access}`, kind: 'board', boardId: f.boardId, boardAccess: true, accountCapabilities: [], ...expected })
			expect(body.permissions).toEqual(expect.arrayContaining(access === 'read-write' ? ['read', 'write'] : access === 'read-write-history' ? ['read', 'write', 'history'] : ['read', 'write', 'history', 'restore']))
			expect(body.permissions).toHaveLength(access === 'read-write' ? 2 : access === 'read-write-history' ? 3 : 4)
		}
	})

	it('without a board id lists the boards it reaches; for a board it does not reach says so without revealing anything else', async () => {
		const bearer = await token('le-scope', 'read-write')
		const all = (await call(bearer, 'GET', '/api/agent-session')).json()
		expect(all.boards).toEqual([f.boardId])
		const other = (await call(bearer, 'GET', '/api/agent-session?boardId=some-other-board')).json()
		expect(other).toMatchObject({ boardId: 'some-other-board', boardAccess: false, permissions: [], canRead: false, canWrite: false, canRestoreBoard: false })
		expect((await call(bearer, 'GET', '/api/agent-session?boardId=bad%20id')).statusCode).toBe(400)
	})

	it('never returns the token, its hash, a fingerprint or any credential, and shows an expiry when there is one', async () => {
		const created = await createClient({ file: storeFile, name: 'le-expiring', rooms: [f.boardId], access: 'read-write', expiresAt: '2030-01-01T00:00:00Z' })
		const response = await call(created.token, 'GET', `/api/agent-session?boardId=${f.boardId}`)
		const text = response.body
		expect(response.json().expiresAt).toBe('2030-01-01T00:00:00.000Z')
		expect(text).not.toContain(created.token)
		expect(text.toLowerCase()).not.toMatch(/tokenhash|fingerprint|authorization|cookie|secret|jwt/)
		expect(text).not.toMatch(/[0-9a-f]{64}/)
		expect(response.headers['cache-control']).toBe('no-store')
	})

	it('answers 401 to a missing, malformed or unknown bearer and to a human session cookie alone', async () => {
		expect((await f.app.inject({ method: 'GET', url: '/api/agent-session' })).statusCode).toBe(401)
		expect((await call('x'.repeat(40), 'GET', '/api/agent-session')).statusCode).toBe(401)
		expect((await f.owner.get('/api/agent-session')).statusCode).toBe(401)
	})
})

describe('changing an agent\'s access deliberately, through rotation', () => {
	const rotate = (ref: string, body: unknown) => f.owner.post(`/api/agent-access/${ref}/rotate`, body)
	async function newAgent(access = 'read-write') {
		const response = await f.owner.post('/api/agent-access', { boardId: f.boardId, displayName: 'scope test', access })
		expect(response.statusCode, response.body).toBe(201)
		return response.json() as { agent: { ref: string; name: string; permissions: string[] }; token: string }
	}
	const auditRows = () => {
		const db = new Database(join(f.directory, 'auth.sqlite'), { readonly: true })
		try { return db.prepare("SELECT type, metadata_json FROM account_events WHERE type LIKE 'agent.%' ORDER BY id").all() as Array<{ type: string; metadata_json: string }> } finally { db.close() }
	}

	it('expands read+write to read+write+history: old bearer dead, new bearer works, history 200, restore still denied, board unchanged, audited', async () => {
		const created = await newAgent()
		expect((await call(created.token, 'GET', `/api/boards/${f.boardId}/history`)).statusCode).toBe(403)
		const response = await rotate(created.agent.ref, { access: 'read-write-history' })
		expect(response.statusCode, response.body).toBe(200)
		const body = response.json()
		expect(body.accessChange).toEqual({ previous: ['read', 'write'], current: ['read', 'write', 'history'], added: ['history'], removed: [] })
		expect(body.agent.permissions).toEqual(['read', 'write', 'history'])
		expect(body.agent.rooms).toEqual([f.boardId])
		expect((await call(created.token, 'GET', `/api/rooms/${f.boardId}/canvas`)).statusCode).toBe(401)
		expect((await call(body.token, 'GET', `/api/rooms/${f.boardId}/canvas`)).statusCode).toBe(200)
		expect((await call(body.token, 'GET', `/api/boards/${f.boardId}/history`)).statusCode).toBe(200)
		expect((await call(body.token, 'POST', `/api/boards/${f.boardId}/restore`, { eventId: 1, expectedClock: clock() })).statusCode).toBe(403)
		expect((await call(body.token, 'GET', '/api/agent-session')).json()).toMatchObject({ canViewHistory: true, canRestoreBoard: false, boards: [f.boardId] })
		const rows = auditRows()
		const changed = JSON.parse(rows.find((r) => r.type === 'agent.access_changed')!.metadata_json)
		expect(changed).toMatchObject({ agent: created.agent.name, oldScopes: ['read', 'write'], newScopes: ['read', 'write', 'history'], added: ['history'], removed: [] })
		expect(rows.some((r) => r.type === 'agent.rotated')).toBe(true)
		expect(JSON.stringify(rows)).not.toContain(body.token)
		expect(JSON.stringify(rows)).not.toContain(created.token)
	})

	it('adding restore needs an explicit acknowledgement; without it nothing changes, and the old bearer still works', async () => {
		const created = await newAgent()
		const refused = await rotate(created.agent.ref, { access: 'full' })
		expect(refused.statusCode).toBe(422)
		expect(refused.json().code).toBe('restore_not_acknowledged')
		expect((await call(created.token, 'GET', `/api/rooms/${f.boardId}/canvas`)).statusCode).toBe(200)
		const accepted = await rotate(created.agent.ref, { access: 'full', acknowledgeRestore: true })
		expect(accepted.statusCode, accepted.body).toBe(200)
		expect(accepted.json().accessChange.added).toEqual(['history', 'restore'])
		expect((await call(accepted.json().token, 'GET', '/api/agent-session')).json()).toMatchObject({ canRestoreBoard: true })
	})

	it('adding history never adds restore, and history alone never reaches the board-wide restore', async () => {
		const created = await newAgent('read')
		const body = (await rotate(created.agent.ref, { access: 'read-write-history' })).json()
		expect(body.accessChange.added).toEqual(['write', 'history'])
		expect(body.agent.permissions).not.toContain('restore')
	})

	it('can also narrow access, and reports what was removed; a change to the same access is an ordinary rotation', async () => {
		const created = await newAgent('read-write-history')
		const narrowed = (await rotate(created.agent.ref, { access: 'read' })).json()
		expect(narrowed.accessChange).toMatchObject({ added: [], removed: ['write', 'history'] })
		expect(auditRows().filter((r) => r.type === 'agent.access_changed')).toHaveLength(1)
		const same = (await rotate(narrowed.agent.ref, { access: 'read' })).json()
		expect(same.accessChange).toMatchObject({ added: [], removed: [] })
		expect(auditRows().filter((r) => r.type === 'agent.access_changed')).toHaveLength(1)
	})

	it('without access, rotation behaves exactly as before: permissions kept, no scope-change audit', async () => {
		const created = await newAgent('read-write')
		const body = (await rotate(created.agent.ref, {})).json()
		expect(body.agent.permissions).toEqual(['read', 'write'])
		expect(body.accessChange).toBeUndefined()
		expect(auditRows().some((r) => r.type === 'agent.access_changed')).toBe(false)
	})

	it('rejects an unknown access mode and a non-true acknowledgement, and an agent cannot change its own access', async () => {
		const created = await newAgent()
		expect((await rotate(created.agent.ref, { access: 'root' })).statusCode).toBe(422)
		expect((await rotate(created.agent.ref, { access: 'full', acknowledgeRestore: false })).statusCode).toBe(422)
		const viaBearer = await f.app.inject({ method: 'POST', url: `/api/agent-access/${created.agent.ref}/rotate`, headers: { authorization: `Bearer ${created.token}` }, payload: { access: 'full', acknowledgeRestore: true } })
		expect([401, 403]).toContain(viaBearer.statusCode)
		expect((await call(created.token, 'GET', '/api/agent-session')).json().canRestoreBoard).toBe(false)
	})
})
