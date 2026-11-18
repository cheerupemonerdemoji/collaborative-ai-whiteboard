import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { rename, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { inspectCadArtifact, storeCadArtifact } from '../server/cad-artifacts'
import {
	addCadComment,
	addCadEvidence,
	appendCadRevision,
	approvedCadRevision,
	CAD_LIMITS,
	cadModelSchema,
	cadModelStatus,
	cadReviewShapeProps,
	CadModelError,
	createCadModel,
	latestCadRevision,
	transitionCadRevision,
	type CadActor,
	type CadModel,
} from '../shared/cad-model'
import { buildSampleGlb, SAMPLE_STEP_TEXT } from '../shared/cad-sample'

const person: CadActor = { userId: 'user:alice', displayName: 'Alice', source: 'human' }
const other: CadActor = { userId: 'user:bob', displayName: 'Bob', source: 'human' }
const agent: CadActor = { userId: 'token:agent', displayName: 'agent', source: 'ai' }
const sha = (letter: string) => letter.repeat(64)
const glb = (letter: string) => ({ glb: { assetId: `cad-${sha(letter)}.glb`, sha256: sha(letter), bytes: 2_000, name: 'spacer.glb' } })

function baseline(): CadModel {
	return createCadModel({ id: 'cad_model:0123456789ab', modelId: 'SPACER-1', name: 'Spacer', units: 'mm', revision: { id: 'rev-aaaaaa', files: glb('a'), changeNote: 'baseline' } }, person, 1_000)
}
function approved(): CadModel {
	return transitionCadRevision(transitionCadRevision(baseline(), 'rev-aaaaaa', 'in-review', person, '', 2_000), 'rev-aaaaaa', 'approved', other, 'Measured against the part', 3_000)
}
const refusal = (fn: () => unknown) => { try { fn() } catch (error) { return error as CadModelError } throw new Error('expected a refusal') }

describe('CAD model rules', () => {
	it('creates a model whose first revision is a draft, whoever creates it', () => {
		for (const actor of [person, agent]) {
			const model = createCadModel({ id: 'cad_model:0123456789ab', modelId: 'X', name: 'X', units: 'mm', revision: { id: 'rev-aaaaaa', files: glb('a'), changeNote: '' } }, actor, 1)
			expect(latestCadRevision(model).status).toBe('draft')
			expect(model.revisions[0].createdBy.source).toBe(actor.source)
		}
	})

	it('walks a revision through review and records who decided and when', () => {
		const model = approved()
		expect(cadModelStatus(model)).toBe('approved')
		expect(model.revisions[0].decision).toEqual({ by: other, at: 3_000, note: 'Measured against the part' })
	})

	it('lets a reviewer reject, send back to draft and resubmit', () => {
		let model = transitionCadRevision(baseline(), 'rev-aaaaaa', 'in-review', person, '', 2)
		model = transitionCadRevision(model, 'rev-aaaaaa', 'rejected', other, 'Wrong bore', 3)
		expect(model.revisions[0].decision?.note).toBe('Wrong bore')
		model = transitionCadRevision(model, 'rev-aaaaaa', 'draft', person, '', 4)
		expect(model.revisions[0].decision).toBeUndefined()
		expect(cadModelStatus(model)).toBe('draft')
	})

	it('refuses an illegal transition, and treats approval as final', () => {
		expect(refusal(() => transitionCadRevision(baseline(), 'rev-aaaaaa', 'approved', person, '', 2)).statusCode).toBe(409)
		for (const to of ['draft', 'in-review', 'rejected'] as const) {
			const error = refusal(() => transitionCadRevision(approved(), 'rev-aaaaaa', to, person, '', 4))
			expect(error.statusCode).toBe(409)
			expect(error.message).toMatch(/approved revision is final/i)
		}
	})

	it('never lets an AI client decide, review, comment or link evidence', () => {
		const inReview = transitionCadRevision(baseline(), 'rev-aaaaaa', 'in-review', person, '', 2)
		for (const to of ['approved', 'rejected', 'draft'] as const) expect(refusal(() => transitionCadRevision(inReview, 'rev-aaaaaa', to, agent, '', 3)).statusCode).toBe(403)
		expect(refusal(() => transitionCadRevision(baseline(), 'rev-aaaaaa', 'in-review', agent, '', 3)).statusCode).toBe(403)
		expect(refusal(() => addCadComment(baseline(), { id: 'cmt-aaaaaa', revisionId: 'rev-aaaaaa', body: 'hi' }, agent, 3)).statusCode).toBe(403)
		expect(refusal(() => addCadEvidence(baseline(), { id: 'evd-aaaaaa', kind: 'note', label: 'x' }, agent, 3)).statusCode).toBe(403)
	})

	it('lets an AI client propose a new revision, but only as an attributed draft that leaves the approved one untouched', () => {
		const before = approved()
		const proposed = appendCadRevision(before, { id: 'rev-bbbbbb', files: glb('b'), changeNote: 'AI proposal' }, agent, 4_000)
		expect(proposed.revisions).toHaveLength(2)
		expect(proposed.revisions[1]).toMatchObject({ number: 2, status: 'draft', createdBy: agent })
		expect(proposed.revisions[1].decision).toBeUndefined()
		expect(proposed.revisions[0]).toEqual(before.revisions[0])
		expect(approvedCadRevision(proposed)?.id).toBe('rev-aaaaaa')
		expect(cadModelStatus(proposed)).toBe('draft')
	})

	it('does not let a person approve an AI proposal without the proposal passing through review', () => {
		const proposed = appendCadRevision(approved(), { id: 'rev-bbbbbb', files: glb('b'), changeNote: '' }, agent, 4_000)
		expect(refusal(() => transitionCadRevision(proposed, 'rev-bbbbbb', 'approved', person, '', 5_000)).statusCode).toBe(409)
	})

	it('only lets the newest revision change status, so a superseded draft cannot be approved later', () => {
		const second = appendCadRevision(baseline(), { id: 'rev-bbbbbb', files: glb('b'), changeNote: '' }, person, 2)
		expect(refusal(() => transitionCadRevision(second, 'rev-aaaaaa', 'in-review', person, '', 3)).statusCode).toBe(409)
		expect(refusal(() => transitionCadRevision(second, 'rev-nothere', 'in-review', person, '', 3)).statusCode).toBe(404)
	})

	it('numbers revisions in order and enforces the revision limit', () => {
		let model = baseline()
		for (let index = 2; index <= CAD_LIMITS.maxRevisions; index++) model = appendCadRevision(model, { id: `rev-${String(index).padStart(6, '0')}`, files: glb('c'), changeNote: '' }, person, index)
		expect(model.revisions.map((revision) => revision.number)).toEqual(Array.from({ length: CAD_LIMITS.maxRevisions }, (_, index) => index + 1))
		expect(() => appendCadRevision(model, { id: 'rev-zzzzzz', files: glb('c'), changeNote: '' }, person, 99)).toThrow(/revision limit/)
	})

	it('binds comments to a revision that exists and stamps the author from the actor', () => {
		const model = addCadComment(baseline(), { id: 'cmt-aaaaaa', revisionId: 'rev-aaaaaa', body: ' Confirm the bore. ' }, person, 5)
		expect(model.comments[0]).toMatchObject({ author: person, body: 'Confirm the bore.', revisionId: 'rev-aaaaaa', createdAt: 5 })
		expect(refusal(() => addCadComment(baseline(), { id: 'cmt-aaaaaa', revisionId: 'rev-unknown', body: 'x' }, person, 5)).statusCode).toBe(404)
		expect(() => addCadComment(baseline(), { id: 'cmt-aaaaaa', revisionId: 'rev-aaaaaa', body: '   ' }, person, 5)).toThrow(/required/)
	})

	it('requires a reference for entity and asset evidence, and none for a note', () => {
		expect(() => addCadEvidence(baseline(), { id: 'evd-aaaaaa', kind: 'entity', label: 'Test report' }, person, 5)).toThrow(/needs a reference/)
		const model = addCadEvidence(baseline(), { id: 'evd-aaaaaa', kind: 'note', label: 'Caliper reading 59.98 mm', ref: 'ignored' }, person, 5)
		expect(model.evidence[0]).toMatchObject({ kind: 'note', label: 'Caliper reading 59.98 mm', addedBy: person })
		expect(model.evidence[0].ref).toBeUndefined()
	})

	it('rejects malformed records: wrong file slot, mismatched hash, no preview, stray decision', () => {
		const model = baseline()
		const parse = (patch: Record<string, unknown>) => cadModelSchema.safeParse({ ...model, revisions: [{ ...model.revisions[0], ...patch }] }).success
		expect(parse({})).toBe(true)
		expect(parse({ files: { step: { ...glb('a').glb, assetId: `cad-${sha('a')}.step` } } })).toBe(false)
		expect(parse({ files: { glb: { ...glb('a').glb, assetId: `cad-${sha('b')}.glb` } } })).toBe(false)
		expect(parse({ files: { glb: { ...glb('a').glb, assetId: `cad-${sha('a')}.stl` } } })).toBe(false)
		expect(parse({ decision: { by: person, at: 1, note: '' } })).toBe(false)
		expect(parse({ status: 'approved' })).toBe(false)
		expect(parse({ extra: true })).toBe(false)
		expect(cadModelSchema.safeParse({ ...model, comments: [{ id: 'cmt-aaaaaa', revisionId: 'rev-zzzzzz', author: person, body: 'x', createdAt: 1 }] }).success).toBe(false)
	})

	it('keeps the card shape light and validates its pointer', () => {
		expect(() => cadReviewShapeProps.modelRecordId.validate('cad_model:0123456789ab')).not.toThrow()
		expect(() => cadReviewShapeProps.modelRecordId.validate('x'.repeat(10_000))).toThrow()
		expect(() => cadReviewShapeProps.modelRecordId.validate('engineering_entity:abc')).toThrow()
		expect(Object.keys(cadReviewShapeProps).sort()).toEqual(['h', 'modelRecordId', 'w'])
	})
})

/* -------------------------------------------------------------------------- artifacts -- */

function glbFrom(edit: (gltf: Record<string, unknown>) => void): Buffer {
	const sample = Buffer.from(buildSampleGlb())
	const jsonLength = sample.readUInt32LE(12)
	const gltf = JSON.parse(sample.subarray(20, 20 + jsonLength).toString('utf8')) as Record<string, unknown>
	edit(gltf)
	const json = Buffer.from(JSON.stringify(gltf))
	const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 0x20)
	json.copy(padded)
	const rest = sample.subarray(20 + jsonLength)
	const header = Buffer.alloc(20)
	header.writeUInt32LE(0x46546c67, 0)
	header.writeUInt32LE(2, 4)
	header.writeUInt32LE(20 + padded.length + rest.length, 8)
	header.writeUInt32LE(padded.length, 12)
	header.writeUInt32LE(0x4e4f534a, 16)
	return Buffer.concat([header, padded, rest])
}
const rejection = (fn: () => unknown) => { try { fn() } catch (error) { return error as { statusCode: number; message: string } } throw new Error('expected a rejection') }

