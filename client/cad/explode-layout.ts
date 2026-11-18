import * as THREE from 'three'

/**
 * The review-only layout of the exploded view. Pure geometry: it reads the assembled boxes of the component groups and
 * returns one translation per group. Nothing here touches the scene, a file or a record.
 *
 * A group is moved along ONE straight line, as a rigid unit, until its box clears the boxes of the groups placed before
 * it by a fixed gap. The line comes from a plan when this file's groups match a recorded one, and otherwise from the
 * direction away from the middle of the assembly. The distance is never a guess: it is the smallest step along the line
 * at which the group no longer touches what is already placed. Boxes are axis-aligned, so "clear" is conservative for
 * round parts and says nothing about real clearance. This is a drawing aid, not a mate, fit, clearance or
 * disassembly check.
 */

export interface LayoutGroup {
	key: string
	name: string
	/** World-space box of the group as the file arranged it. */
	box: THREE.Box3
}

export interface LayoutHint {
	/** The group's name in the file. */
	name: string
	/** Direction of travel, in the file's axes. Normalised here. [0, 0, 0] marks a group that stays where it is. */
	direction: readonly [number, number, number]
	/** The group's centre relative to the middle of the whole assembly, in model units, as measured when the hint was written. */
	centre: readonly [number, number, number]
}

/** A recorded layout for one specific file. It applies only when every group name and every measured position still matches. */
export interface LayoutPlan {
	id: string
	/** Groups in the order they are placed: what stays or travels least first, what ends furthest out last. */
	groups: readonly LayoutHint[]
	/** The whole assembly's size when the hints were measured. */
	size: readonly [number, number, number]
	/**
	 * Pairs of groups that occupy the same place in the file. This records only what the geometry shows (the boxes overlap); it never
	 * says that either group is correct, fitted or the alternative of the other. Used for display only.
	 */
	alternatives?: readonly { names: readonly [string, string] }[]
}

/** Two groups that sit in the same place in the file. Display only: a statement about the geometry as supplied, not about the design. */
export interface AlternativeGroups {
	keys: readonly [string, string]
	names: readonly [string, string]
	/** The share of the smaller group's box that the other group's box covers (0 to 1). */
	overlap: number
}

export interface ExplodeLayout {
	source: 'planned' | 'automatic'
	planId: string | null
	/** Keys in the order they were placed. The first moving group is placed first; the last moves furthest out. */
	order: string[]
	/** The translation each group reaches at full explosion, in world units. */
	offsets: Map<string, THREE.Vector3>
	/** Groups that could not be cleared of every other box within the distance cap. They are drawn at the cap. */
	unresolved: string[]
	/** The clear distance kept between boxes, in model units. */
	gap: number
}

/** The space kept between groups, as a fraction of the assembly's diagonal. */
export const LAYOUT_GAP = 0.04
/** No group travels further than this multiple of the assembly's diagonal. */
export const LAYOUT_CAP = 0.9
/** How closely a recorded plan's measurements must still match before it is trusted, as a fraction of the diagonal. */
export const PLAN_TOLERANCE = 0.02

const AXES: readonly (readonly [number, number, number])[] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]

function apart(moved: THREE.Box3, placed: THREE.Box3, gap: number): boolean {
	return moved.min.x >= placed.max.x + gap || moved.max.x <= placed.min.x - gap
		|| moved.min.y >= placed.max.y + gap || moved.max.y <= placed.min.y - gap
		|| moved.min.z >= placed.max.z + gap || moved.max.z <= placed.min.z - gap
}

/**
 * The smallest step along `direction` at which `box` keeps `gap` from every placed box, or null when none within `cap` does. A moving
 * group always travels at least one gap, so every group that is not left in place visibly separates even when it was already clear.
 */
