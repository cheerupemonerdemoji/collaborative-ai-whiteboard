import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { AssemblyView, isShown } from '../client/cad/assembly-view'
import { parseCadAssembly } from '../client/cad/cad-scene'
import { extractCadAssembly } from '../server/cad-assembly'
import { inspectCadArtifact } from '../server/cad-artifacts'
import {
	addCadComponentLink,
	appendCadRevision,
	cadModelSchema,
	createCadModel,
	removeCadComponentLink,
	transitionCadRevision,
	type CadActor,
	type CadAssembly,
	type CadModel,
} from '../shared/cad-model'
import { buildSampleAssemblyGlb, buildSampleGlb } from '../shared/cad-sample'

const person: CadActor = { userId: 'user:alice', displayName: 'Alice', source: 'human' }
const reviewer: CadActor = { userId: 'user:bob', displayName: 'Bob', source: 'human' }
const agent: CadActor = { userId: 'token:agent', displayName: 'agent', source: 'ai' }
const sha = (letter: string) => letter.repeat(64)
const glbFile = (letter: string) => ({ glb: { assetId: `cad-${sha(letter)}.glb`, sha256: sha(letter), bytes: 2_000, name: 'part.glb' } })
const sampleAssembly = () => extractCadAssembly(Buffer.from(buildSampleAssemblyGlb()))!

/** Builds a GLB from raw glTF JSON edits, reusing the sample's binary data. */
function glbWith(edit: (gltf: Record<string, any>) => void): Buffer {
	const sample = Buffer.from(buildSampleAssemblyGlb())
	const jsonLength = sample.readUInt32LE(12)
	const gltf = JSON.parse(sample.subarray(20, 20 + jsonLength).toString('utf8'))
	edit(gltf)
	const json = Buffer.from(JSON.stringify(gltf))
	const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 0x20)
	json.copy(padded)
	const rest = sample.subarray(20 + jsonLength)
	const header = Buffer.alloc(20)
	header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(20 + padded.length + rest.length, 8)
	header.writeUInt32LE(padded.length, 12); header.writeUInt32LE(0x4e4f534a, 16)
	return Buffer.concat([header, padded, rest])
}

function assemblyModel(id = 'cad_model:0123456789ab', letter = 'a'): CadModel {
	return createCadModel({ id, modelId: 'ASSY-1', name: 'Assembly', units: 'mm', revision: { id: 'rev-aaaaaa', files: glbFile(letter), assembly: sampleAssembly(), changeNote: '' } }, person, 1_000)
}
function componentModel(id = 'cad_model:ba9876543210'): CadModel {
	return createCadModel({ id, modelId: 'BOLT-1', name: 'Bolt component', units: 'mm', revision: { id: 'rev-cccccc', files: glbFile('c'), changeNote: '' } }, person, 1_000)
}
const lookupOf = (...models: CadModel[]) => (id: string) => models.find((model) => model.id === id)
const refusal = (fn: () => unknown) => { try { fn() } catch (error) { return error as { statusCode: number; message: string } } throw new Error('expected a refusal') }

