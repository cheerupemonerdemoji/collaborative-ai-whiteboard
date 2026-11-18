import { readFileSync } from 'node:fs'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { alternativeChoice, AssemblyView, isShown, withAlternativeChoice } from '../client/cad/assembly-view'
import { fitCamera, fitCameraKeepingView, frameOf, frameOfBox, parseCadAssembly } from '../client/cad/cad-scene'
import { ALTERNATIVE_MIN_OVERLAP, boxOverlapShare, findAlternatives, planMatches, type LayoutGroup, type LayoutPlan } from '../client/cad/explode-layout'
import { EXPLODE_PLANS } from '../client/cad/explode-plans'
import { extractCadAssembly } from '../server/cad-assembly'
import { haveOtto, OTTO_GLB, ottoGroups } from './fixtures/otto-grouped'

/**
 * The SG90 and MG90S motors sit in the same place in the grouped Otto file. These checks are about what is DRAWN: the viewer states the
 * overlap, never decides which motor is right, and choosing what to draw never moves, removes or changes anything stored.
 */

const SG = 'Servo_SG90 v4'
const MG = 'Servo_MG90S v2'
const box = (min: number[], max: number[]) => new THREE.Box3(new THREE.Vector3(...min), new THREE.Vector3(...max))
const union = (boxes: THREE.Box3[]) => boxes.reduce((all, item) => all.union(item), new THREE.Box3())

describe('groups the file puts in the same place', () => {
	it('measures how much of the smaller box the other covers', () => {
		expect(boxOverlapShare(box([0, 0, 0], [2, 2, 2]), box([0, 0, 0], [4, 4, 4]))).toBe(1)
		expect(boxOverlapShare(box([0, 0, 0], [2, 2, 2]), box([5, 5, 5], [6, 6, 6]))).toBe(0)
		expect(boxOverlapShare(box([0, 0, 0], [2, 2, 2]), box([1, 0, 0], [3, 2, 2]))).toBeCloseTo(0.5, 9)
		expect(boxOverlapShare(new THREE.Box3(), box([0, 0, 0], [1, 1, 1]))).toBe(0)
		expect(boxOverlapShare(box([0, 0, 0], [0, 2, 2]), box([0, 0, 0], [4, 4, 4]))).toBe(0)
	})

	it('reports exactly the recorded pair on the Otto boxes, and says nothing about which one is right', () => {
		const pairs = findAlternatives(ottoGroups(), EXPLODE_PLANS)
		expect(pairs).toHaveLength(1)
		expect(pairs[0].names).toEqual([SG, MG])
		expect(pairs[0].keys).toEqual([`k-${SG}`, `k-${MG}`])
		expect(pairs[0].overlap).toBeGreaterThan(0.95)
		expect(Object.keys(pairs[0]).sort()).toEqual(['keys', 'names', 'overlap'])
	})

	it('reports nothing when the plan no longer matches the file', () => {
		const renamed = ottoGroups()
		renamed.find((group) => group.name === 'Body')!.name = 'Torso'
		expect(findAlternatives(renamed, EXPLODE_PLANS)).toEqual([])
		expect(findAlternatives(ottoGroups(), [])).toEqual([])
	})

	it('checks the claim against the geometry: a matching plan whose two boxes no longer overlap reports nothing', () => {
		const planFor = (groups: LayoutGroup[]): LayoutPlan => {
			const all = union(groups.map((group) => group.box))
			const middle = all.getCenter(new THREE.Vector3())
			return {
				id: 'test', size: all.getSize(new THREE.Vector3()).toArray() as [number, number, number],
				groups: groups.map((group) => ({ name: group.name, direction: [0, 0, 0] as const, centre: group.box.getCenter(new THREE.Vector3()).sub(middle).toArray() as [number, number, number] })),
				alternatives: [{ names: ['A', 'B'] }],
			}
		}
		const groups: LayoutGroup[] = [
			{ key: 'a', name: 'A', box: box([0, 0, 0], [10, 10, 10]) },
			{ key: 'b', name: 'B', box: box([50, 0, 0], [60, 10, 10]) },
		]
		expect(planMatches(planFor(groups), groups, union(groups.map((group) => group.box)))).toBe(true)
		expect(findAlternatives(groups, [planFor(groups)])).toEqual([])
		groups[1].box = box([2, 0, 0], [12, 10, 10])
		expect(findAlternatives(groups, [planFor(groups)])).toHaveLength(1)
		expect(ALTERNATIVE_MIN_OVERLAP).toBeGreaterThan(0.5)
	})

	it('reads and sets the choice through the hidden set only, leaving everything else the reviewer hid alone', () => {
		const keys = ['sg', 'mg'] as const
		expect(alternativeChoice(new Set(), keys)).toBe('both')
		expect(alternativeChoice(new Set(['mg']), keys)).toBe('first')
		expect(alternativeChoice(new Set(['sg']), keys)).toBe('second')
		expect(alternativeChoice(new Set(['sg', 'mg']), keys)).toBe('custom')
		const other = new Set(['head', 'sg', 'mg'])
		expect([...withAlternativeChoice(other, keys, 'both')].sort()).toEqual(['head'])
		expect([...withAlternativeChoice(other, keys, 'first')].sort()).toEqual(['head', 'mg'])
		expect([...withAlternativeChoice(other, keys, 'second')].sort()).toEqual(['head', 'sg'])
		expect([...other].sort()).toEqual(['head', 'mg', 'sg'])
	})
})