describe('CAD artifact inspection', () => {
	it('accepts the generated sample GLB and STEP and names them by content hash', () => {
		const sample = Buffer.from(buildSampleGlb())
		const inspected = inspectCadArtifact('glb', sample)
		expect(inspected.assetId).toMatch(/^cad-[0-9a-f]{64}\.glb$/)
		expect(inspected.assetId).toBe(inspectCadArtifact('glb', Buffer.from(sample)).assetId)
		expect(inspectCadArtifact('step', Buffer.from(SAMPLE_STEP_TEXT)).assetId).toMatch(/\.step$/)
	})

	it('rejects files that are not what they claim to be', () => {
		expect(rejection(() => inspectCadArtifact('glb', Buffer.from('not a model at all, just some text bytes'))).statusCode).toBe(422)
		expect(rejection(() => inspectCadArtifact('glb', Buffer.from(buildSampleGlb()).subarray(0, 100))).message).toMatch(/truncated|invalid/i)
		expect(rejection(() => inspectCadArtifact('step', Buffer.from('solid x\nfacet\nendsolid'))).message).toMatch(/STEP/)
		expect(rejection(() => inspectCadArtifact('step', Buffer.from('ISO-10303-21;\nHEADER;\n'))).message).toMatch(/truncated/)
		expect(rejection(() => inspectCadArtifact('stl', Buffer.from('hello'))).message).toMatch(/STL/)
		expect(rejection(() => inspectCadArtifact('thumbnail', Buffer.from('GIF89a......................................'))).message).toMatch(/PNG/)
		expect(rejection(() => inspectCadArtifact('glb', Buffer.alloc(0))).statusCode).toBe(422)
		expect(rejection(() => inspectCadArtifact('glb', 'a string')).statusCode).toBe(422)
	})

	it('rejects a GLB that would make the viewer fetch outside the board or needs a decoder it lacks', () => {
		expect(rejection(() => inspectCadArtifact('glb', glbFrom((gltf) => { (gltf.buffers as Array<Record<string, unknown>>)[0].uri = 'https://example.com/data.bin' }))).message).toMatch(/external buffer/)
		expect(rejection(() => inspectCadArtifact('glb', glbFrom((gltf) => { gltf.images = [{ uri: 'http://example.com/a.png' }] }))).message).toMatch(/external image/)
		expect(rejection(() => inspectCadArtifact('glb', glbFrom((gltf) => { gltf.extensionsUsed = ['KHR_draco_mesh_compression'] }))).message).toMatch(/cannot decode/)
		expect(rejection(() => inspectCadArtifact('glb', glbFrom((gltf) => { gltf.extensionsRequired = ['VENDOR_unknown'] }))).message).toMatch(/unsupported extension/)
		expect(rejection(() => inspectCadArtifact('glb', glbFrom((gltf) => { gltf.meshes = [] }))).message).toMatch(/no mesh/)
		expect(rejection(() => inspectCadArtifact('glb', glbFrom((gltf) => { gltf.asset = { version: '1.0' } }))).message).toMatch(/2\.0/)
	})

	it('enforces the size limits before inspecting', () => {
		expect(rejection(() => inspectCadArtifact('thumbnail', Buffer.alloc(CAD_LIMITS.maxThumbnailBytes + 1))).statusCode).toBe(413)
	})
})

