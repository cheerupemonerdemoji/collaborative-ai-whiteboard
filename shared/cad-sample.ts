/**
 * A synthetic, noncritical training part, generated in code on purpose.
 *
 * Shipping it as a file under `public/` would make it a static asset that anyone can fetch without signing in. Built
 * here, it only ever reaches a board through the authenticated CAD artifact route, exactly like a real upload.
 * It is a 60 x 40 x 10 mm block, not a verified engineering part: do not fabricate from it.
 */
export const SAMPLE_CAD = {
	name: 'Machine spacer (training model)',
	modelId: 'TRAINING-SPACER',
	units: 'mm',
	length: 60,
	width: 40,
	thickness: 10,
} as const

export const SAMPLE_STEP_TEXT = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Noncritical training spacer; verify before fabrication'),'2;1');
FILE_NAME('training-spacer.step','2026-10-23T00:00:00',('Collaborative AI Canvas'),(''),'','','');
FILE_SCHEMA(('AUTOMOTIVE_DESIGN'));
ENDSEC;
DATA;
#1=APPLICATION_CONTEXT('automotive design');
#2=APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,#1);
#3=PRODUCT_CONTEXT('',#1,'mechanical');
#4=PRODUCT('training-spacer','training-spacer','Noncritical training model',(#3));
#5=PRODUCT_DEFINITION_FORMATION_WITH_SPECIFIED_SOURCE('1','Measured baseline',#4,.NOT_KNOWN.);
#6=PRODUCT_DEFINITION_CONTEXT('part definition',#1,'design');
#7=PRODUCT_DEFINITION('design','',#5,#6);
#8=PRODUCT_DEFINITION_SHAPE('','',#7);
#9=CARTESIAN_POINT('',(0.,0.,0.));
#10=DIRECTION('',(0.,0.,1.));
#11=DIRECTION('',(1.,0.,0.));
#12=AXIS2_PLACEMENT_3D('',#9,#10,#11);
#13=BLOCK('60 x 40 x 10 mm spacer',#12,60.,40.,10.);
#14=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.));
#15=(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.));
#16=(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT());
#17=(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#18))GLOBAL_UNIT_ASSIGNED_CONTEXT((#14,#15,#16))REPRESENTATION_CONTEXT('',''));
#18=UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(0.01),#14,'distance_accuracy_value','');
#19=CSG_SHAPE_REPRESENTATION('',(#13),#17);
#20=SHAPE_DEFINITION_REPRESENTATION(#8,#19);
ENDSEC;
END-ISO-10303-21;
`

// Corner offsets are counter-clockwise seen from outside, so every face winds the way glTF expects.
const FACES: ReadonlyArray<{ normal: [number, number, number]; corners: Array<[number, number, number]> }> = [
	{ normal: [1, 0, 0], corners: [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]] },
	{ normal: [-1, 0, 0], corners: [[-1, -1, 1], [-1, 1, 1], [-1, 1, -1], [-1, -1, -1]] },
	{ normal: [0, 1, 0], corners: [[-1, 1, -1], [-1, 1, 1], [1, 1, 1], [1, 1, -1]] },
	{ normal: [0, -1, 0], corners: [[-1, -1, 1], [-1, -1, -1], [1, -1, -1], [1, -1, 1]] },
	{ normal: [0, 0, 1], corners: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] },
	{ normal: [0, 0, -1], corners: [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]] },
]

/** A binary glTF 2.0 box (one mesh, flat normals, no textures, no external references). Coordinates are millimetres. */
export function buildSampleGlb(): Uint8Array {
	const hx = SAMPLE_CAD.length / 2
	const hy = SAMPLE_CAD.thickness / 2
	const hz = SAMPLE_CAD.width / 2
	const positions = new Float32Array(FACES.length * 4 * 3)
	const normals = new Float32Array(FACES.length * 4 * 3)
	const indices = new Uint16Array(FACES.length * 6)
	FACES.forEach((face, faceIndex) => {
		face.corners.forEach((corner, cornerIndex) => {
			const at = (faceIndex * 4 + cornerIndex) * 3
			positions.set([corner[0] * hx, corner[1] * hy, corner[2] * hz], at)
			normals.set(face.normal, at)
		})
		const base = faceIndex * 4
		indices.set([base, base + 1, base + 2, base, base + 2, base + 3], faceIndex * 6)
	})

	const binary = new Uint8Array(positions.byteLength + normals.byteLength + indices.byteLength)
	binary.set(new Uint8Array(positions.buffer), 0)
	binary.set(new Uint8Array(normals.buffer), positions.byteLength)
	binary.set(new Uint8Array(indices.buffer), positions.byteLength + normals.byteLength)

	const json = JSON.stringify({
		asset: { version: '2.0', generator: 'collaborative-ai-canvas training sample' },
		scene: 0,
		scenes: [{ nodes: [0] }],
		nodes: [{ mesh: 0, name: 'training-spacer' }],
		meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }],
		materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.34, 0.66, 0.85, 1], metallicFactor: 0.15, roughnessFactor: 0.55 } }],
		accessors: [
			{ bufferView: 0, componentType: 5126, count: 24, type: 'VEC3', min: [-hx, -hy, -hz], max: [hx, hy, hz] },
			{ bufferView: 1, componentType: 5126, count: 24, type: 'VEC3' },
			{ bufferView: 2, componentType: 5123, count: 36, type: 'SCALAR' },
		],
		bufferViews: [
			{ buffer: 0, byteOffset: 0, byteLength: positions.byteLength, target: 34962 },
			{ buffer: 0, byteOffset: positions.byteLength, byteLength: normals.byteLength, target: 34962 },
			{ buffer: 0, byteOffset: positions.byteLength + normals.byteLength, byteLength: indices.byteLength, target: 34963 },
		],
		buffers: [{ byteLength: binary.byteLength }],
	})
	const jsonBytes = new TextEncoder().encode(json)
	const jsonPadded = new Uint8Array(Math.ceil(jsonBytes.length / 4) * 4).fill(0x20)
	jsonPadded.set(jsonBytes)

	const total = 12 + 8 + jsonPadded.length + 8 + binary.length
	const out = new Uint8Array(total)
	const view = new DataView(out.buffer)
	view.setUint32(0, 0x46546c67, true) // 'glTF'
	view.setUint32(4, 2, true)
	view.setUint32(8, total, true)
	view.setUint32(12, jsonPadded.length, true)
	view.setUint32(16, 0x4e4f534a, true) // 'JSON'
	out.set(jsonPadded, 20)
	const binaryHeader = 20 + jsonPadded.length
	view.setUint32(binaryHeader, binary.length, true)
	view.setUint32(binaryHeader + 4, 0x004e4942, true) // 'BIN\0'
	out.set(binary, binaryHeader + 8)
	return out
}

/* ------------------------------------------------------------------------------------------------------------ */
/* A synthetic multi-part assembly, for trying assembly review. Not a real product and not verified geometry.    */
/* ------------------------------------------------------------------------------------------------------------ */

export const SAMPLE_ASSEMBLY = {
	name: 'Training bracket assembly',
	modelId: 'TRAINING-BRACKET',
	units: 'mm',
} as const

interface MeshData { positions: number[]; normals: number[]; indices: number[] }

function boxMesh(hx: number, hy: number, hz: number): MeshData {
	const mesh: MeshData = { positions: [], normals: [], indices: [] }
	FACES.forEach((face, faceIndex) => {
		for (const corner of face.corners) {
			mesh.positions.push(corner[0] * hx, corner[1] * hy, corner[2] * hz)
			mesh.normals.push(...face.normal)
		}
		const base = faceIndex * 4
		mesh.indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
	})
	return mesh
}

/** A cylinder along the Y axis, centred on the origin, with smooth sides and flat ends. */
function cylinderMesh(radius: number, height: number, segments = 24): MeshData {
	const mesh: MeshData = { positions: [], normals: [], indices: [] }
	const half = height / 2
	for (let i = 0; i <= segments; i++) {
		const angle = (i / segments) * Math.PI * 2
		const x = Math.cos(angle), z = Math.sin(angle)
		mesh.positions.push(x * radius, -half, z * radius, x * radius, half, z * radius)
		mesh.normals.push(x, 0, z, x, 0, z)
	}
	for (let i = 0; i < segments; i++) {
		const a = i * 2
		mesh.indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3)
	}
	for (const [y, ny] of [[half, 1], [-half, -1]] as const) {
		const centre = mesh.positions.length / 3
		mesh.positions.push(0, y, 0)
		mesh.normals.push(0, ny, 0)
		for (let i = 0; i <= segments; i++) {
			const angle = (i / segments) * Math.PI * 2
			mesh.positions.push(Math.cos(angle) * radius, y, Math.sin(angle) * radius)
			mesh.normals.push(0, ny, 0)
		}
		for (let i = 0; i < segments; i++) {
			const a = centre + 1 + i
			if (ny > 0) mesh.indices.push(centre, a + 1, a)
			else mesh.indices.push(centre, a, a + 1)
		}
	}
	return mesh
}

interface PartSpec { name?: string; mesh?: MeshData; colour?: [number, number, number]; translation?: [number, number, number]; extras?: Record<string, unknown>; children?: PartSpec[] }

/** Writes a GLB whose nodes follow `tree`, with each node's mesh, colour, translation and extras as given. */
function buildGlbFromTree(tree: PartSpec): Uint8Array {
	const chunks: Uint8Array[] = []
	let offset = 0
	const bufferViews: unknown[] = []
	const accessors: unknown[] = []
	const meshes: unknown[] = []
	const materials: unknown[] = []
	const nodes: Array<Record<string, unknown>> = []
	const addView = (bytes: Uint8Array, target: number): number => {
		const padded = new Uint8Array(Math.ceil(bytes.length / 4) * 4)
		padded.set(bytes)
		chunks.push(padded)
		bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, target })
		offset += padded.length
		return bufferViews.length - 1
	}
	const addAccessor = (view: number, componentType: number, count: number, type: string, bounds?: { min: number[]; max: number[] }) => {
		accessors.push({ bufferView: view, componentType, count, type, ...(bounds ?? {}) })
		return accessors.length - 1
	}
	const emit = (spec: PartSpec): number => {
		const index = nodes.length
		const node: Record<string, unknown> = {}
		nodes.push(node)
		if (spec.name) node.name = spec.name
		if (spec.translation) node.translation = spec.translation
		if (spec.extras) node.extras = spec.extras
		if (spec.mesh) {
			const positions = new Float32Array(spec.mesh.positions)
			const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
			for (let i = 0; i < positions.length; i += 3) for (let axis = 0; axis < 3; axis++) { min[axis] = Math.min(min[axis], positions[i + axis]); max[axis] = Math.max(max[axis], positions[i + axis]) }
			const p = addAccessor(addView(new Uint8Array(positions.buffer), 34962), 5126, positions.length / 3, 'VEC3', { min, max })
			const n = addAccessor(addView(new Uint8Array(new Float32Array(spec.mesh.normals).buffer), 34962), 5126, spec.mesh.normals.length / 3, 'VEC3')
			const indices = new Uint16Array(spec.mesh.indices)
			const i = addAccessor(addView(new Uint8Array(indices.buffer), 34963), 5123, indices.length, 'SCALAR')
			const [r, g, b] = spec.colour ?? [0.7, 0.7, 0.7]
			materials.push({ pbrMetallicRoughness: { baseColorFactor: [r, g, b, 1], metallicFactor: 0.2, roughnessFactor: 0.55 } })
			meshes.push({ primitives: [{ attributes: { POSITION: p, NORMAL: n }, indices: i, material: materials.length - 1 }] })
			node.mesh = meshes.length - 1
		}
		if (spec.children?.length) node.children = spec.children.map(emit)
		return index
	}
	emit(tree)
	const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
	const binary = new Uint8Array(total)
	let at = 0
	for (const chunk of chunks) { binary.set(chunk, at); at += chunk.length }
	const jsonBytes = new TextEncoder().encode(JSON.stringify({
		asset: { version: '2.0', generator: 'collaborative-ai-canvas training assembly' },
		scene: 0, scenes: [{ nodes: [0] }], nodes, meshes, materials, accessors, bufferViews, buffers: [{ byteLength: binary.byteLength }],
	}))
	const jsonPadded = new Uint8Array(Math.ceil(jsonBytes.length / 4) * 4).fill(0x20)
	jsonPadded.set(jsonBytes)
	const length = 12 + 8 + jsonPadded.length + 8 + binary.length
	const out = new Uint8Array(length)
	const view = new DataView(out.buffer)
	view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, length, true)
	view.setUint32(12, jsonPadded.length, true); view.setUint32(16, 0x4e4f534a, true)
	out.set(jsonPadded, 20)
	const head = 20 + jsonPadded.length
	view.setUint32(head, binary.length, true); view.setUint32(head + 4, 0x004e4942, true)
	out.set(binary, head + 8)
	return out
}

/**
 * Five meshes in a small tree: a base plate, an upright, a spacer and a bolt (the last two under a "Fasteners" group),
 * and one mesh with no name at all. The named parts carry `extras.partId`; four of them declare a part number and a
 * quantity. The bolt's quantity of 4 is declared metadata and deliberately does not match the one bolt drawn, so a
 * bill of materials built from it can only be a copy of what the file says, never a count of meshes.
 * Four nodes are marked `extras.explodeGroup`, so the exploded view moves the Fasteners group (spacer and bolt) as one unit.
 */
export function buildSampleAssemblyGlb(): Uint8Array {
	return buildGlbFromTree({
		name: SAMPLE_ASSEMBLY.name,
		children: [
			{ name: 'Base plate', mesh: boxMesh(40, 3, 25), colour: [0.62, 0.66, 0.7], translation: [0, 3, 0], extras: { explodeGroup: true, partId: 'base-plate', bom: { partNumber: 'TRN-BASE-001', description: 'Base plate, 80 x 6 x 50', quantity: 1 } } },
			{ name: 'Upright', mesh: boxMesh(3, 20, 25), colour: [0.34, 0.6, 0.85], translation: [-37, 26, 0], extras: { explodeGroup: true, partId: 'upright', bom: { partNumber: 'TRN-UPR-002', description: 'Upright, 6 x 40 x 50', quantity: 1 } } },
			{
				name: 'Fasteners',
					extras: { explodeGroup: true },
				children: [
					{ name: 'Spacer', mesh: cylinderMesh(6, 12), colour: [0.95, 0.6, 0.2], translation: [15, 12, 0], extras: { partId: 'spacer', bom: { partNumber: 'TRN-SPC-003', description: 'Spacer, 12 mm diameter x 12', quantity: 2 } } },
					{ name: 'Bolt', mesh: cylinderMesh(2.5, 20), colour: [0.2, 0.22, 0.26], translation: [15, 16, 0], extras: { partId: 'bolt', bom: { partNumber: 'TRN-BLT-004', description: 'Bolt, 5 mm diameter x 20', quantity: 4 } } },
				],
			},
			{ mesh: boxMesh(8, 1, 8), colour: [0.85, 0.85, 0.9], translation: [15, 28, 0], extras: { explodeGroup: true } },
		],
	})
}
