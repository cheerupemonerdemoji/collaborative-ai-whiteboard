import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { AssemblyView } from '../client/cad/assembly-view'
import { parseCadAssembly } from '../client/cad/cad-scene'
import { groupProgress, LAYOUT_CAP, LAYOUT_GAP, planExplosion, planMatches, type LayoutGroup } from '../client/cad/explode-layout'
import { EXPLODE_PLANS, OTTO_DIY_LAYOUT, TURTLEBOT3_BURGER_LEVEL_A_LAYOUT } from '../client/cad/explode-plans'
import { extractCadAssembly } from '../server/cad-assembly'
import { ottoGroups } from './fixtures/otto-grouped'
import { haveTurtlebot, TURTLEBOT_BOXES, TURTLEBOT_GLB, TURTLEBOT_SHA256, turtlebotGroups } from './fixtures/turtlebot-level-a'

/**
 * The recorded layout of the TurtleBot3 Burger Level A exploded-view file (20 groups; 17 of them inferred shells of one merged base mesh). Every check is about what is drawn:
 * the layout is never evidence of fit, clearance or how the parts come apart, and nothing stored changes. The 20 group boxes are measured from the file (SHA-256 7101dbcd...),
 * so the plan is exercised on CI too; the same file is loaded for real where it exists on this machine.
 */

const union = (boxes: THREE.Box3[]) => boxes.reduce((all, box) => all.union(box), new THREE.Box3())
const separation = (a: THREE.Box3, b: THREE.Box3) => Math.max(a.min.x - b.max.x, b.min.x - a.max.x, a.min.y - b.max.y, b.min.y - a.max.y, a.min.z - b.max.z, b.min.z - a.max.z)
const overlapVolume = (a: THREE.Box3, b: THREE.Box3) => { const common = a.clone().intersect(b); return common.isEmpty() ? 0 : common.getSize(new THREE.Vector3()).toArray().reduce((p, q) => p * q, 1) }
const at = (groups: LayoutGroup[], layout: ReturnType<typeof planExplosion>, factor: number) => groups.map((g) => g.box.clone().translate(layout.offsets.get(g.key)!.clone().multiplyScalar(groupProgress(layout, g.key, factor))))
const totalOverlap = (boxes: THREE.Box3[]) => { let sum = 0; for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) sum += overlapVolume(boxes[i], boxes[j]); return sum }
const shuffled = <T,>(items: T[], seed: number) => { const out = [...items]; let state = seed; for (let i = out.length - 1; i > 0; i--) { state = (state * 1103515245 + 12345) & 0x7fffffff; const j = state % (i + 1); [out[i], out[j]] = [out[j], out[i]] } return out }
const find = (groups: LayoutGroup[], needle: string) => { const hits = groups.filter((g) => g.name.includes(needle)); expect(hits, needle).toHaveLength(1); return hits[0] }

