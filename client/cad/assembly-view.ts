import * as THREE from 'three'
import type { CadAssemblyPart } from '../../shared/cad-model'
import { findAlternatives, groupProgress, planExplosion, type AlternativeGroups, type ExplodeLayout } from './explode-layout'
import { EXPLODE_PLANS } from './explode-plans'

/**
 * Review-only controls over the parts of a loaded assembly: select, hide, isolate and explode.
 *
 * Everything here changes how the viewer draws and nothing else. It touches no stored file and no record: the
 * source GLB, the revision and its approval are untouched. Explosion in particular moves objects in the scene
 * only, and `restore()` copies the transforms captured at load straight back (never by subtracting offsets), so
 * going back to the original arrangement is exact. These moves are not mates and prove nothing mechanical. Where each group
 * goes is decided by `explode-layout.ts`: a drawing chosen for legibility, never evidence of fit, clearance or how to take it apart.
 */
const HIGHLIGHT = new THREE.Color('#ffb020')

interface Original { position: THREE.Vector3; quaternion: THREE.Quaternion; scale: THREE.Vector3 }

export class AssemblyView {
	readonly objects = new Map<string, THREE.Object3D>()
	private readonly keys = new Map<THREE.Object3D, string>()
	private readonly originals = new Map<THREE.Object3D, Original>()
	private readonly highlighted = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>()
	private readonly highlightCache = new Map<THREE.Material, THREE.Material>()
	private selected: string | null = null
	private explosion = 0
	private plan: ExplodeLayout | null = null
	private pairs: AlternativeGroups[] = []

	/**
	 * `explodeGroups` are the outermost component groups the SERVER verified and recorded on the revision (never read from the
	 * file by the browser). With them the exploded view moves each group as one unit; without them it is unavailable.
	 */
	constructor(readonly root: THREE.Object3D, readonly parts: readonly CadAssemblyPart[], nodeObjects: ReadonlyMap<number, THREE.Object3D>, readonly explodeGroups: readonly string[] = []) {
		for (const part of parts) {
			const object = nodeObjects.get(part.node)
			if (!object) continue
			this.objects.set(part.key, object)
			this.keys.set(object, part.key)
			this.originals.set(object, { position: object.position.clone(), quaternion: object.quaternion.clone(), scale: object.scale.clone() })
		}
		// The layout is worked out once, from the arrangement as loaded, so it can never depend on where the slider has been.
		if (this.canExplode) {
			this.root.updateMatrixWorld(true)
			const names = new Map(parts.map((part) => [part.key, part.name]))
			const groups = this.explodeGroups.map((key) => ({ key, name: names.get(key) ?? key, box: new THREE.Box3().setFromObject(this.objects.get(key)!) }))
			this.plan = planExplosion(groups, EXPLODE_PLANS)
			this.pairs = findAlternatives(groups, EXPLODE_PLANS)
		}
	}

	/**
	 * Pairs of groups that sit in the same place in the file (recorded for this file and confirmed against the loaded geometry). Display only:
	 * it says where the file puts them, not which one, if either, is right. Neither is ever removed or moved by this.
	 */
	get alternatives(): readonly AlternativeGroups[] { return this.pairs }

	/** How many of the listed parts were found in the loaded scene. */
	get matched() { return this.objects.size }

	/**
	 * True only when there are at least two verified groups, every group was found in the loaded scene, none contains another,
	 * and every mesh in the scene is inside one. Anything less and the exploded view stays off: it would otherwise scatter pieces
	 * of one component.
	 */
	get canExplode(): boolean {
		const groups = new Set(this.explodeGroups)
		if (groups.size < 2 || groups.size !== this.explodeGroups.length) return false
		for (const key of groups) {
			const object = this.objects.get(key)
			if (!object) return false
			for (let up = object.parent; up; up = up.parent) { const above = this.keys.get(up); if (above && groups.has(above)) return false }
		}
		let loose = false
		this.root.traverse((child) => {
			if (!(child as THREE.Mesh).isMesh || loose) return
			let inside = false
			for (let current: THREE.Object3D | null = child; current; current = current.parent) { const key = this.keys.get(current); if (key && groups.has(key)) { inside = true; break } }
			if (!inside) loose = true
		})
		return !loose
	}

