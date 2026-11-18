import * as THREE from 'three'
import { addCadLights, disposeObject, fitCamera, frameOf, parseCadPreview, type CadPreviewFormat } from './cad-scene'

/**
 * Renders one still frame of a model to a PNG, so the canvas card can show a picture and never has to run WebGL.
 * Returns null when the browser has no WebGL; the caller then keeps a placeholder.
 */
export async function renderCadThumbnail(buffer: ArrayBuffer, format: CadPreviewFormat): Promise<Blob | null> {
	const canvas = document.createElement('canvas')
	let renderer: THREE.WebGLRenderer
	try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true }) }
	catch { return null }
	let model: THREE.Object3D | null = null
	try {
		renderer.setSize(480, 320, false)
		const scene = new THREE.Scene()
		scene.background = new THREE.Color('#101820')
		addCadLights(scene)
		model = await parseCadPreview(buffer, format)
		scene.add(model)
		const camera = new THREE.PerspectiveCamera(42, 480 / 320, 0.1, 1_000)
		fitCamera(camera, frameOf(model))
		renderer.render(scene, camera)
		return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
	} finally {
		if (model) disposeObject(model)
		renderer.dispose()
		renderer.forceContextLoss()
	}
}
