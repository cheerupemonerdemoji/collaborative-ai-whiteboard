import { CAD_LIMITS, CAD_PART_KEY, type CadAssembly, type CadAssemblyPart, type CadBomRow } from '../shared/cad-model'

/**
 * Reads assembly structure out of a GLB that has already passed inspectCadArtifact.
 *
 * What counts as a fact here, and nothing more:
 * - the node hierarchy, and which nodes carry a mesh;
 * - a node's name, if it has one;
 * - a stable identity only when the file says so with `extras.partId` (unique within the file);
 * - a bill-of-materials row only when a *named* node declares `extras.bom` with a part number and a whole-number
 *   quantity. Quantities are never counted from meshes, and anonymous meshes never get a row.
 * - an exploded-view group only when a node carries `extras.explodeGroup: true` (a boolean, nothing else counts), and the
 *   grouping is complete: at least two outermost groups, each holding geometry, and no geometry outside every group.
 *   Anything less records no grouping at all, so the viewer disables the exploded view rather than guess.
 * Nothing here is checked against a STEP file or against the geometry.
 */
const MAX_DEPTH = 32
const STRING_BOUND = /^[^\u0000-\u001f\u007f]*$/

interface GltfNode { name?: unknown; mesh?: unknown; children?: unknown; extras?: unknown }
interface Entry { node: number; parentNode: number | null; name: string; named: boolean; mesh: boolean; group: boolean; partId: string | null; bom: { partNumber: string; description?: string; quantity: number } | null }

function plainObject(value: unknown): Record<string, unknown> | null {
	return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function readBom(extras: Record<string, unknown> | null): Entry['bom'] {
	const bom = plainObject(extras?.bom)
	if (!bom) return null
	const partNumber = typeof bom.partNumber === 'string' ? bom.partNumber.trim() : ''
	if (!partNumber || partNumber.length > 64 || !STRING_BOUND.test(partNumber)) return null
	const quantity = bom.quantity
	if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1 || quantity > 100_000) return null
	let description: string | undefined
	if (typeof bom.description === 'string') {
		const text = bom.description.trim()
		if (text.length <= 200 && STRING_BOUND.test(text)) description = text || undefined
	}
	return { partNumber, quantity, ...(description ? { description } : {}) }
}