describe.skipIf(!haveOtto)('the two motors in the real grouped Otto GLB', () => {
	const load = async () => {
		const bytes = readFileSync(OTTO_GLB)
		const assembly = extractCadAssembly(bytes)!
		const { scene, nodeObjects } = await parseCadAssembly(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
		const view = new AssemblyView(scene, assembly.parts, nodeObjects, assembly.explode)
		scene.updateMatrixWorld(true)
		const key = (name: string) => assembly.parts.find((part) => part.name === name)!.key
		return { scene, view, key }
	}
	const matrices = (scene: THREE.Object3D) => { const all: number[][] = []; scene.traverse((o) => all.push(o.matrix.toArray())); return all }
	const meshesOf = (object: THREE.Object3D) => { const found: THREE.Mesh[] = []; object.traverse((child) => { if ((child as THREE.Mesh).isMesh) found.push(child as THREE.Mesh) }); return found }
	const worldBox = (object: THREE.Object3D) => new THREE.Box3().setFromObject(object)

	it('are two different models, each in its own group; the viewer reports them as the same place without choosing', async () => {
		const { view, key } = await load()
		const sg = meshesOf(view.objects.get(key(SG))!)
		const mg = meshesOf(view.objects.get(key(MG))!)
		expect(sg).toHaveLength(1)
		expect(mg).toHaveLength(1)
		expect(sg[0].name).toBe('Servo_SG90_v4')
		expect(mg[0].name).toBe('Servo_MG90S_v2')
		expect(sg[0].geometry.getAttribute('position').count).toBe(1622)
		expect(mg[0].geometry.getAttribute('position').count).toBe(2934)
		const colour = (mesh: THREE.Mesh) => (mesh.material as THREE.MeshStandardMaterial).color.getHexString()
		expect([colour(sg[0]), colour(mg[0])]).toEqual(['5f93f3', '000000'])
		expect(view.alternatives).toHaveLength(1)
		expect(view.alternatives[0].keys).toEqual([key(SG), key(MG)])
		expect(view.alternatives[0].names).toEqual([SG, MG])
		expect(view.alternatives[0].overlap).toBeGreaterThan(0.95)
		// as supplied: both drawn, nothing removed or moved
		expect(isShown(view.objects.get(key(SG))!)).toBe(true)
		expect(isShown(view.objects.get(key(MG))!)).toBe(true)
		expect(view.isOriginal()).toBe(true)
	})

	it('draws either motor or both without moving anything, in every slider position, and returns to the exact original matrices', async () => {
		const { scene, view, key } = await load()
		const keys = [key(SG), key(MG)] as const
		const original = matrices(scene)
		const sgObject = view.objects.get(keys[0])!
		const mgObject = view.objects.get(keys[1])!
		for (const factor of [0, 0.25, 0.5, 0.75, 1]) {
			view.applyHidden(new Set())
			view.explode(factor)
			const both = [worldBox(sgObject), worldBox(mgObject)]
			for (const choice of ['first', 'second', 'both'] as const) {
				view.applyHidden(withAlternativeChoice(new Set(), keys, choice))
				expect(isShown(sgObject), `${factor} ${choice} SG90`).toBe(choice !== 'second')
				expect(isShown(mgObject), `${factor} ${choice} MG90S`).toBe(choice !== 'first')
				// choosing what to draw never moves either motor: the one not drawn keeps the place the layout gave it
				expect(worldBox(sgObject).min.toArray()).toEqual(both[0].min.toArray())
				expect(worldBox(mgObject).max.toArray()).toEqual(both[1].max.toArray())
			}
		}
		view.applyHidden(withAlternativeChoice(new Set(), keys, 'first'))
		for (let round = 0; round < 40; round++) view.explode(((round * 37) % 101) / 100)
		view.explode(0)
		expect(matrices(scene)).toEqual(original)
		expect(view.isOriginal()).toBe(true)
	})

	it('keeps selection, hide, show and isolate working for each motor', async () => {
		const { view, key } = await load()
		const keys = [key(SG), key(MG)] as const
		view.explode(1)
		keys.forEach((motor, index) => {
			view.select(motor)
			expect(view.selectedKey).toBe(motor)
			expect(meshesOf(view.objects.get(motor)!).every((mesh) => (mesh.material as THREE.MeshStandardMaterial).emissiveIntensity > 0.3)).toBe(true)
			view.applyHidden(view.isolate(motor))
			expect(isShown(view.objects.get(motor)!)).toBe(true)
			expect(isShown(view.objects.get(keys[1 - index])!)).toBe(false)
			const bounds = view.shownBounds()!
			const own = worldBox(view.objects.get(motor)!)
			expect(bounds.min.toArray().map((n) => +n.toFixed(4))).toEqual(own.min.toArray().map((n) => +n.toFixed(4)))
			expect(bounds.max.toArray().map((n) => +n.toFixed(4))).toEqual(own.max.toArray().map((n) => +n.toFixed(4)))
			view.applyHidden(new Set([motor]))
			expect(isShown(view.objects.get(motor)!)).toBe(false)
			view.applyHidden(new Set())
			expect(isShown(view.objects.get(motor)!)).toBe(true)
		})
		view.reset()
		expect(isShown(view.objects.get(keys[0])!) && isShown(view.objects.get(keys[1])!)).toBe(true)
		expect(view.selectedKey).toBeNull()
		expect(view.isOriginal()).toBe(true)
	})

	it('frames only what is drawn when one motor is chosen, and the assembled reset is unchanged', async () => {
		const { scene, view, key } = await load()
		const keys = [key(SG), key(MG)] as const
		view.explode(1)
		const withBoth = view.shownBounds()!
		view.applyHidden(withAlternativeChoice(new Set(), keys, 'first'))
		const withoutMg = view.shownBounds()!
		view.applyHidden(withAlternativeChoice(new Set(), keys, 'second'))
		const withoutSg = view.shownBounds()!
		// leaving a motor out can never enlarge what is framed (the other groups, not the motors, set the outer extent of the exploded Otto)
		expect(withBoth.containsBox(withoutMg) && withBoth.containsBox(withoutSg)).toBe(true)
		// and a motor that is hidden is not framed: the box of only the visible motor's group is what the drawing holds
		view.applyHidden(new Set(view.explodeGroups.filter((group) => group !== keys[1])))
		const mgAlone = view.shownBounds()!
		expect(mgAlone.min.toArray().map((n) => +n.toFixed(4))).toEqual(worldBox(view.objects.get(keys[1])!).min.toArray().map((n) => +n.toFixed(4)))
		expect(withBoth.containsBox(mgAlone)).toBe(true)

		const camera = new THREE.PerspectiveCamera(42, 1.6, 0.1, 1000)
		const controls = { target: new THREE.Vector3(), update: () => undefined }
		const assembledFrame = frameOf(scene)
		view.explode(0)
		view.applyHidden(new Set())
		fitCamera(camera, assembledFrame, controls)
		const assembledPosition = camera.position.clone()
		view.explode(1)
		view.applyHidden(withAlternativeChoice(new Set(), keys, 'first'))
		fitCameraKeepingView(camera, frameOfBox(view.shownBounds()!), controls)
		camera.updateMatrixWorld(true)
		const shown = view.shownBounds()!
		const corners = [0, 1].flatMap((x) => [0, 1].flatMap((y) => [0, 1].map((z) => new THREE.Vector3(x ? shown.max.x : shown.min.x, y ? shown.max.y : shown.min.y, z ? shown.max.z : shown.min.z))))
		expect(corners.every((corner) => { const p = corner.clone().project(camera); return Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1 && p.z <= 1 })).toBe(true)
		view.explode(0)
		view.applyHidden(new Set())
		fitCamera(camera, assembledFrame, controls)
		expect(camera.position.toArray()).toEqual(assembledPosition.toArray())
	})
})