describe('storing a CAD artifact', () => {
	const real = { writeFile, rename, unlink }
	function scratch() { return mkdtempSync(join(tmpdir(), 'canvas-cad-store-')) }
	const names = (directory: string) => readdirSync(directory).sort()

	it('writes the bytes to the content-addressed name and leaves nothing else behind', async () => {
		const directory = scratch()
		try {
			await storeCadArtifact(directory, 'cad-x.glb', Buffer.from('bytes'))
			expect(names(directory)).toEqual(['cad-x.glb'])
			expect(readFileSync(join(directory, 'cad-x.glb'), 'utf8')).toBe('bytes')
			await storeCadArtifact(directory, 'cad-x.glb', Buffer.from('different bytes must not replace it'))
			expect(readFileSync(join(directory, 'cad-x.glb'), 'utf8')).toBe('bytes')
		} finally { rmSync(directory, { recursive: true, force: true }) }
	})

	it('never leaves a truncated file at the final name when the write fails midway', async () => {
		const directory = scratch()
		try {
			const half = async (path: string, data: Buffer) => { await writeFile(path, data.subarray(0, 3)); throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }) }
			await expect(storeCadArtifact(directory, 'cad-x.glb', Buffer.from('complete bytes'), { ...real, writeFile: half as never })).rejects.toThrow(/disk full/)
			expect(names(directory)).toEqual([])
			// So a later, healthy upload of the same bytes is stored in full rather than mistaken for "already there".
			await storeCadArtifact(directory, 'cad-x.glb', Buffer.from('complete bytes'))
			expect(readFileSync(join(directory, 'cad-x.glb'), 'utf8')).toBe('complete bytes')
		} finally { rmSync(directory, { recursive: true, force: true }) }
	})

	it('cleans up its temporary file when the final rename fails, and reports the failure', async () => {
		const directory = scratch()
		try {
			const failRename = async () => { throw Object.assign(new Error('cannot rename'), { code: 'EPERM' }) }
			await expect(storeCadArtifact(directory, 'cad-x.glb', Buffer.from('b'), { ...real, rename: failRename as never })).rejects.toThrow(/cannot rename/)
			expect(names(directory)).toEqual([])
		} finally { rmSync(directory, { recursive: true, force: true }) }
	})

	it('accepts losing a race: if another upload put the file in place, a failed rename is not an error', async () => {
		const directory = scratch()
		try {
			const raced = async (temporary: string) => { writeFileSync(join(directory, 'cad-x.glb'), 'bytes'); await unlink(temporary); throw Object.assign(new Error('exists'), { code: 'EEXIST' }) }
			await expect(storeCadArtifact(directory, 'cad-x.glb', Buffer.from('bytes'), { ...real, rename: raced as never })).resolves.toBeUndefined()
			expect(names(directory)).toEqual(['cad-x.glb'])
		} finally { rmSync(directory, { recursive: true, force: true }) }
	})
})

describe('public static files', () => {
	it('contain no CAD model, so a model can only be read through the authenticated board route', () => {
		const found: string[] = []
		const walk = (directory: string) => {
			for (const name of readdirSync(directory)) {
				const path = join(directory, name)
				if (statSync(path).isDirectory()) walk(path)
				else if (/\.(glb|gltf|stl|step|stp|obj|iges|igs)$/i.test(name)) found.push(path)
			}
		}
		walk(join(process.cwd(), 'public'))
		expect(found).toEqual([])
	})
})