export function extractCadAssembly(glb: Buffer): CadAssembly | undefined {
	let gltf: { nodes?: unknown; scene?: unknown; scenes?: unknown }
	try {
		const jsonLength = glb.readUInt32LE(12)
		gltf = JSON.parse(glb.subarray(20, 20 + jsonLength).toString('utf8'))
	} catch { return undefined }
	const nodes = Array.isArray(gltf.nodes) ? (gltf.nodes as GltfNode[]) : []
	const scenes = Array.isArray(gltf.scenes) ? (gltf.scenes as Array<{ nodes?: unknown }>) : []
	const scene = scenes[typeof gltf.scene === 'number' ? gltf.scene : 0]
	const roots = Array.isArray(scene?.nodes) ? (scene.nodes as unknown[]).filter((n): n is number => Number.isInteger(n)) : []

	const entries: Entry[] = []
	/** Set if a branch is nested deeper than we walk. We then describe nothing, rather than a tree and BOM with a hole in them. */
	let tooDeep = false
	const seen = new Set<number>()
	/** Depth-first, so the list reads like the tree. A group is kept only if something with a mesh is below it. */
	const visit = (index: number, parentNode: number | null, depth: number): boolean => {
		if (seen.has(index) || index < 0 || index >= nodes.length) return false
		if (depth > MAX_DEPTH) { tooDeep = true; return false }
		seen.add(index)
		const node = nodes[index] ?? {}
		const slot = entries.length
		const extras = plainObject(node.extras)
		const name = typeof node.name === 'string' ? node.name.trim().slice(0, 120) : ''
		const partId = typeof extras?.partId === 'string' && CAD_PART_KEY.test(extras.partId) && !/^node-\d+$/.test(extras.partId) ? extras.partId : null
		entries.push({ node: index, parentNode, name, named: name.length > 0 && STRING_BOUND.test(name), mesh: Number.isInteger(node.mesh), group: extras?.explodeGroup === true, partId, bom: readBom(extras) })
		const entry = entries[slot]
		// A named node that declares a part number and quantity is kept even with no geometry (a purchased part the
		// model does not draw): dropping it would silently lose a row the file explicitly declared.
		let keep = Number.isInteger(node.mesh) || (entry.named && entry.bom !== null)
		for (const child of Array.isArray(node.children) ? (node.children as unknown[]) : []) {
			if (Number.isInteger(child) && visit(child as number, index, depth + 1)) keep = true
		}
		if (!keep) { entries.length = slot; return false }
		return true
	}
	for (const root of roots) visit(root, null, 0)
	// A dropped group's descendants were never kept, so what is left is consistent; check the parents anyway.
	const kept = new Set(entries.map((entry) => entry.node))
	const list = entries.filter((entry) => entry.parentNode === null || kept.has(entry.parentNode))
	if (tooDeep || list.filter((entry) => entry.mesh).length < 2 || list.length > CAD_LIMITS.maxParts) return undefined

	// An identity the file reuses is not an identity: every node that shares one falls back to its node number.
	const counts = new Map<string, number>()
	for (const entry of list) if (entry.partId) counts.set(entry.partId, (counts.get(entry.partId) ?? 0) + 1)
	const keyOf = new Map<number, { key: string; stable: boolean }>()
	for (const entry of list) {
		const stable = entry.partId !== null && counts.get(entry.partId) === 1
		keyOf.set(entry.node, { key: stable ? entry.partId! : `node-${entry.node}`, stable })
	}

	const parts: CadAssemblyPart[] = list.map((entry) => ({
		key: keyOf.get(entry.node)!.key,
		stable: keyOf.get(entry.node)!.stable,
		node: entry.node,
		parent: entry.parentNode === null ? null : keyOf.get(entry.parentNode)?.key ?? null,
		name: entry.named ? entry.name : `Unnamed part (node ${entry.node})`,
		named: entry.named,
		mesh: entry.mesh,
	}))
	const bom: CadBomRow[] = list.flatMap((entry) => (entry.named && entry.bom
		? [{ partKey: keyOf.get(entry.node)!.key, partNumber: entry.bom.partNumber, ...(entry.bom.description ? { description: entry.bom.description } : {}), quantity: entry.bom.quantity, source: 'glb-extras' as const }]
		: []))
	return { parts, bom, ...explodeGroups(list, keyOf) }
}

/** The outermost flagged nodes, provided every mesh sits in one of them and there are at least two. */
function explodeGroups(list: Entry[], keyOf: Map<number, { key: string; stable: boolean }>): { explode?: string[] } {
	const byNode = new Map(list.map((entry) => [entry.node, entry]))
	const flaggedAbove = (entry: Entry): boolean => {
		for (let current = entry.parentNode === null ? undefined : byNode.get(entry.parentNode), hops = 0; current && hops <= MAX_DEPTH + 1; current = current.parentNode === null ? undefined : byNode.get(current.parentNode), hops++) if (current.group) return true
		return false
	}
	const outermost = list.filter((entry) => entry.group && !flaggedAbove(entry))
	if (outermost.length < 2) return {}
	const covered = (entry: Entry) => entry.group || flaggedAbove(entry)
	if (list.some((entry) => entry.mesh && !covered(entry))) return {}
	// Every group must actually contain geometry: an empty group would be a marker with nothing to move.
	const holdsMesh = (group: Entry) => list.some((entry) => entry.mesh && (entry === group || isUnder(entry, group, byNode)))
	if (!outermost.every(holdsMesh)) return {}
	return { explode: outermost.map((entry) => keyOf.get(entry.node)!.key) }
}

function isUnder(entry: Entry, ancestor: Entry, byNode: Map<number, Entry>): boolean {
	for (let current = entry.parentNode === null ? undefined : byNode.get(entry.parentNode), hops = 0; current && hops <= MAX_DEPTH + 1; current = current.parentNode === null ? undefined : byNode.get(current.parentNode), hops++) if (current === ancestor) return true
	return false
}