describe('the recorded TurtleBot Level A layout', () => {
	it('is a plan for 20 uniquely named groups, in the order they are placed, that stays with its anchor first', () => {
		const names = TURTLEBOT3_BURGER_LEVEL_A_LAYOUT.groups.map((hint) => hint.name)
		expect(names).toHaveLength(20)
		expect(new Set(names).size).toBe(20)
		expect(new Set(names)).toEqual(new Set(TURTLEBOT_BOXES.map(([name]) => name)))
		expect(TURTLEBOT3_BURGER_LEVEL_A_LAYOUT.groups[0]).toMatchObject({ name: 'Plate, level 3 with its nearby fasteners (inferred)', direction: [0, 0, 0] })
		expect(TURTLEBOT3_BURGER_LEVEL_A_LAYOUT.groups.filter((hint) => hint.direction.every((v) => v === 0))).toHaveLength(1)
		expect(EXPLODE_PLANS).toContain(TURTLEBOT3_BURGER_LEVEL_A_LAYOUT)
		expect(new Set(EXPLODE_PLANS.map((plan) => plan.id)).size).toBe(EXPLODE_PLANS.length)
	})

	it('applies only to these exact 20 groups at the positions they were measured at', () => {
		const groups = turtlebotGroups()
		const assembly = union(groups.map((g) => g.box))
		expect(planMatches(TURTLEBOT3_BURGER_LEVEL_A_LAYOUT, groups, assembly)).toBe(true)
		const layout = planExplosion(groups, EXPLODE_PLANS)
		expect(layout.source).toBe('planned')
		expect(layout.planId).toBe('tb3-burger-level-a-v1')
		// a renamed group, a missing group, a duplicated name, or one that sits somewhere else: automatic layout, never a misapplied plan
		const renamed = turtlebotGroups(); renamed[0].name = 'Lidar housing'
		const missing = turtlebotGroups().slice(1)
		const duplicated = turtlebotGroups(); duplicated[1].name = duplicated[0].name
		const moved = turtlebotGroups(); moved[3].box.translate(new THREE.Vector3(0, 12, 0))
		for (const changed of [renamed, missing, duplicated, moved]) expect(planExplosion(changed, EXPLODE_PLANS).source, 'automatic').toBe('automatic')
		// the earlier four-group partial assembly of the same robot is not this file
		expect(planExplosion(turtlebotGroups().slice(0, 4), EXPLODE_PLANS).source).toBe('automatic')
	})

	it('does not take over the Otto file, and Otto\'s plan does not take over this one', () => {
		const otto = ottoGroups()
		expect(planExplosion(otto, EXPLODE_PLANS).planId).toBe('otto-diy-v09-grouped')
		expect(planMatches(TURTLEBOT3_BURGER_LEVEL_A_LAYOUT, otto, union(otto.map((g) => g.box)))).toBe(false)
		const turtle = turtlebotGroups()
		expect(planMatches(OTTO_DIY_LAYOUT, turtle, union(turtle.map((g) => g.box)))).toBe(false)
	})

	it('separates every group from every other at full extension, keeping the gap, with nothing left unplaced', () => {
		const groups = turtlebotGroups()
		const layout = planExplosion(groups, EXPLODE_PLANS)
		expect(layout.unresolved).toEqual([])
		const diagonal = union(groups.map((g) => g.box)).getSize(new THREE.Vector3()).length()
		const final = at(groups, layout, 1)
		for (let i = 0; i < final.length; i++) for (let j = i + 1; j < final.length; j++) expect(separation(final[i], final[j]), `${groups[i].name} / ${groups[j].name}`).toBeGreaterThanOrEqual(LAYOUT_GAP * diagonal - 1e-6)
		// the assembled file overlaps heavily (parts sit inside others), so this is a real change, not a property of the file
		expect(totalOverlap(groups.map((g) => g.box))).toBeGreaterThan(100_000)
		expect(totalOverlap(final)).toBe(0)
	})

	it('places the groups in the plan\'s order, moves each along its own line, leaves the anchor in place and keeps every distance bounded and useful', () => {
		const groups = turtlebotGroups()
		const layout = planExplosion(groups, EXPLODE_PLANS)
		expect(layout.order).toEqual(TURTLEBOT3_BURGER_LEVEL_A_LAYOUT.groups.map((hint) => `k-${hint.name}`))
		const diagonal = union(groups.map((g) => g.box)).getSize(new THREE.Vector3()).length()
		for (const hint of TURTLEBOT3_BURGER_LEVEL_A_LAYOUT.groups) {
			const offset = layout.offsets.get(`k-${hint.name}`)!
			if (hint.direction.every((v) => v === 0)) { expect(offset.length(), hint.name).toBe(0); continue }
			expect(offset.length(), `${hint.name} travels at least one gap`).toBeGreaterThanOrEqual(LAYOUT_GAP * diagonal - 1e-6)
			expect(offset.length(), `${hint.name} stays within the cap`).toBeLessThanOrEqual(LAYOUT_CAP * diagonal + 1e-6)
			expect(offset.clone().normalize().dot(new THREE.Vector3(...hint.direction).normalize()), `${hint.name} follows its own line`).toBeCloseTo(1, 6)
		}
	})

	it('draws what the plan is for: the column stays in a column, each side reads column, motor-sized block, tire, and the standoffs are drawn beside it', () => {
		const groups = turtlebotGroups()
		const layout = planExplosion(groups, EXPLODE_PLANS)
		const offset = (needle: string) => layout.offsets.get(find(groups, needle).key)!
		const final = at(groups, layout, 1)
		const finalBox = (needle: string) => final[groups.indexOf(find(groups, needle))]
		const gap = LAYOUT_GAP * union(groups.map((g) => g.box)).getSize(new THREE.Vector3()).length()
		// vertical column: plates, boards, battery, brackets, caster, lidar and its feet and screws move only up or down
		for (const needle of ['Plate, level 4', 'Plate, level 2', 'Plate, level 1', 'Board, Raspberry', 'Board, OpenCR', 'Small board', 'Battery-sized', 'Brackets and small parts', 'Rear caster', 'Lidar housing', 'Lidar mount feet', 'Lidar mounting screws']) {
			const o = offset(needle)
			expect(Math.abs(o.x) + Math.abs(o.z), `${needle} stays in the column`).toBeLessThan(1e-9)
		}
		for (const needle of ['Lidar housing', 'Lidar mount feet', 'Lidar mounting screws', 'Plate, level 4', 'Board, Raspberry', 'Small board']) expect(offset(needle).y, `${needle} goes up`).toBeGreaterThan(0)
		for (const needle of ['Plate, level 2', 'Plate, level 1', 'Board, OpenCR', 'Battery-sized', 'Brackets and small parts', 'Rear caster']) expect(offset(needle).y, `${needle} goes down`).toBeLessThan(0)
		// the stack keeps the assembled order top to bottom
		const tops = ['Lidar housing', 'Lidar mounting screws', 'Lidar mount feet', 'Plate, level 4', 'Plate, level 3', 'Board, OpenCR', 'Plate, level 2', 'Battery-sized', 'Plate, level 1', 'Rear caster']
		for (let i = 0; i + 1 < tops.length; i++) expect(finalBox(tops[i]).min.y, `${tops[i]} stays above ${tops[i + 1]}`).toBeGreaterThanOrEqual(finalBox(tops[i + 1]).max.y)
		// a motor-sized block goes outward on its own side and does not drop; its tire is further out than the block
		for (const [side, sign] of [['left', 1], ['right', -1]] as const) {
			const motor = offset(`Motor-sized block, ${side}`), tire = offset(`${side[0].toUpperCase()}${side.slice(1)} tire`)
			expect(Math.abs(motor.y), `${side} motor does not drop`).toBeLessThan(1e-9)
			expect(Math.abs(motor.z), `${side} motor stays level front to back`).toBeLessThan(1e-9)
			expect(Math.sign(motor.x), `${side} motor goes outward`).toBe(sign)
			expect(Math.sign(tire.x), `${side} tire goes outward`).toBe(sign)
			const m = finalBox(`Motor-sized block, ${side}`), t = finalBox(`${side[0].toUpperCase()}${side.slice(1)} tire`)
			expect(sign > 0 ? t.min.x - m.max.x : m.min.x - t.max.x, `${side} tire is outside its motor`).toBeGreaterThanOrEqual(gap - 1e-6)
		}
		// the standoff sets are drawn beside the column, front or back, at their own heights
		for (const needle of ['Standoffs x6', 'Standoffs x4, plates 2 to 3', 'Standoffs x4, plates 1 to 2']) { const o = offset(needle); expect(Math.abs(o.y), `${needle} keeps its height`).toBeLessThan(1e-9); expect(Math.abs(o.x), `${needle} keeps its place left to right`).toBeLessThan(1e-9); expect(Math.abs(o.z), `${needle} moves front or back`).toBeGreaterThan(0) }
	})

	it('is more legible than the automatic layout of the same file: shorter overall, the motor-sized blocks travel less than half as far, and the longest single travel is shorter', () => {
		const groups = turtlebotGroups()
		const planned = planExplosion(groups, EXPLODE_PLANS)
		const automatic = planExplosion(groups)
		expect(automatic.source).toBe('automatic')
		const size = (layout: typeof planned) => union(at(groups, layout, 1)).getSize(new THREE.Vector3())
		expect(size(planned).y).toBeLessThan(size(automatic).y)
		const motor = find(groups, 'Motor-sized block, left')
		expect(planned.offsets.get(motor.key)!.length()).toBeLessThan(0.5 * automatic.offsets.get(motor.key)!.length())
		expect(Math.max(...[...planned.offsets.values()].map((o) => o.length()))).toBeLessThan(Math.max(...[...automatic.offsets.values()].map((o) => o.length())))
		const startSize = union(groups.map((g) => g.box)).getSize(new THREE.Vector3())
		expect(size(planned).length()).toBeLessThan(startSize.length() * 3)
	})

	it('gives the same layout whatever order the groups are listed in', () => {
		const reference = planExplosion(turtlebotGroups(), EXPLODE_PLANS)
		for (const seed of [1, 7, 99]) {
			const layout = planExplosion(shuffled(turtlebotGroups(), seed), EXPLODE_PLANS)
			expect(layout.order).toEqual(reference.order)
			for (const [key, offset] of reference.offsets) expect(layout.offsets.get(key)!.toArray()).toEqual(offset.toArray())
		}
	})

	it('reads more cleanly at 25, 50 and 75 percent than as the file arranged it, and never gets worse as the slider rises', () => {
		const groups = turtlebotGroups()
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

describe.skipIf(!haveTurtlebot)('the real Level A TurtleBot GLB', () => {
	const read = () => readFileSync(TURTLEBOT_GLB)
	const load = async () => {
		const bytes = read()
		const assembly = extractCadAssembly(bytes)!
		const { scene, nodeObjects } = await parseCadAssembly(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
		const view = new AssemblyView(scene, assembly.parts, nodeObjects, assembly.explode)
		scene.updateMatrixWorld(true)
		return { scene, view, assembly }
	}
	const worldBox = (object: THREE.Object3D) => new THREE.Box3().setFromObject(object)

	it('is the file the plan was written for', () => {
		expect(createHash('sha256').update(read()).digest('hex')).toBe(TURTLEBOT_SHA256)
	})

	it('uses the recorded plan, with 20 verified groups whose names and boxes are the ones recorded, and nothing left unplaced', async () => {
		const { view, assembly } = await load()
		expect(view.canExplode).toBe(true)
		expect(assembly.explode).toHaveLength(20)
		expect(view.layout).toEqual({ source: 'planned', planId: 'tb3-burger-level-a-v1', unresolved: [] })
		const names = new Map(assembly.parts.map((part) => [part.key, part.name]))
		expect(new Set(assembly.explode!.map((key) => names.get(key)))).toEqual(new Set(TURTLEBOT3_BURGER_LEVEL_A_LAYOUT.groups.map((hint) => hint.name)))
		// the fixture's boxes are the file's own (to the 0.01 mm they were rounded to), so the CI tests above stand for this file
		for (const [name, min, max] of TURTLEBOT_BOXES) {
			const key = assembly.explode!.find((k) => names.get(k) === name)!
			const box = worldBox(view.objects.get(key)!)
			expect(box.min.toArray().map((n, i) => Math.abs(n - min[i])).every((d) => d < 0.02), `${name} min`).toBe(true)
			expect(box.max.toArray().map((n, i) => Math.abs(n - max[i])).every((d) => d < 0.02), `${name} max`).toBe(true)
		}
	})

	it('moves each of the 20 groups as an intact unit and returns to the exact original matrices at 0 and on reset', async () => {
		const { scene, view, assembly } = await load()
		const local = new Map<THREE.Object3D, number[]>(); scene.traverse((o) => local.set(o, o.matrix.toArray()))
		const start = new Map(assembly.explode!.map((key) => [key, worldBox(view.objects.get(key)!)]))
		view.explode(1)
		scene.updateMatrixWorld(true)
		for (const key of assembly.explode!) {
			const object = view.objects.get(key)!
			expect(object.quaternion.toArray(), key).toEqual(new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().fromArray(local.get(object)!)).toArray())
			object.traverse((below) => { if (below !== object) expect(below.matrix.toArray()).toEqual(local.get(below)) })
			expect(worldBox(object).getSize(new THREE.Vector3()).toArray().map((n) => +n.toFixed(6))).toEqual(start.get(key)!.getSize(new THREE.Vector3()).toArray().map((n) => +n.toFixed(6)))
		}
		view.explode(0)
		scene.traverse((o) => expect(o.matrix.toArray()).toEqual(local.get(o)))
		view.explode(0.6); view.reset()
		expect(view.isOriginal()).toBe(true)
		scene.traverse((o) => expect(o.matrix.toArray()).toEqual(local.get(o)))
	})

	it('separates the groups at full explosion: no two group boxes touch', async () => {
		const { scene, view, assembly } = await load()
		const keys = assembly.explode!
		view.explode(1)
		scene.updateMatrixWorld(true)
		const after = keys.map((k) => worldBox(view.objects.get(k)!))
		for (let i = 0; i < after.length; i++) for (let j = i + 1; j < after.length; j++) expect(separation(after[i], after[j]), `${keys[i]} / ${keys[j]}`).toBeGreaterThan(0)
	})
})