describe('reading assembly structure from a GLB', () => {
	it('passes inspection and lists the named parts in tree order, with stable identities only where the file gave them', () => {
		expect(() => inspectCadArtifact('glb', Buffer.from(buildSampleAssemblyGlb()))).not.toThrow()
		const { parts } = sampleAssembly()
		expect(parts.map((part) => part.name)).toEqual(['Training bracket assembly', 'Base plate', 'Upright', 'Fasteners', 'Spacer', 'Bolt', 'Unnamed part (node 6)'])
		const byName = Object.fromEntries(parts.map((part) => [part.name, part]))
		expect(['Base plate', 'Upright', 'Spacer', 'Bolt'].map((name) => [byName[name].key, byName[name].stable])).toEqual([['base-plate', true], ['upright', true], ['spacer', true], ['bolt', true]])
		// Groups and the anonymous mesh have no identity in the file, so their key is only a node number and says so.
		for (const name of ['Training bracket assembly', 'Fasteners', 'Unnamed part (node 6)']) expect(byName[name]).toMatchObject({ stable: false, key: `node-${byName[name].node}` })
		expect(byName.Spacer.parent).toBe(byName.Fasteners.key)
		expect(byName.Bolt.parent).toBe(byName.Fasteners.key)
		expect(byName['Unnamed part (node 6)']).toMatchObject({ named: false, mesh: true })
	})

	it('builds the bill of materials only from explicit part numbers and quantities, copied as declared', () => {
		const { bom } = sampleAssembly()
		expect(bom).toEqual([
			{ partKey: 'base-plate', partNumber: 'TRN-BASE-001', description: 'Base plate, 80 x 6 x 50', quantity: 1, source: 'glb-extras' },
			{ partKey: 'upright', partNumber: 'TRN-UPR-002', description: 'Upright, 6 x 40 x 50', quantity: 1, source: 'glb-extras' },
			{ partKey: 'spacer', partNumber: 'TRN-SPC-003', description: 'Spacer, 12 mm diameter x 12', quantity: 2, source: 'glb-extras' },
			{ partKey: 'bolt', partNumber: 'TRN-BLT-004', description: 'Bolt, 5 mm diameter x 20', quantity: 4, source: 'glb-extras' },
		])
		// The file draws one bolt and declares four. The BOM repeats the declaration; it does not count meshes.
		expect(sampleAssembly().parts.filter((part) => part.key === 'bolt')).toHaveLength(1)
	})

	it('never invents a row: not for the unnamed mesh, not for groups, not for malformed metadata', () => {
		const odd = extractCadAssembly(glbWith((gltf) => {
			gltf.nodes[1].extras.bom = { partNumber: 'OK-1', quantity: 0 }
			gltf.nodes[2].extras.bom = { partNumber: 'OK-2', quantity: 1.5 }
			gltf.nodes[4].extras.bom = { partNumber: '', quantity: 2 }
			gltf.nodes[5].extras.bom = { partNumber: 'OK-5', quantity: '4' }
			gltf.nodes[6].extras = { bom: { partNumber: 'ANON-1', quantity: 3 } }
			gltf.nodes[3].extras = { bom: { partNumber: 'GROUP-1', quantity: 1 } }
		}))!
		expect(odd.bom.map((row) => row.partKey)).toEqual(['node-3'])
		expect(odd.bom.find((row) => row.partKey === 'node-6')).toBeUndefined()
	})

	it('treats an identity the file reuses as no identity at all', () => {
		const clash = extractCadAssembly(glbWith((gltf) => { gltf.nodes[2].extras.partId = 'base-plate' }))!
		const keys = clash.parts.filter((part) => part.name === 'Base plate' || part.name === 'Upright').map((part) => [part.key, part.stable])
		expect(keys).toEqual([['node-1', false], ['node-2', false]])
		expect(cadModelSchema.safeParse({ ...assemblyModel(), revisions: [{ ...assemblyModel().revisions[0], assembly: clash }] }).success).toBe(true)
		const bad = extractCadAssembly(glbWith((gltf) => { gltf.nodes[1].extras.partId = 'node-4' }))!
		expect(bad.parts.find((part) => part.name === 'Base plate')).toMatchObject({ key: 'node-1', stable: false })
	})

	it('describes a single-part model as a plain model, with no assembly', () => {
		expect(extractCadAssembly(Buffer.from(buildSampleGlb()))).toBeUndefined()
		expect(extractCadAssembly(Buffer.from('not a glb at all, but long enough to read a header from'))).toBeUndefined()
	})

	it('leaves out groups that hold no mesh, ignores cycles, and refuses to list more parts than the limit', () => {
		const lonely = extractCadAssembly(glbWith((gltf) => { gltf.nodes.push({ name: 'Empty group', children: [] }); gltf.scenes[0].nodes.push(gltf.nodes.length - 1) }))!
		expect(lonely.parts.some((part) => part.name === 'Empty group')).toBe(false)
		const loop = extractCadAssembly(glbWith((gltf) => { gltf.nodes[5].children = [0] }))!
		expect(loop.parts).toHaveLength(7)
		const huge = extractCadAssembly(glbWith((gltf) => { for (let i = 0; i < 600; i++) { gltf.nodes.push({ name: `Part ${i}`, mesh: 0 }); gltf.nodes[0].children.push(gltf.nodes.length - 1) } }))
		expect(huge).toBeUndefined()
	})
})

