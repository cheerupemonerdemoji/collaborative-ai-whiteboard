import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'

/** Shared by the interactive viewer and the offscreen thumbnail renderer. */

export type CadPreviewFormat = 'glb' | 'stl'

/**
 * Parses a preview already fetched from the board's asset route. The loader is never given a way to fetch anything
 * else: the server refuses GLBs with external references, and this guard stops one that got past it from loading.
 */
export async function parseCadPreview(buffer: ArrayBuffer, format: CadPreviewFormat): Promise<THREE.Object3D> {
	if (format === 'stl') {
		const geometry = new STLLoader().parse(buffer)
		geometry.computeVertexNormals()
		const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: '#57a9d8', metalness: 0.15, roughness: 0.55 }))
		// STL files are Z-up by CAD convention; the scene is Y-up.
		const group = new THREE.Group()
		mesh.rotation.x = -Math.PI / 2
		group.add(mesh)
		return group
	}
	const manager = new THREE.LoadingManager()
	manager.setURLModifier((url) => (url.startsWith('data:') || url.startsWith('blob:') ? url : ''))
	const gltf = await new GLTFLoader(manager).parseAsync(buffer, '')
	return gltf.scene
}

/** A parsed GLB together with which scene object each glTF node became, for assembly controls. */
export async function parseCadAssembly(buffer: ArrayBuffer): Promise<{ scene: THREE.Object3D; nodeObjects: Map<number, THREE.Object3D> }> {
	const manager = new THREE.LoadingManager()
	manager.setURLModifier((url) => (url.startsWith('data:') || url.startsWith('blob:') ? url : ''))
	const gltf = await new GLTFLoader(manager).parseAsync(buffer, '')
	const nodeObjects = new Map<number, THREE.Object3D>()
	const associations = (gltf.parser as unknown as { associations: Map<THREE.Object3D, { nodes?: number }> }).associations
	gltf.scene.traverse((object) => {
		const node = associations.get(object)?.nodes
		if (typeof node === 'number') nodeObjects.set(node, object)
	})
	return { scene: gltf.scene, nodeObjects }
}

export function addCadLights(scene: THREE.Scene) {
	scene.add(new THREE.HemisphereLight('#dcecff', '#263849', 2.2))
	const key = new THREE.DirectionalLight('#ffffff', 3.2)
	key.position.set(80, 120, 60)
	scene.add(key)
}

export interface CadFrame { center: THREE.Vector3; size: THREE.Vector3; radius: number }

export function frameOf(object: THREE.Object3D): CadFrame {
	const box = new THREE.Box3().setFromObject(object)
	if (box.isEmpty()) return { center: new THREE.Vector3(), size: new THREE.Vector3(1, 1, 1), radius: 1 }
	const size = box.getSize(new THREE.Vector3())
	return { center: box.getCenter(new THREE.Vector3()), size, radius: Math.max(size.length() / 2, 1e-6) }
}

/** The frame of a world-space box. */
export function frameOfBox(box: THREE.Box3): CadFrame {
	const size = box.getSize(new THREE.Vector3())
	return { center: box.getCenter(new THREE.Vector3()), size, radius: Math.max(size.length() / 2, 1e-6) }
}

/** How far back the camera must be for a sphere of `radius` to fit the narrower of the two view angles. */
function fitDistance(camera: THREE.PerspectiveCamera, radius: number): number {
	const half = (camera.fov * Math.PI) / 360
	const narrowest = Math.min(half, Math.atan(Math.tan(half) * Math.max(camera.aspect, 1e-3)))
	return (radius / Math.sin(narrowest)) * 1.05
}

/** Places the camera so the whole model is in view, whatever its size or units. */
export function fitCamera(camera: THREE.PerspectiveCamera, frame: CadFrame, target?: { target: THREE.Vector3; update(): unknown }) {
	placeCamera(camera, frame, new THREE.Vector3(1, 0.75, 1).normalize(), target)
}

/**
 * Frames `frame` without turning the view: the camera stays on the line it is already looking along, so the person keeps their
 * angle and only the distance and the point looked at change. Used to frame the exploded view.
 */
export function fitCameraKeepingView(camera: THREE.PerspectiveCamera, frame: CadFrame, target: { target: THREE.Vector3; update(): unknown }) {
	const direction = camera.position.clone().sub(target.target)
	if (direction.lengthSq() < 1e-12) direction.set(1, 0.75, 1)
	placeCamera(camera, frame, direction.normalize(), target)
}

function placeCamera(camera: THREE.PerspectiveCamera, frame: CadFrame, direction: THREE.Vector3, target?: { target: THREE.Vector3; update(): unknown }) {
	const distance = fitDistance(camera, frame.radius)
	camera.position.copy(frame.center).add(direction.clone().multiplyScalar(distance))
	camera.near = distance / 200
	camera.far = distance * 200
	camera.updateProjectionMatrix()
	camera.lookAt(frame.center)
	if (target) {
		target.target.copy(frame.center)
		target.update()
	}
}

/** Frees GPU memory for everything under an object: geometries, materials and every texture a material holds. */
export function disposeObject(root: THREE.Object3D) {
	root.traverse((object) => {
		const mesh = object as THREE.Mesh
		mesh.geometry?.dispose()
		const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : []
		for (const material of materials) {
			for (const value of Object.values(material)) if (value instanceof THREE.Texture) value.dispose()
			material.dispose()
		}
	})
}