function clearStep(box: THREE.Box3, direction: THREE.Vector3, placed: readonly THREE.Box3[], gap: number, cap: number): number | null {
	const moved = new THREE.Box3()
	const step = Math.max(gap / 8, cap / 10_000, 1e-9)
	for (let t = gap; t <= cap + 1e-9; t += step) {
		moved.copy(box).translate(direction.clone().multiplyScalar(t))
		if (placed.every((other) => apart(moved, other, gap))) return t
	}
	return null
}

/** Whether a recorded plan describes exactly these groups, at the positions it was measured at. */
export function planMatches(plan: LayoutPlan, groups: readonly LayoutGroup[], assembly: THREE.Box3): boolean {
	if (plan.groups.length !== groups.length) return false
	const size = assembly.getSize(new THREE.Vector3())
	const diagonal = size.length()
	if (diagonal <= 0) return false
	const tolerance = PLAN_TOLERANCE * diagonal
	if (Math.abs(size.x - plan.size[0]) > tolerance || Math.abs(size.y - plan.size[1]) > tolerance || Math.abs(size.z - plan.size[2]) > tolerance) return false
	const middle = assembly.getCenter(new THREE.Vector3())
	const byName = new Map<string, LayoutGroup>()
	for (const group of groups) { if (byName.has(group.name)) return false; byName.set(group.name, group) }
	for (const hint of plan.groups) {
		const group = byName.get(hint.name)
		if (!group) return false
		const offset = group.box.getCenter(new THREE.Vector3()).sub(middle)
		if (offset.distanceTo(new THREE.Vector3(...hint.centre)) > tolerance) return false
	}
	return true
}

/**
 * Plans where each group goes at full explosion. Deterministic: the same boxes and plans always give the same offsets, and the
 * result does not depend on the order `groups` were listed in (ties are broken by name, then key).
 */
export function planExplosion(allGroups: readonly LayoutGroup[], plans: readonly LayoutPlan[] = []): ExplodeLayout {
	// A group with no geometry has no box to place; it is kept where it is and takes no part in the layout.
	const groups = allGroups.filter((group) => !group.box.isEmpty())
	const assembly = new THREE.Box3()
	for (const group of groups) assembly.union(group.box)
	const diagonal = assembly.isEmpty() ? 0 : assembly.getSize(new THREE.Vector3()).length()
	const gap = LAYOUT_GAP * diagonal
	const cap = LAYOUT_CAP * diagonal
	const middle = assembly.isEmpty() ? new THREE.Vector3() : assembly.getCenter(new THREE.Vector3())

	const plan = plans.find((candidate) => planMatches(candidate, groups, assembly)) ?? null
	const byName = new Map(groups.map((group) => [group.name, group]))
	const sequence: { group: LayoutGroup; direction: THREE.Vector3 }[] = []
	if (plan) {
		for (const hint of plan.groups) sequence.push({ group: byName.get(hint.name)!, direction: new THREE.Vector3(...hint.direction).normalize() })
	} else {
		// No recorded plan: away from the middle along the nearest of the six axes, the group nearest the middle first and left in place.
		const ranked = groups.map((group) => ({ group, offset: group.box.getCenter(new THREE.Vector3()).sub(middle) }))
			.sort((a, b) => a.offset.length() - b.offset.length() || a.group.name.localeCompare(b.group.name) || a.group.key.localeCompare(b.group.key))
		ranked.forEach(({ group, offset }, index) => {
			if (index === 0 || offset.length() === 0) { sequence.push({ group, direction: new THREE.Vector3() }); return }
			let best = AXES[0]
			let bestScore = -Infinity
			for (const axis of AXES) { const score = offset.dot(new THREE.Vector3(...axis)); if (score > bestScore + 1e-9) { best = axis; bestScore = score } }
			sequence.push({ group, direction: new THREE.Vector3(...best) })
		})
	}

	const placed: THREE.Box3[] = []
	const offsets = new Map<string, THREE.Vector3>()
	const unresolved: string[] = []
	for (const { group, direction } of sequence) {
		let offset = new THREE.Vector3()
		if (direction.lengthSq() > 0) {
			const step = clearStep(group.box, direction, placed, gap, cap)
			if (step === null) unresolved.push(group.key)
			offset = direction.clone().multiplyScalar(step ?? cap)
		}
		offsets.set(group.key, offset)
		placed.push(group.box.clone().translate(offset))
	}
	const order = sequence.map(({ group }) => group.key)
	for (const group of allGroups) if (group.box.isEmpty()) { offsets.set(group.key, new THREE.Vector3()); order.unshift(group.key) }
	return { source: plan ? 'planned' : 'automatic', planId: plan?.id ?? null, order, offsets, unresolved, gap }
}