describe('assembly extraction edge cases found in review', () => {
	it('describes nothing, instead of a tree and BOM with a hole in them, when a branch is nested too deep', () => {
		const chain = (levels: number) => glbWith((gltf) => {
			let parent = 0
			for (let i = 0; i < levels; i++) { gltf.nodes.push({ name: `Level ${i}`, children: [], ...(i === levels - 1 ? { mesh: 0, extras: { partId: 'deep', bom: { partNumber: 'DEEP-1', quantity: 1 } } } : {}) }); const index = gltf.nodes.length - 1; gltf.nodes[parent].children.push(index); parent = index }
		})
		const shallow = extractCadAssembly(chain(20))!
		expect(shallow.parts.some((part) => part.key === 'deep')).toBe(true)
		expect(shallow.bom.some((row) => row.partKey === 'deep')).toBe(true)
		expect(extractCadAssembly(chain(40))).toBeUndefined()
	})

	it('keeps a named node that declares a part number even when it draws nothing, and drops an unnamed one', () => {
		const assembly = extractCadAssembly(glbWith((gltf) => {
			gltf.nodes.push({ name: 'Purchased gasket', extras: { partId: 'gasket', bom: { partNumber: 'GSK-9', quantity: 3 } } })
			gltf.nodes[0].children.push(gltf.nodes.length - 1)
			gltf.nodes.push({ extras: { bom: { partNumber: 'ANON-9', quantity: 9 } } })
			gltf.nodes[0].children.push(gltf.nodes.length - 1)
			gltf.nodes.push({ name: 'Plain empty group', children: [] })
			gltf.nodes[0].children.push(gltf.nodes.length - 1)
		}))!
		expect(assembly.parts.find((part) => part.key === 'gasket')).toMatchObject({ name: 'Purchased gasket', mesh: false, stable: true })
		expect(assembly.bom.find((row) => row.partKey === 'gasket')).toMatchObject({ partNumber: 'GSK-9', quantity: 3 })
		expect(assembly.bom.some((row) => row.partNumber === 'ANON-9')).toBe(false)
		expect(assembly.parts.some((part) => part.name === 'Plain empty group')).toBe(false)
		expect(assembly.parts.some((part) => /Unnamed/.test(part.name) && !part.mesh)).toBe(false)
	})

	it('lists a node reachable from two groups once, under the first group that reaches it', () => {
		const assembly = extractCadAssembly(glbWith((gltf) => { gltf.nodes.push({ name: 'Second group', children: [1] }); gltf.nodes[0].children.push(gltf.nodes.length - 1) }))!
		expect(assembly.parts.filter((part) => part.name === 'Base plate')).toHaveLength(1)
		expect(assembly.parts.some((part) => part.name === 'Second group')).toBe(false)
		expect(cadModelSchema.safeParse({ ...assemblyModel(), revisions: [{ ...assemblyModel().revisions[0], assembly }] }).success).toBe(true)
	})

	it('refuses cleanly, and loses nothing, once a large assembly fills the record: about two revisions of 500 parts fit', () => {
		const big = extractCadAssembly(glbWith((gltf) => {
			gltf.nodes = [{ name: 'Big assembly', children: [] }]
			for (let i = 0; i < 499; i++) {
				gltf.nodes.push({ name: `Part number ${String(i).padStart(3, '0')} long descriptive name`, mesh: 0, extras: { partId: `part-${String(i).padStart(4, '0')}`, bom: { partNumber: `PN-${String(i).padStart(6, '0')}-REV-A`, description: 'A reasonably long description of this part for the BOM', quantity: 12 } } })
				gltf.nodes[0].children.push(gltf.nodes.length - 1)
			}
		}))!
		expect(big.parts).toHaveLength(500)
		const revision = (id: string, letter: string) => ({ id, files: glbFile(letter), assembly: big, changeNote: '' })
		let model = createCadModel({ id: 'cad_model:0123456789ab', modelId: 'BIG', name: 'Big', units: 'mm', revision: revision('rev-aaaaaa', 'a') }, person, 1)
		model = appendCadRevision(model, revision('rev-bbbbbb', 'b'), person, 2)
		const before = JSON.stringify(model)
		expect(refusal(() => appendCadRevision(model, revision('rev-cccccc', 'c'), person, 3)).message).toMatch(/size limit/)
		expect(JSON.stringify(model)).toBe(before)
	})
})