	/** The part a clicked object belongs to: the nearest ancestor (or itself) that is a listed part. */
	partOf(object: THREE.Object3D | null): string | null {
		for (let current = object; current; current = current.parent) {
			const key = this.keys.get(current)
			if (key) return key
		}
		return null
	}

	private meshesUnder(key: string): THREE.Mesh[] {
		const meshes: THREE.Mesh[] = []
		this.objects.get(key)?.traverse((child) => { if ((child as THREE.Mesh).isMesh) meshes.push(child as THREE.Mesh) })
		return meshes
	}

	private highlightOf(material: THREE.Material): THREE.Material {
		let clone = this.highlightCache.get(material)
		if (!clone) {
			clone = material.clone()
			const standard = clone as THREE.MeshStandardMaterial
			if (standard.emissive) { standard.emissive = HIGHLIGHT.clone(); standard.emissiveIntensity = 0.55 }
			this.highlightCache.set(material, clone)
		}
		return clone
	}

	get selectedKey() { return this.selected }

	select(key: string | null) {
		for (const [mesh, original] of this.highlighted) mesh.material = original
		this.highlighted.clear()
		this.selected = key && this.objects.has(key) ? key : null
		if (!this.selected) return
		for (const mesh of this.meshesUnder(this.selected)) {
			this.highlighted.set(mesh, mesh.material)
			mesh.material = Array.isArray(mesh.material) ? mesh.material.map((item) => this.highlightOf(item)) : this.highlightOf(mesh.material)
		}
	}

	/** Shows every part except those named. Hiding a group hides what is under it. */
	applyHidden(hidden: ReadonlySet<string>) {
		for (const [key, object] of this.objects) object.visible = !hidden.has(key)
	}

	/** The hidden set that leaves only `key`, what is under it, and the groups above it (so it can still be drawn). */
	isolate(key: string): Set<string> { return hiddenForIsolation(this.parts, key) }

	/** Copies the transforms captured at load back onto every part. Exact: nothing is recomputed. */
	restore() {
		for (const [object, original] of this.originals) {
			object.position.copy(original.position)
			object.quaternion.copy(original.quaternion)
			object.scale.copy(original.scale)
			object.updateMatrix()
		}
		this.root.updateMatrixWorld(true)
		this.explosion = 0
	}

	get explosionFactor() { return this.explosion }

	/** True when no part has moved from where the file put it. */
	isOriginal(): boolean {
		for (const [object, original] of this.originals) {
			if (!object.position.equals(original.position) || !object.quaternion.equals(original.quaternion) || !object.scale.equals(original.scale)) return false
		}
		return true
	}

	/** How the exploded view is laid out: from a recorded plan for this file, or automatically. Null when the view is unavailable. */
	get layout(): Pick<ExplodeLayout, 'source' | 'planId' | 'unresolved'> | null {
		return this.plan ? { source: this.plan.source, planId: this.plan.planId, unresolved: [...this.plan.unresolved] } : null
	}

	/**
	 * Moves each verified component group, as ONE unit, along its own line to the place the layout gave it, in proportion to
	 * `factor` (0 to 1). Only the group's own node is translated: everything under it (its solids, screws, nested sub-assemblies)
	 * keeps its position relative to the group, so a component never comes apart. Always computed from the original arrangement,
	 * so repeating or reversing it never accumulates error. Does nothing when `canExplode` is false.
	 */
	explode(factor: number) {
		this.restore()
		const amount = Math.min(1, Math.max(0, factor))
		if (amount === 0 || !this.canExplode || !this.plan) return
		this.root.updateMatrixWorld(true)
		for (const key of this.explodeGroups) {
			const object = this.objects.get(key)!
			const parent = object.parent
			const offset = this.plan.offsets.get(key)
			if (!parent || !offset) continue
			const progress = groupProgress(this.plan, key, amount)
			if (progress === 0) continue
			// A world-space move expressed in the parent's space, so a parent that is itself rotated or scaled still moves the group the same way.
			const from = parent.worldToLocal(new THREE.Vector3())
			const to = parent.worldToLocal(offset.clone().multiplyScalar(progress))
			object.position.add(to.sub(from))
			object.updateMatrix()
		}
		this.root.updateMatrixWorld(true)
		this.explosion = amount
	}