/**
 * How far along its own travel a group is at slider position `factor` (0 to 1). Groups placed last, which end furthest out,
 * move first, so that the groups nearer the middle move into the space they have left rather than through them. Each group
 * eases in and out over its own part of the slider. Exactly 0 at 0 and exactly 1 at 1 for every group.
 */
export function groupProgress(layout: Pick<ExplodeLayout, 'order' | 'offsets'>, key: string, factor: number): number {
	const f = Math.min(1, Math.max(0, factor))
	const movers = layout.order.filter((item) => layout.offsets.get(item)!.lengthSq() > 0)
	const place = movers.indexOf(key)
	if (place < 0) return 0
	const count = movers.length
	const duration = Math.min(1, STAGE_SPAN)
	const start = count <= 1 ? 0 : ((count - 1 - place) / (count - 1)) * (1 - duration)
	const t = Math.min(1, Math.max(0, (f - start) / duration))
	return t * t * (3 - 2 * t)
}

/** The share of the slider each group's own movement takes. Less than 1 so that outer groups are well under way before inner ones follow. */
export const STAGE_SPAN = 0.4

/** An overlap this large (share of the smaller box covered by the other) is reported as "the same place". */
export const ALTERNATIVE_MIN_OVERLAP = 0.8

/** The share of the smaller box that the other box covers: volume of the common part over the smaller volume. 0 when they do not meet or a box is flat. */
export function boxOverlapShare(a: THREE.Box3, b: THREE.Box3): number {
	if (a.isEmpty() || b.isEmpty()) return 0
	const common = a.clone().intersect(b)
	if (common.isEmpty()) return 0
	const volume = (box: THREE.Box3) => { const size = box.getSize(new THREE.Vector3()); return size.x * size.y * size.z }
	const smaller = Math.min(volume(a), volume(b))
	return smaller > 0 ? Math.min(1, volume(common) / smaller) : 0
}

/**
 * The recorded pairs of groups that still sit in the same place in these groups. A pair is reported only when a recorded plan matches
 * this file (`planMatches`) AND the two boxes still overlap by at least `ALTERNATIVE_MIN_OVERLAP`, so a changed file reports nothing.
 * This says where the file puts the groups. It does not say which, if either, belongs there.
 */
export function findAlternatives(allGroups: readonly LayoutGroup[], plans: readonly LayoutPlan[] = []): AlternativeGroups[] {
	const groups = allGroups.filter((group) => !group.box.isEmpty())
	const assembly = new THREE.Box3()
	for (const group of groups) assembly.union(group.box)
	const plan = plans.find((candidate) => planMatches(candidate, groups, assembly))
	if (!plan?.alternatives) return []
	const byName = new Map(groups.map((group) => [group.name, group]))
	const found: AlternativeGroups[] = []
	for (const { names } of plan.alternatives) {
		const [first, second] = [byName.get(names[0]), byName.get(names[1])]
		if (!first || !second) continue
		const overlap = boxOverlapShare(first.box, second.box)
		if (overlap >= ALTERNATIVE_MIN_OVERLAP) found.push({ keys: [first.key, second.key], names: [first.name, second.name], overlap })
	}
	return found
}
