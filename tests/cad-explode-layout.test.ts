import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { AssemblyView, isShown } from '../client/cad/assembly-view'
import { fitCamera, fitCameraKeepingView, frameOf, frameOfBox, parseCadAssembly } from '../client/cad/cad-scene'
import { groupProgress, LAYOUT_CAP, LAYOUT_GAP, planExplosion, planMatches, type LayoutGroup, type LayoutPlan } from '../client/cad/explode-layout'
import { EXPLODE_PLANS, OTTO_DIY_LAYOUT } from '../client/cad/explode-plans'
import { extractCadAssembly } from '../server/cad-assembly'
import type { CadAssemblyPart } from '../shared/cad-model'
import { haveOtto, OTTO_GLB, OTTO_SHA256, ottoGroups } from './fixtures/otto-grouped'

/**
 * The review-only exploded layout. Every check is about what is drawn: the layout is never evidence of fit, clearance or how the
 * parts come apart, and nothing stored changes. The Otto numbers are the 15 group boxes measured from the grouped Otto DIY GLB
 * (SHA-256 8994be40...), so the plan is exercised on CI too; the same file is loaded for real where it exists on this machine.
 */

const union = (boxes: THREE.Box3[]) => boxes.reduce((all, box) => all.union(box), new THREE.Box3())
const separation = (a: THREE.Box3, b: THREE.Box3) => Math.max(a.min.x - b.max.x, b.min.x - a.max.x, a.min.y - b.max.y, b.min.y - a.max.y, a.min.z - b.max.z, b.min.z - a.max.z)
const overlapVolume = (a: THREE.Box3, b: THREE.Box3) => { const common = a.clone().intersect(b); return common.isEmpty() ? 0 : common.getSize(new THREE.Vector3()).toArray().reduce((p, q) => p * q, 1) }
const at = (groups: LayoutGroup[], layout: ReturnType<typeof planExplosion>, factor: number) => groups.map((g) => g.box.clone().translate(layout.offsets.get(g.key)!.clone().multiplyScalar(groupProgress(layout, g.key, factor))))
const totalOverlap = (boxes: THREE.Box3[]) => { let sum = 0; for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) sum += overlapVolume(boxes[i], boxes[j]); return sum }
const shuffled = <T,>(items: T[], seed: number) => { const out = [...items]; let state = seed; for (let i = out.length - 1; i > 0; i--) { state = (state * 1103515245 + 12345) & 0x7fffffff; const j = state % (i + 1); [out[i], out[j]] = [out[j], out[i]] } return out }