describe('assembly records and component links', () => {
	it('stores the assembly on the revision and keeps a revision without one unchanged', () => {
		const model = assemblyModel()
		expect(cadModelSchema.safeParse(model).success).toBe(true)
		expect(model.revisions[0].assembly?.bom).toHaveLength(4)
		const plain = componentModel()
		expect(plain.revisions[0].assembly).toBeUndefined()
		expect(plain.revisions[0].links).toBeUndefined()
	})

	it('links a part to one exact component revision without changing either model\'s review state', () => {
		const assembly = assemblyModel()
		const component = componentModel()
		const linked = addCadComponentLink(assembly, 'rev-aaaaaa', { partKey: 'bolt', modelRecordId: component.id, revisionId: 'rev-cccccc' }, lookupOf(assembly, component), person, 2_000)
		expect(linked.revisions[0].links).toEqual([{ partKey: 'bolt', modelRecordId: component.id, revisionId: 'rev-cccccc', addedBy: person, addedAt: 2_000 }])
		expect(linked.revisions[0].status).toBe('draft')
		expect(component.revisions[0].status).toBe('draft')
		// Even an approved component is only referenced: nothing about the assembly's own status follows from it.
		const approvedComponent = transitionCadRevision(transitionCadRevision(component, 'rev-cccccc', 'in-review', person, '', 3), 'rev-cccccc', 'approved', reviewer, '', 4)
		const again = addCadComponentLink(assembly, 'rev-aaaaaa', { partKey: 'bolt', modelRecordId: component.id, revisionId: 'rev-cccccc' }, lookupOf(assembly, approvedComponent), person, 5)
		expect(again.revisions[0].status).toBe('draft')
		expect(again.revisions[0].decision).toBeUndefined()
	})

	it('re-links a part instead of stacking links, and can remove one', () => {
		const assembly = assemblyModel()
		const first = componentModel()
		const second = componentModel('cad_model:aaaaaaaaaaaa')
		const lookup = lookupOf(assembly, first, second)
		let model = addCadComponentLink(assembly, 'rev-aaaaaa', { partKey: 'bolt', modelRecordId: first.id, revisionId: 'rev-cccccc' }, lookup, person, 2)
		model = addCadComponentLink(model, 'rev-aaaaaa', { partKey: 'bolt', modelRecordId: second.id, revisionId: 'rev-cccccc' }, lookup, person, 3)
		expect(model.revisions[0].links).toHaveLength(1)
		expect(model.revisions[0].links![0].modelRecordId).toBe(second.id)
		model = removeCadComponentLink(model, 'rev-aaaaaa', 'bolt', person, 4)
		expect(model.revisions[0].links).toBeUndefined()
		expect(refusal(() => removeCadComponentLink(model, 'rev-aaaaaa', 'bolt', person, 5)).statusCode).toBe(404)
	})

	it('refuses links that point nowhere, at itself, at an unnamed part, or at a part that does not exist', () => {
		const assembly = assemblyModel()
		const component = componentModel()
		const lookup = lookupOf(assembly, component)
		const link = (input: { partKey: string; modelRecordId: string; revisionId: string }) => addCadComponentLink(assembly, 'rev-aaaaaa', input, lookup, person, 2)
		expect(refusal(() => link({ partKey: 'bolt', modelRecordId: 'cad_model:ffffffffffff', revisionId: 'rev-cccccc' })).statusCode).toBe(404)
		expect(refusal(() => link({ partKey: 'bolt', modelRecordId: component.id, revisionId: 'rev-zzzzzz' })).statusCode).toBe(404)
		expect(refusal(() => link({ partKey: 'bolt', modelRecordId: assembly.id, revisionId: 'rev-aaaaaa' })).message).toMatch(/itself/)
		expect(refusal(() => link({ partKey: 'node-6', modelRecordId: component.id, revisionId: 'rev-cccccc' })).message).toMatch(/unnamed/)
		expect(refusal(() => link({ partKey: 'nothing', modelRecordId: component.id, revisionId: 'rev-cccccc' })).statusCode).toBe(404)
		expect(refusal(() => addCadComponentLink(component, 'rev-cccccc', { partKey: 'bolt', modelRecordId: assembly.id, revisionId: 'rev-aaaaaa' }, lookup, person, 2)).message).toMatch(/no assembly/)
	})

	it('protects approved and in-review assemblies: their links cannot change, and a new revision starts with none', () => {
		const assembly = assemblyModel()
		const component = componentModel()
		const lookup = lookupOf(assembly, component)
		const linked = addCadComponentLink(assembly, 'rev-aaaaaa', { partKey: 'bolt', modelRecordId: component.id, revisionId: 'rev-cccccc' }, lookup, person, 2)
		const inReview = transitionCadRevision(linked, 'rev-aaaaaa', 'in-review', person, '', 3)
		const approved = transitionCadRevision(inReview, 'rev-aaaaaa', 'approved', reviewer, 'ok', 4)
		for (const model of [inReview, approved]) {
			expect(refusal(() => addCadComponentLink(model, 'rev-aaaaaa', { partKey: 'upright', modelRecordId: component.id, revisionId: 'rev-cccccc' }, lookup, person, 5)).statusCode).toBe(409)
			expect(refusal(() => removeCadComponentLink(model, 'rev-aaaaaa', 'bolt', person, 5)).statusCode).toBe(409)
		}
		const next = appendCadRevision(approved, { id: 'rev-bbbbbb', files: glbFile('b'), assembly: sampleAssembly(), changeNote: 'v2' }, person, 6)
		expect(next.revisions[0]).toEqual(approved.revisions[0])
		expect(next.revisions[1].links).toBeUndefined()
		expect(next.revisions[1].status).toBe('draft')
	})

	it('lets only a person link, never an AI client', () => {
		const assembly = assemblyModel()
		const component = componentModel()
		expect(refusal(() => addCadComponentLink(assembly, 'rev-aaaaaa', { partKey: 'bolt', modelRecordId: component.id, revisionId: 'rev-cccccc' }, lookupOf(assembly, component), agent, 2)).statusCode).toBe(403)
		const linked = addCadComponentLink(assembly, 'rev-aaaaaa', { partKey: 'bolt', modelRecordId: component.id, revisionId: 'rev-cccccc' }, lookupOf(assembly, component), person, 2)
		expect(refusal(() => removeCadComponentLink(linked, 'rev-aaaaaa', 'bolt', agent, 3)).statusCode).toBe(403)
	})

	it('rejects malformed assembly records: a BOM row for an unnamed part, duplicate keys, a link to itself', () => {
		const model = assemblyModel()
		const assembly = model.revisions[0].assembly as CadAssembly
		const parse = (patch: Record<string, unknown>) => cadModelSchema.safeParse({ ...model, revisions: [{ ...model.revisions[0], ...patch }] }).success
		expect(parse({})).toBe(true)
		expect(parse({ assembly: { ...assembly, bom: [...assembly.bom, { partKey: 'node-6', partNumber: 'X', quantity: 1, source: 'glb-extras' }] } })).toBe(false)
		expect(parse({ assembly: { ...assembly, bom: [{ ...assembly.bom[0], quantity: 0 }] } })).toBe(false)
		expect(parse({ assembly: { ...assembly, bom: [...assembly.bom, assembly.bom[0]] } })).toBe(false)
		expect(parse({ assembly: { ...assembly, parts: [...assembly.parts, assembly.parts[1]] } })).toBe(false)
		expect(parse({ links: [{ partKey: 'bolt', modelRecordId: model.id, revisionId: 'rev-aaaaaa', addedBy: person, addedAt: 1 }] })).toBe(false)
		expect(parse({ assembly: undefined, links: [{ partKey: 'bolt', modelRecordId: 'cad_model:ba9876543210', revisionId: 'rev-cccccc', addedBy: person, addedAt: 1 }] })).toBe(false)
		expect(parse({ links: [{ partKey: 'ghost', modelRecordId: 'cad_model:ba9876543210', revisionId: 'rev-cccccc', addedBy: person, addedAt: 1 }] })).toBe(false)
	})
})