	/**
	 * The box around everything currently drawn (hidden parts left out unless `includeHidden`), or null when nothing is shown.
	 * Used to frame the exploded view and to keep the ground grid under it.
	 */
	shownBounds(includeHidden = false): THREE.Box3 | null {
		this.root.updateMatrixWorld(true)
		const box = new THREE.Box3()
		this.root.traverse((child) => { if ((child as THREE.Mesh).isMesh && (includeHidden || isShown(child))) box.expandByObject(child) })
		return box.isEmpty() ? null : box
	}

	/** Back to the file's own arrangement, nothing hidden, nothing selected. */
	reset() {
		this.select(null)
		this.restore()
		for (const object of this.objects.values()) object.visible = true
	}

	dispose() {
		this.select(null)
		for (const material of this.highlightCache.values()) material.dispose()
		this.highlightCache.clear()
	}
}

/** True if the object and everything above it is visible, which a raycast hit must also satisfy. */
export function isShown(object: THREE.Object3D | null): boolean {
	for (let current = object; current; current = current.parent) if (!current.visible) return false
	return true
}

/** The set of part keys to hide so that only `key`, everything under it and the groups above it remain visible. */
export function hiddenForIsolation(parts: readonly CadAssemblyPart[], key: string): Set<string> {
	const keep = new Set<string>()
	const byKey = new Map(parts.map((part) => [part.key, part]))
	for (let current = byKey.get(key); current; current = current.parent ? byKey.get(current.parent) : undefined) keep.add(current.key)
	const addBelow = (parent: string) => { for (const part of parts) if (part.parent === parent && !keep.has(part.key)) { keep.add(part.key); addBelow(part.key) } }
	if (byKey.has(key)) addBelow(key)
	return new Set(parts.filter((part) => !keep.has(part.key)).map((part) => part.key))
}

/** Tree depth of each part, following parent links. */
export function partDepths(parts: readonly CadAssemblyPart[]): Map<string, number> {
	const byKey = new Map(parts.map((part) => [part.key, part]))
	const depth = new Map<string, number>()
	for (const part of parts) {
		let level = 0
		for (let current = part.parent ? byKey.get(part.parent) : undefined; current && level < 64; current = current.parent ? byKey.get(current.parent) : undefined) level++
		depth.set(part.key, level)
	}
	return depth
}
/** Which of two groups that share a place are drawn: both (as the file supplies them), only the first or only the second, or 'custom' when neither is. */
export type AlternativeChoice = 'both' | 'first' | 'second' | 'custom'

/** Reads the choice from the hidden set. The hidden set stays the one source of truth, so the tree's Hide and Show and this control never disagree. */
export function alternativeChoice(hidden: ReadonlySet<string>, keys: readonly [string, string]): AlternativeChoice {
	const [first, second] = [hidden.has(keys[0]), hidden.has(keys[1])]
	if (!first && !second) return 'both'
	if (!first && second) return 'first'
	if (first && !second) return 'second'
	return 'custom'
}

/** The hidden set for a choice. Only these two keys change; everything else the reviewer hid stays hidden. */
export function withAlternativeChoice(hidden: ReadonlySet<string>, keys: readonly [string, string], choice: Exclude<AlternativeChoice, 'custom'>): Set<string> {
	const next = new Set(hidden)
	next.delete(keys[0]); next.delete(keys[1])
	if (choice === 'first') next.add(keys[1])
	if (choice === 'second') next.add(keys[0])
	return next
}