describe('the recorded Otto layout', () => {
	it('applies only to these exact 15 groups at the positions it was measured at', () => {
		const groups = ottoGroups()
		const assembly = union(groups.map((g) => g.box))
		expect(planMatches(OTTO_DIY_LAYOUT, groups, assembly)).toBe(true)
		expect(planExplosion(groups, EXPLODE_PLANS).source).toBe('planned')
		// a renamed group, a missing group, a duplicated name, or one that sits somewhere else: automatic layout, never a misapplied plan
		const renamed = ottoGroups(); renamed[0].name = 'Torso'
		const missing = ottoGroups().slice(1)
		const duplicated = ottoGroups(); duplicated[1].name = duplicated[0].name
		const moved = ottoGroups(); moved[1].box.translate(new THREE.Vector3(0, 12, 0))
		for (const changed of [renamed, missing, duplicated, moved]) expect(planExplosion(changed, EXPLODE_PLANS).source, 'automatic').toBe('automatic')
	})

	it('separates every group from every other at full extension, keeping the gap', () => {
		const groups = ottoGroups()
		const layout = planExplosion(groups, EXPLODE_PLANS)
		expect(layout.unresolved).toEqual([])
		const diagonal = union(groups.map((g) => g.box)).getSize(new THREE.Vector3()).length()
		const final = at(groups, layout, 1)
		for (let i = 0; i < final.length; i++) for (let j = i + 1; j < final.length; j++) expect(separation(final[i], final[j]), `${groups[i].name} / ${groups[j].name}`).toBeGreaterThanOrEqual(LAYOUT_GAP * diagonal - 1e-6)
		// the assembled file overlaps heavily (parts sit inside others), so this is a real change, not a property of the file
		expect(totalOverlap(groups.map((g) => g.box))).toBeGreaterThan(100_000)
		expect(totalOverlap(final)).toBe(0)
	})

	it('moves each group along its own line, the groups it is meant to leave in place stay, and distances are bounded and useful', () => {
		const groups = ottoGroups()
		const layout = planExplosion(groups, EXPLODE_PLANS)
		const diagonal = union(groups.map((g) => g.box)).getSize(new THREE.Vector3()).length()
		for (const hint of OTTO_DIY_LAYOUT.groups) {
			const offset = layout.offsets.get(`k-${hint.name}`)!
			if (hint.direction.every((v) => v === 0)) { expect(offset.length(), hint.name).toBe(0); continue }
			expect(offset.length(), `${hint.name} travels at least one gap`).toBeGreaterThanOrEqual(LAYOUT_GAP * diagonal - 1e-6)
			expect(offset.length(), `${hint.name} stays within the cap`).toBeLessThanOrEqual(LAYOUT_CAP * diagonal + 1e-6)
			expect(offset.clone().normalize().dot(new THREE.Vector3(...hint.direction).normalize()), `${hint.name} follows its own line`).toBeCloseTo(1, 6)
		}
		// the old layout moved the Body 6 mm and the Head 25 mm, with servo groups on almost the same lines; now the paths differ
		const final = union(at(groups, layout, 1)).getSize(new THREE.Vector3())
		const start = union(groups.map((g) => g.box)).getSize(new THREE.Vector3())
		expect(final.y).toBeGreaterThan(start.y * 1.5)
		expect(final.length()).toBeLessThan(start.length() * 3)
		const sg90 = layout.offsets.get('k-Servo_SG90 v4')!.clone().normalize(), mg90s = layout.offsets.get('k-Servo_MG90S v2')!.clone().normalize()
		expect(sg90.dot(mg90s)).toBeLessThan(0.5)
	})

	it('gives the same layout whatever order the groups are listed in', () => {
		const reference = planExplosion(ottoGroups(), EXPLODE_PLANS)
		for (const seed of [1, 7, 99]) {
			const layout = planExplosion(shuffled(ottoGroups(), seed), EXPLODE_PLANS)
			expect(layout.order).toEqual(reference.order)
			for (const [key, offset] of reference.offsets) expect(layout.offsets.get(key)!.toArray()).toEqual(offset.toArray())
		}
	})

	it('reads more cleanly at 25, 50 and 75 percent than as the file arranged it, and never gets worse as the slider rises', () => {
		const groups = ottoGroups()
		const layout = planExplosion(groups, EXPLODE_PLANS)
		const assembled = totalOverlap(groups.map((g) => g.box))
		for (const factor of [0.25, 0.5, 0.75]) expect(totalOverlap(at(groups, layout, factor)), `at ${factor}`).toBeLessThan(assembled)
		let previous = Infinity
		for (let step = 0; step <= 400; step++) {
			const now = totalOverlap(at(groups, layout, step / 400))
			expect(now, `step ${step}`).toBeLessThanOrEqual(previous + 1e-6)
			previous = now
		}
		expect(previous).toBe(0)
	})
})

describe('groupProgress', () => {
	it('is exactly 0 at 0 and exactly 1 at 1 for every group, never decreases, and starts the outermost group first', () => {
		const layout = planExplosion(ottoGroups(), EXPLODE_PLANS)
		const movers = layout.order.filter((key) => layout.offsets.get(key)!.lengthSq() > 0)
		for (const key of layout.order) {
			const moves = layout.offsets.get(key)!.lengthSq() > 0
			expect(groupProgress(layout, key, 0)).toBe(0)
			expect(groupProgress(layout, key, 1)).toBe(moves ? 1 : 0)
			let last = 0
			for (let i = 0; i <= 100; i++) { const p = groupProgress(layout, key, i / 100); expect(p).toBeGreaterThanOrEqual(last); last = p }
		}
		expect(groupProgress(layout, movers[movers.length - 1], 0.05)).toBeGreaterThan(groupProgress(layout, movers[0], 0.05))
		expect(groupProgress(layout, 'not-a-group', 0.5)).toBe(0)
		expect(groupProgress(layout, movers[0], -3)).toBe(0)
		expect(groupProgress(layout, movers[0], 9)).toBe(1)
	})
})