describe('review-only part controls', () => {
	async function loaded(groups?: readonly string[] | 'none') {
		const bytes = buildSampleAssemblyGlb()
		const { scene, nodeObjects } = await parseCadAssembly(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
		const assembly = sampleAssembly()
		return { scene, view: new AssemblyView(scene, assembly.parts, nodeObjects, groups === 'none' ? [] : groups ?? assembly.explode), assembly }
	}
	const worldCentre = (object: THREE.Object3D) => new THREE.Box3().setFromObject(object).getCenter(new THREE.Vector3())

	it('finds every listed part in the loaded scene', async () => {
		const { view, assembly } = await loaded()
		expect(view.matched).toBe(assembly.parts.length)
	})

	it('selects a part and highlights only its meshes, then puts the original materials back', async () => {
		const { view } = await loaded()
		const mesh = view.objects.get('spacer') as THREE.Mesh
		const other = view.objects.get('bolt') as THREE.Mesh
		const originalMaterial = mesh.material
		view.select('spacer')
		expect(view.selectedKey).toBe('spacer')
		expect(mesh.material).not.toBe(originalMaterial)
		expect((mesh.material as THREE.MeshStandardMaterial).emissive.getHex()).toBe(0xffb020)
		expect((other.material as THREE.MeshStandardMaterial).emissive.getHex()).not.toBe(0xffb020)
		view.select('bolt')
		expect(mesh.material).toBe(originalMaterial)
		view.select(null)
		expect(view.selectedKey).toBeNull()
		expect((other.material as THREE.MeshStandardMaterial).emissive.getHex()).not.toBe(0xffb020)
		view.select('no-such-part')
		expect(view.selectedKey).toBeNull()
	})

	it('maps a clicked mesh to its own part, and a group member to the group when asked about the group', async () => {
		const { view } = await loaded()
		expect(view.partOf(view.objects.get('bolt') ?? null)).toBe('bolt')
		expect(view.partOf(new THREE.Object3D())).toBeNull()
		const nested = new THREE.Mesh(); view.objects.get('bolt')!.add(nested)
		expect(view.partOf(nested)).toBe('bolt')
	})

	it('hides and shows parts, isolates one together with the groups above it, and resets completely', async () => {
		const { view, assembly } = await loaded()
		view.applyHidden(new Set(['upright']))
		expect(view.objects.get('upright')!.visible).toBe(false)
		expect(view.objects.get('base-plate')!.visible).toBe(true)
		const hidden = view.isolate('bolt')
		expect([...hidden].sort()).toEqual(['base-plate', 'node-6', 'spacer', 'upright'].sort())
		view.applyHidden(hidden)
		for (const part of assembly.parts) expect(view.objects.get(part.key)!.visible, part.key).toBe(!hidden.has(part.key))
		// The group above the isolated bolt stays visible, so the bolt can still be drawn.
		expect(isShown(view.objects.get('bolt')!)).toBe(true)
		expect(isShown(view.objects.get('spacer')!)).toBe(false)
		view.select('bolt'); view.explode(0.5)
		view.reset()
		for (const part of assembly.parts) expect(view.objects.get(part.key)!.visible).toBe(true)
		expect(view.selectedKey).toBeNull()
		expect(view.isOriginal()).toBe(true)
	})

	const matrices = (scene: THREE.Object3D) => { const all: number[][] = []; scene.traverse((o) => all.push(o.matrix.toArray())); return all }
	const load = async (bytes: Buffer) => { const assembly = extractCadAssembly(bytes)!; const { scene, nodeObjects } = await parseCadAssembly(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer); return { assembly, scene, view: new AssemblyView(scene, assembly.parts, nodeObjects, assembly.explode) } }

	it('moves each verified component group away from the middle, and keeps what is inside a group together', async () => {
		const { scene, view, assembly } = await loaded()
		expect(assembly.explode).toEqual(['base-plate', 'upright', 'node-3', 'node-6'])
		scene.updateMatrixWorld(true)
		const middle = new THREE.Box3().setFromObject(scene).getCenter(new THREE.Vector3())
		const start = new Map(assembly.explode!.map((key) => [key, worldCentre(view.objects.get(key)!).clone()]))
		const spacerToBolt = worldCentre(view.objects.get('spacer')!).sub(worldCentre(view.objects.get('bolt')!))
		const localBefore = [view.objects.get('spacer')!.matrix.toArray(), view.objects.get('bolt')!.matrix.toArray()]
		view.explode(1)
		expect(view.isOriginal()).toBe(false)
		expect(view.explosionFactor).toBe(1)
		// the layout leaves exactly one group in place (the one nearest the middle); every other group ends farther out than it began
		let unmoved = 0
		for (const [key, was] of start) {
			const now = worldCentre(view.objects.get(key)!).distanceTo(middle)
			if (Math.abs(now - was.distanceTo(middle)) < 1e-6) unmoved++
			else expect(now, key).toBeGreaterThan(was.distanceTo(middle))
		}
		expect(unmoved).toBe(1)
		// the Fasteners group moved, yet the spacer and the bolt inside it did not move relative to each other, nor locally
		expect(worldCentre(view.objects.get('node-3')!).distanceTo(start.get('node-3')!)).toBeGreaterThan(1)
		expect(worldCentre(view.objects.get('spacer')!).sub(worldCentre(view.objects.get('bolt')!)).toArray()).toEqual(spacerToBolt.toArray())
		expect([view.objects.get('spacer')!.matrix.toArray(), view.objects.get('bolt')!.matrix.toArray()]).toEqual(localBefore)
		// groups finish one after another, so at half way none has gone further than at full and the whole is part way there
		const travelled = () => assembly.explode!.map((key) => worldCentre(view.objects.get(key)!).distanceTo(start.get(key)!))
		const full = travelled()
		view.explode(0.5)
		const half = travelled()
		for (let i = 0; i < full.length; i++) expect(half[i]).toBeLessThanOrEqual(full[i] + 1e-9)
		expect(half.reduce((p, q) => p + q, 0)).toBeLessThan(full.reduce((p, q) => p + q, 0))
	})

	it('returns to exactly the original matrices at zero, after many round trips, and after reset', async () => {
		const { scene, view, assembly } = await loaded()
		const original = matrices(scene)
		for (const factor of [0.3, 1, 0.1, 0.77, 1]) view.explode(factor)
		view.explode(0)
		expect(view.isOriginal()).toBe(true)
		expect(matrices(scene)).toEqual(original)
		view.explode(0.9); view.restore()
		expect(matrices(scene)).toEqual(original)
		expect(view.explosionFactor).toBe(0)
		view.select('bolt'); view.applyHidden(new Set(['upright'])); view.explode(1)
		view.reset()
		expect(matrices(scene)).toEqual(original)
		for (const part of assembly.parts) expect(view.objects.get(part.key)!.visible).toBe(true)
		expect(view.selectedKey).toBeNull()
	})

	it('keeps hide, show, isolate and selection correct while exploded', async () => {
		const { scene, view } = await loaded()
		view.explode(1)
		const exploded = matrices(scene)
		view.applyHidden(new Set(['upright']))
		expect(view.objects.get('upright')!.visible).toBe(false)
		expect(matrices(scene)).toEqual(exploded)
		const hidden = view.isolate('bolt')
		expect([...hidden].sort()).toEqual(['base-plate', 'node-6', 'spacer', 'upright'].sort())
		view.applyHidden(hidden)
		expect(isShown(view.objects.get('bolt')!)).toBe(true)
		expect(isShown(view.objects.get('spacer')!)).toBe(false)
		view.select('bolt')
		expect(((view.objects.get('bolt') as THREE.Mesh).material as THREE.MeshStandardMaterial).emissive.getHex()).toBe(0xffb020)
		const nested = new THREE.Mesh(); view.objects.get('bolt')!.add(nested)
		expect(view.partOf(nested)).toBe('bolt')
		expect(view.partOf(view.objects.get('spacer')!)).toBe('spacer')
	})

	it('treats a marked node inside a marked group as part of that group, so a nested assembly moves as one', async () => {
		const { scene, view, assembly } = await load(glbWith((doc) => { doc.nodes[4].extras = { ...doc.nodes[4].extras, explodeGroup: true } }))
		expect(assembly.explode).toEqual(['base-plate', 'upright', 'node-3', 'node-6'])
		scene.updateMatrixWorld(true)
		const gap = worldCentre(view.objects.get('spacer')!).sub(worldCentre(view.objects.get('bolt')!)).toArray()
		view.explode(1)
		expect(worldCentre(view.objects.get('spacer')!).sub(worldCentre(view.objects.get('bolt')!)).toArray()).toEqual(gap)
	})

	it('moves repeated instances independently when each is its own group', async () => {
		const { scene, view, assembly } = await load(glbWith((doc) => {
			delete doc.nodes[3].extras
			doc.nodes[4].extras = { ...doc.nodes[4].extras, explodeGroup: true }
			doc.nodes[5].extras = { ...doc.nodes[5].extras, explodeGroup: true }
			doc.nodes.push({ name: 'Bolt (second instance)', mesh: doc.nodes[5].mesh, translation: [-15, 16, 6], extras: { explodeGroup: true } })
			doc.nodes[0].children.push(doc.nodes.length - 1)
		}))
		expect(assembly.explode).toHaveLength(6)
		expect(view.canExplode).toBe(true)
		scene.updateMatrixWorld(true)
		const first = worldCentre(view.objects.get('bolt')!).clone(), second = worldCentre(view.objects.get('node-7')!).clone()
		view.explode(1)
		const moved = [worldCentre(view.objects.get('bolt')!).sub(first), worldCentre(view.objects.get('node-7')!).sub(second)]
		// the layout leaves one group in place, so at least one of the two instances moves, and each has its own offset
		expect(Math.max(moved[0].length(), moved[1].length())).toBeGreaterThan(1)
		expect(moved[0].toArray()).not.toEqual(moved[1].toArray())
	})

	it('does not explode at all when the model has no verified grouping', async () => {
		const cases: Array<readonly string[] | 'none'> = ['none', ['base-plate', 'upright'], ['base-plate', 'upright', 'node-3', 'node-6', 'bolt'], ['base-plate', 'base-plate', 'upright', 'node-3', 'node-6'], ['base-plate', 'no-such-part']]
		for (const groups of cases) {
			const { scene, view } = await loaded(groups)
			const original = matrices(scene)
			expect(view.canExplode, JSON.stringify(groups)).toBe(false)
			view.explode(1)
			expect(view.isOriginal()).toBe(true)
			expect(view.explosionFactor).toBe(0)
			expect(matrices(scene)).toEqual(original)
		}
	})

	it('records no grouping from a file that is partly grouped, ungrouped, or marked with the wrong kind of value', () => {
		const flags = (edit: (nodes: any[]) => void) => extractCadAssembly(glbWith((doc) => edit(doc.nodes)))!
		expect(flags((nodes) => { for (const node of nodes) delete node.extras?.explodeGroup }).explode).toBeUndefined()
		expect(flags((nodes) => { delete nodes[6].extras.explodeGroup }).explode).toBeUndefined() // a mesh outside every group
		expect(flags((nodes) => { for (const i of [1, 2, 3]) delete nodes[i].extras.explodeGroup }).explode).toBeUndefined() // only one group is left
		for (const wrong of ['true', 1, { a: 1 }, [true], null]) expect(flags((nodes) => { nodes[6].extras.explodeGroup = wrong }).explode, JSON.stringify(wrong)).toBeUndefined()
		// a marked node that holds no geometry (a declared purchased part) is a group with nothing to move
		expect(flags((nodes) => { nodes.push({ name: 'Purchased part', extras: { explodeGroup: true, bom: { partNumber: 'X-1', quantity: 1 } } }); nodes[0].children.push(nodes.length - 1) }).explode).toBeUndefined()
	})

	it('stays safe when the file has a node cycle or very deep nesting alongside grouping marks', () => {
		const loop = extractCadAssembly(glbWith((doc) => { doc.nodes[5].children = [0] }))!
		expect(loop.explode).toEqual(['base-plate', 'upright', 'node-3', 'node-6'])
		const deep = extractCadAssembly(glbWith((doc) => { let parent = 0; for (let i = 0; i < 40; i++) { doc.nodes.push({ name: `L${i}`, extras: { explodeGroup: true } }); (doc.nodes[parent].children ??= []).push(doc.nodes.length - 1); parent = doc.nodes.length - 1 } }))
		expect(deep).toBeUndefined()
	})

	it('never hands the viewer a cyclic scene: a file with a node cycle fails to load, so the exploded view never runs on it', async () => {
		const bytes = glbWith((doc) => { doc.nodes[5].children = [0] })
		const outcome = await Promise.race([
			parseCadAssembly(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer).then(({ scene }) => {
				// If a loader ever accepts it, the result must at least be a finite tree the viewer can traverse.
				let visited = 0
				scene.traverse(() => { visited++ })
				return visited < 1_000 ? 'finite' : 'unbounded'
			}, () => 'rejected'),
			new Promise<string>((resolve) => setTimeout(() => resolve('hung'), 5_000)),
		])
		expect(['rejected', 'finite']).toContain(outcome)
	})

	it('rejects stored grouping that is inconsistent, so a bad record is never accepted', () => {
		const model = assemblyModel()
		const assembly = model.revisions[0].assembly!
		const accepts = (explode: string[] | undefined) => cadModelSchema.safeParse({ ...model, revisions: [{ ...model.revisions[0], assembly: { ...assembly, explode } }] }).success
		expect(accepts(['base-plate', 'upright', 'node-3', 'node-6'])).toBe(true)
		expect(accepts(undefined)).toBe(true)
		expect(accepts(['base-plate'])).toBe(false)
		expect(accepts(['base-plate', 'upright'])).toBe(false)
		expect(accepts(['base-plate', 'upright', 'node-3', 'node-6', 'spacer'])).toBe(false)
		expect(accepts(['base-plate', 'base-plate', 'upright', 'node-3', 'node-6'])).toBe(false)
		expect(accepts(['base-plate', 'ghost', 'upright', 'node-3', 'node-6'])).toBe(false)
	})

	it('moves nothing in the stored data: the explosion lives in the scene only', async () => {
		const model = assemblyModel()
		const snapshot = JSON.stringify(model)
		const { view } = await loaded()
		view.select('spacer'); view.applyHidden(new Set(['bolt'])); view.explode(1)
		expect(view.explosionFactor).toBe(1)
		expect(JSON.stringify(model)).toBe(snapshot)
		view.dispose()
	})
})