describe('the automatic layout for any other file', () => {
	const synthetic = (): LayoutGroup[] => [
		['A', [-30, -30, -30], [30, 30, 30]],
		['B', [-10, -10, -10], [10, 10, 10]],
		['C', [20, -5, -5], [45, 5, 5]],
		['D', [-5, 25, -5], [5, 50, 5]],
		['E', [-5, -50, -5], [5, -25, 5]],
	].map(([name, min, max]) => ({ key: String(name), name: String(name), box: new THREE.Box3(new THREE.Vector3(...(min as number[])), new THREE.Vector3(...(max as number[]))) }))

	it('leaves the group nearest the middle in place and clears every other group of every box, deterministically', () => {
		const groups = synthetic()
		const layout = planExplosion(groups)
		expect(layout.source).toBe('automatic')
		expect(layout.unresolved).toEqual([])
		const unmoved = [...layout.offsets].filter(([, offset]) => offset.lengthSq() === 0)
		expect(unmoved).toHaveLength(1)
		const final = at(groups, layout, 1)
		const diagonal = union(groups.map((g) => g.box)).getSize(new THREE.Vector3()).length()
		for (let i = 0; i < final.length; i++) for (let j = i + 1; j < final.length; j++) expect(separation(final[i], final[j])).toBeGreaterThanOrEqual(LAYOUT_GAP * diagonal - 1e-6)
		const again = planExplosion(shuffled(groups, 5))
		for (const [key, offset] of layout.offsets) expect(again.offsets.get(key)!.toArray()).toEqual(offset.toArray())
	})

	it('says so, and draws the group at its cap, when nothing within reach clears it', () => {
		// B must cross the whole of A (a very long box) and cannot do so within the cap
		const a = new THREE.Box3(new THREE.Vector3(-100, -10, -10), new THREE.Vector3(2000, 10, 10))
		const b = new THREE.Box3(new THREE.Vector3(-140, -10, -10), new THREE.Vector3(-120, 10, 10))
		const plan: LayoutPlan = { id: 'test', size: [2140, 20, 20], groups: [{ name: 'A', direction: [0, 0, 0], centre: [0, 0, 0] }, { name: 'B', direction: [1, 0, 0], centre: [0, 0, 0] }] }
		const groups: LayoutGroup[] = [{ key: 'a', name: 'A', box: a }, { key: 'b', name: 'B', box: b }]
		const middle = union([a, b]).getCenter(new THREE.Vector3())
		plan.groups = plan.groups.map((hint, index) => ({ ...hint, centre: (index === 0 ? a : b).getCenter(new THREE.Vector3()).sub(middle).toArray() as [number, number, number] }))
		const layout = planExplosion(groups, [plan])
		expect(layout.source).toBe('planned')
		expect(layout.unresolved).toEqual(['b'])
		const diagonal = union([a, b]).getSize(new THREE.Vector3()).length()
		expect(layout.offsets.get('b')!.length()).toBeCloseTo(LAYOUT_CAP * diagonal, 6)
	})
})

describe('a file the layout cannot place', () => {
	it('draws nothing when the file has no boxes at all', () => {
		const layout = planExplosion([])
		expect(layout.offsets.size).toBe(0)
		expect(layout.unresolved).toEqual([])
	})

	it('keeps a group with no geometry where it is and never produces a non-finite offset', () => {
		const groups = ottoGroups()
		groups.push({ key: 'empty', name: 'Nothing', box: new THREE.Box3() })
		const layout = planExplosion(groups, EXPLODE_PLANS)
		// the empty group does not stop the recorded plan from applying to the 15 groups that have geometry
		expect(layout.source).toBe('planned')
		expect(layout.offsets.get('empty')!.toArray()).toEqual([0, 0, 0])
		for (const offset of layout.offsets.values()) expect(offset.toArray().every(Number.isFinite)).toBe(true)
		const automatic = planExplosion([...groups.slice(0, 5), { key: 'empty', name: 'Nothing', box: new THREE.Box3() }])
		for (const offset of automatic.offsets.values()) expect(offset.toArray().every(Number.isFinite)).toBe(true)
	})

	it('terminates, and places every group, when every box is a single point', () => {
		const point = (name: string, x: number): LayoutGroup => ({ key: name, name, box: new THREE.Box3(new THREE.Vector3(x, 0, 0), new THREE.Vector3(x, 0, 0)) })
		const layout = planExplosion([point('a', 0), point('b', 0), point('c', 0)])
		expect(layout.offsets.size).toBe(3)
	})
})

/** A hand-built assembly with a rotated and scaled parent, so a group moves in world space whatever its parent's own transform. */
describe('groups under a transformed parent', () => {
	it('moves by the world-space offset the layout gave, and returns to the original matrices exactly', () => {
		const root = new THREE.Group()
		const frame = new THREE.Group(); frame.name = 'frame'; frame.position.set(5, -3, 2); frame.rotation.set(0.4, -0.8, 0.3); frame.scale.set(2, 2, 2)
		root.add(frame)
		const boxMesh = (x: number) => { const mesh = new THREE.Mesh(new THREE.BoxGeometry(4, 4, 4), new THREE.MeshStandardMaterial()); mesh.position.set(x, 0, 0); return mesh }
		const groups = [0, 1, 2].map((i) => { const group = new THREE.Group(); group.name = `g${i}`; group.add(boxMesh(0)); group.position.set(i * 6, 0, 0); frame.add(group); return group })
		root.updateMatrixWorld(true)
		const parts: CadAssemblyPart[] = [
			{ key: 'frame', stable: true, node: 0, parent: null, name: 'frame', named: true, mesh: false },
			...groups.map((group, i): CadAssemblyPart => ({ key: `g${i}`, stable: true, node: i + 1, parent: 'frame', name: group.name, named: true, mesh: false })),
		]
		const view = new AssemblyView(root, parts, new Map([[0, frame], ...groups.map((group, i): [number, THREE.Object3D] => [i + 1, group])]), ['g0', 'g1', 'g2'])
		expect(view.canExplode).toBe(true)
		const matrices = () => { const all: number[][] = []; root.traverse((o) => all.push(o.matrix.toArray())); return all }
		const before = matrices()
		const worlds = groups.map((group) => new THREE.Box3().setFromObject(group).getCenter(new THREE.Vector3()))
		view.explode(1)
		const after = groups.map((group) => new THREE.Box3().setFromObject(group).getCenter(new THREE.Vector3()))
		// every group that moved did so as a rigid translation (rotation and scale untouched), by a world distance of at least the gap
		groups.forEach((group, i) => { expect(group.quaternion.toArray()).toEqual(new THREE.Quaternion().toArray()); expect(group.scale.toArray()).toEqual([1, 1, 1]); expect(after[i].distanceTo(worlds[i]) === 0 || after[i].distanceTo(worlds[i]) > 1).toBe(true) })
		expect(after.filter((p, i) => p.distanceTo(worlds[i]) > 1).length).toBe(2)
		for (let round = 0; round < 40; round++) view.explode(((round * 37) % 101) / 100)
		view.explode(0)
		expect(matrices()).toEqual(before)
		view.explode(0.6); view.reset()
		expect(matrices()).toEqual(before)
		expect(view.isOriginal()).toBe(true)
	})
})

describe.skipIf(!haveOtto)('the real grouped Otto GLB', () => {
	const read = () => readFileSync(OTTO_GLB)
	const load = async () => {
		const bytes = read()
		const assembly = extractCadAssembly(bytes)!
		const { scene, nodeObjects } = await parseCadAssembly(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
		const view = new AssemblyView(scene, assembly.parts, nodeObjects, assembly.explode)
		scene.updateMatrixWorld(true)
		return { scene, view, assembly }
	}
	const matrices = (scene: THREE.Object3D) => { const all: number[][] = []; scene.traverse((o) => all.push(o.matrix.toArray())); return all }
	const worldBox = (object: THREE.Object3D) => new THREE.Box3().setFromObject(object)

	it('is the file the plan was written for', () => {
		expect(createHash('sha256').update(read()).digest('hex')).toBe(OTTO_SHA256)
	})

	it('uses the recorded plan, with 15 verified groups and nothing left unplaced', async () => {
		const { view, assembly } = await load()
		expect(view.canExplode).toBe(true)
		expect(assembly.explode).toHaveLength(15)
		expect(view.layout).toEqual({ source: 'planned', planId: 'otto-diy-v09-grouped', unresolved: [] })
	})

	it('moves each of the 15 groups as an intact unit: nothing inside a group changes, and a group changes only in position', async () => {
		const { scene, view, assembly } = await load()
		const groups = new Set(assembly.explode!)
		const inside = (object: THREE.Object3D) => { for (let c: THREE.Object3D | null = object; c; c = c.parent) for (const [key, o] of view.objects) if (o === c && groups.has(key)) return true; return false }
		const local = new Map<THREE.Object3D, number[]>(); scene.traverse((o) => local.set(o, o.matrix.toArray()))
		const start = new Map(assembly.explode!.map((key) => [key, worldBox(view.objects.get(key)!)]))
		view.explode(1)
		scene.updateMatrixWorld(true)
		for (const key of assembly.explode!) {
			const object = view.objects.get(key)!
			expect(object.quaternion.toArray(), key).toEqual(new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().fromArray(local.get(object)!)).toArray())
			// everything below the group node has the very same local matrix as before
			object.traverse((below) => { if (below !== object) expect(below.matrix.toArray()).toEqual(local.get(below)) })
			// and the group's world box kept its size
			expect(worldBox(object).getSize(new THREE.Vector3()).toArray().map((n) => +n.toFixed(6))).toEqual(start.get(key)!.getSize(new THREE.Vector3()).toArray().map((n) => +n.toFixed(6)))
		}
		scene.traverse((o) => { if (!inside(o) && o !== scene) expect(o.matrix.toArray()).toEqual(local.get(o)) })
	})

	it('separates the groups usefully: no two group boxes touch at full, and the old pairs of near-identical servo paths now differ', async () => {
		const { scene, view, assembly } = await load()
		const keys = assembly.explode!
		const names = new Map(assembly.parts.map((p) => [p.key, p.name]))
		const before = keys.map((k) => worldBox(view.objects.get(k)!))
		view.explode(1)
		scene.updateMatrixWorld(true)
		const after = keys.map((k) => worldBox(view.objects.get(k)!))
		const diagonal = union(before).getSize(new THREE.Vector3()).length()
		let assembledOverlaps = 0
		for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) {
			if (before[i].intersectsBox(before[j])) assembledOverlaps++
			expect(separation(after[i], after[j]), `${names.get(keys[i])} / ${names.get(keys[j])}`).toBeGreaterThanOrEqual(LAYOUT_GAP * diagonal - 1e-3)
		}
		expect(assembledOverlaps).toBe(24)
		// every group other than the Body moved at least one gap, and the Head and Body no longer sit 6 and 25 mm from where they were
		const moved = keys.map((k, i) => after[i].getCenter(new THREE.Vector3()).distanceTo(before[i].getCenter(new THREE.Vector3())))
		keys.forEach((k, i) => { if (names.get(k) !== 'Body') expect(moved[i], names.get(k)).toBeGreaterThanOrEqual(LAYOUT_GAP * diagonal - 1e-3) })
		expect(moved[keys.findIndex((k) => names.get(k) === 'Head')]).toBeGreaterThan(60)
	})

	it('returns to exactly the original matrices at zero, after repeated slider changes, and after reset', async () => {
		const { scene, view } = await load()
		const original = matrices(scene)
		for (let round = 0; round < 60; round++) view.explode(((round * 53) % 101) / 100)
		expect(matrices(scene)).not.toEqual(original)
		view.explode(0)
		expect(matrices(scene)).toEqual(original)
		expect(view.isOriginal()).toBe(true)
		expect(view.explosionFactor).toBe(0)
		view.explode(0.4); view.explode(1); view.explode(0.4); view.explode(0)
		expect(matrices(scene)).toEqual(original)
		view.explode(0.8); view.reset()
		expect(matrices(scene)).toEqual(original)
		// the same factor always gives the same arrangement, wherever the slider came from
		view.explode(0.5); const direct = matrices(scene)
		view.explode(1); view.explode(0.1); view.explode(0.5)
		expect(matrices(scene)).toEqual(direct)
	})

	it('keeps selection, hide and isolate working while exploded, and frames what is shown', async () => {
		const { scene, view, assembly } = await load()
		const head = assembly.parts.find((p) => p.name === 'Head')!.key
		const feet = assembly.parts.find((p) => p.name === 'Feet')!.key
		view.explode(1)
		view.select(head)
		expect(view.selectedKey).toBe(head)
		const marked: THREE.Mesh[] = []; view.objects.get(head)!.traverse((c) => { if ((c as THREE.Mesh).isMesh) marked.push(c as THREE.Mesh) })
		expect(marked.length).toBeGreaterThan(0)
		expect(marked.every((mesh) => (mesh.material as THREE.MeshStandardMaterial).emissiveIntensity > 0.3)).toBe(true)
		const all = view.shownBounds()!
		view.applyHidden(new Set([feet]))
		expect(isShown(view.objects.get(feet)!)).toBe(false)
		const withoutFeet = view.shownBounds()!
		expect(withoutFeet.min.y).toBeGreaterThan(all.min.y)
		// the ground under the exploded parts follows the lowest part even when it is hidden
		expect(view.shownBounds(true)!.min.y).toBeCloseTo(all.min.y, 6)
		expect(view.explosionFactor).toBe(1)
		// isolating the Head leaves its own box (where it was drawn) and nothing else
		view.applyHidden(view.isolate(head))
		scene.updateMatrixWorld(true)
		const only = view.shownBounds()!
		const headBox = worldBox(view.objects.get(head)!)
		expect(only.min.toArray().map((n) => +n.toFixed(4))).toEqual(headBox.min.toArray().map((n) => +n.toFixed(4)))
		expect(only.max.toArray().map((n) => +n.toFixed(4))).toEqual(headBox.max.toArray().map((n) => +n.toFixed(4)))
		view.reset()
		expect(view.shownBounds()).not.toBeNull()
		expect(view.selectedKey).toBeNull()
	})

	it('frames the exploded parts without turning the view, and the assembled reset still frames the file as loaded', async () => {
		const { scene, view } = await load()
		const camera = new THREE.PerspectiveCamera(42, 1.6, 0.1, 1000)
		const controls = { target: new THREE.Vector3(), update: () => undefined }
		const assembledFrame = frameOf(scene)
		fitCamera(camera, assembledFrame, controls)
		const assembledPosition = camera.position.clone()
		const inView = (box: THREE.Box3) => {
			camera.updateMatrixWorld(true)
			const corners = [0, 1].flatMap((x) => [0, 1].flatMap((y) => [0, 1].map((z) => new THREE.Vector3(x ? box.max.x : box.min.x, y ? box.max.y : box.min.y, z ? box.max.z : box.min.z))))
			return corners.every((corner) => { const p = corner.clone().project(camera); return Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1 && p.z <= 1 })
		}
		expect(inView(view.shownBounds()!)).toBe(true)
		view.explode(1)
		expect(inView(view.shownBounds()!)).toBe(false) // the assembled framing no longer holds the exploded parts
		camera.position.add(new THREE.Vector3(-30, 40, -20)); camera.lookAt(controls.target)
		const direction = camera.position.clone().sub(controls.target).normalize()
		fitCameraKeepingView(camera, frameOfBox(view.shownBounds()!), controls)
		expect(inView(view.shownBounds()!)).toBe(true)
		expect(camera.position.clone().sub(controls.target).normalize().dot(direction)).toBeCloseTo(1, 6)
		// back to assembled and reset: exactly the framing the file had at load
		view.explode(0)
		fitCamera(camera, assembledFrame, controls)
		expect(camera.position.toArray()).toEqual(assembledPosition.toArray())
		expect(inView(view.shownBounds()!)).toBe(true)
	})
})
