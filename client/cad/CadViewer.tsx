import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { CadAssemblyPart } from '../../shared/cad-model'
import { alternativeChoice, AssemblyView, isShown } from './assembly-view'
import type { AlternativeGroups } from './explode-layout'
import { addCadLights, disposeObject, fitCamera, fitCameraKeepingView, frameOf, frameOfBox, parseCadAssembly, parseCadPreview, type CadFrame, type CadPreviewFormat } from './cad-scene'

interface CadViewerProps {
	/** Authenticated asset URL of the GLB or STL preview. */
	url: string
	format: CadPreviewFormat
	/** Model units, shown beside the bounding box. Coordinates in the file are read as these units. */
	units: string
	label: string
	/** When present (GLB only), the viewer builds review-only part controls over these parts. */
	parts?: readonly CadAssemblyPart[]
	/** The component groups the server verified for the exploded view (from the stored revision, never from the file). */
	explodeGroups?: readonly string[]
	selectedKey?: string | null
	hiddenKeys?: ReadonlySet<string>
	/** 0 (as the file arranged it) to 1 (fully exploded). Review only. */
	explosion?: number
	onPick?: (key: string | null) => void
	/** Told which groups the file puts in the same place, once the assembly is loaded (and with none when it is closed). Display only. */
	onAlternatives?: (pairs: readonly AlternativeGroups[]) => void
}

/**
 * The large interactive viewer. One WebGL context exists only while this component is mounted: closing the panel
 * aborts any download, stops rendering and frees every geometry, material, texture and the context itself.
 * It draws on demand (when the camera moves or the window resizes), not in a permanent animation loop.
 */
export function CadViewer({ url, format, units, label, parts, explodeGroups, selectedKey = null, hiddenKeys, explosion = 0, onPick, onAlternatives }: CadViewerProps) {
	const live = useRef({ parts, explodeGroups, selectedKey, hiddenKeys, explosion, onPick, onAlternatives })
	live.current = { parts, explodeGroups, selectedKey, hiddenKeys, explosion, onPick, onAlternatives }
	const viewRef = useRef<AssemblyView | null>(null)
	const redrawRef = useRef<(() => void) | null>(null)
	const hostRef = useRef<HTMLDivElement | null>(null)
	const resetRef = useRef<(() => void) | null>(null)
	const fitExplodedRef = useRef<(() => void) | null>(null)
	/** The ground grid and the height it sits at when nothing is exploded, so it can follow the lowest part down and come back. */
	const gridRef = useRef<{ grid: THREE.GridHelper; assembledY: number } | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [loading, setLoading] = useState(true)
	const [size, setSize] = useState<[number, number, number] | null>(null)
	const [pairs, setPairs] = useState<readonly AlternativeGroups[]>([])

	/** Applies selection, visibility and explosion from props to the loaded assembly, without touching the camera. */
	useEffect(() => {
		const view = viewRef.current
		if (!view) return
		if (view.selectedKey !== selectedKey) view.select(selectedKey)
		view.applyHidden(hiddenKeys ?? new Set())
		if (view.explosionFactor !== explosion) view.explode(explosion)
		// The grid stays under the lowest part, hidden or not, so a group that moved down is not cut through by it.
		const ground = gridRef.current
		const all = view.shownBounds(true)
		if (ground && all) ground.grid.position.y = Math.min(ground.assembledY, all.min.y)
		redrawRef.current?.()
	}, [selectedKey, hiddenKeys, explosion, loading])

	useEffect(() => {
		const host = hostRef.current
		if (!host) return
		setError(null)
		setLoading(true)
		setSize(null)

		let renderer: THREE.WebGLRenderer
		try { renderer = new THREE.WebGLRenderer({ antialias: true }) }
		catch {
			setLoading(false)
			setError('This browser cannot show 3D previews (WebGL is unavailable). You can still download the files.')
			return
		}
		renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
		renderer.outputColorSpace = THREE.SRGBColorSpace
		host.appendChild(renderer.domElement)

		const scene = new THREE.Scene()
		scene.background = new THREE.Color('#101820')
		addCadLights(scene)
		const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 1_000)
		camera.position.set(90, 70, 90)
		const controls = new OrbitControls(camera, renderer.domElement)
		controls.screenSpacePanning = true

		let frame = 0
		let frameQueued = false
		let disposed = false
		let model: THREE.Object3D | null = null
		let modelFrame: CadFrame | null = null
		redrawRef.current = () => requestDraw()
		const draw = () => {
			frameQueued = false
			if (!disposed) renderer.render(scene, camera)
		}
		const requestDraw = () => {
			if (frameQueued || disposed) return
			frameQueued = true
			frame = requestAnimationFrame(draw)
		}
		controls.addEventListener('change', requestDraw)

		resetRef.current = () => {
			if (modelFrame) fitCamera(camera, modelFrame, controls)
			requestDraw()
		}
		// Frames what is drawn right now (parts moved by the exploded view, hidden parts left out) and keeps the viewing angle.
		// The assembled-view reset above is unchanged: it always returns to the framing of the file as it was loaded.
		fitExplodedRef.current = () => {
			const box = viewRef.current?.shownBounds()
			if (!box) return
			fitCameraKeepingView(camera, frameOfBox(box), controls)
			requestDraw()
		}

		const resize = () => {
			const width = Math.max(host.clientWidth, 1)
			const height = Math.max(host.clientHeight, 1)
			camera.aspect = width / height
			camera.updateProjectionMatrix()
			renderer.setSize(width, height, false)
			requestDraw()
		}
		const observer = new ResizeObserver(resize)
		observer.observe(host)
		resize()

		// A click that did not drag picks a part. Hidden parts cannot be picked.
		const raycaster = new THREE.Raycaster()
		const pointer = new THREE.Vector2()
		let downAt: { x: number; y: number } | null = null
		const onPointerDown = (event: PointerEvent) => { downAt = event.button === 0 ? { x: event.clientX, y: event.clientY } : null }
		const onPointerUp = (event: PointerEvent) => {
			const start = downAt
			downAt = null
			const view = viewRef.current
			if (!start || event.button !== 0 || !view || !model || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5) return
			const box = renderer.domElement.getBoundingClientRect()
			pointer.set(((event.clientX - box.left) / box.width) * 2 - 1, -(((event.clientY - box.top) / box.height) * 2 - 1))
			raycaster.setFromCamera(pointer, camera)
			const hit = raycaster.intersectObject(model, true).find((item) => isShown(item.object))
			live.current.onPick?.(hit ? view.partOf(hit.object) : null)
		}
		renderer.domElement.addEventListener('pointerdown', onPointerDown)
		renderer.domElement.addEventListener('pointerup', onPointerUp)

		const abort = new AbortController()
		void (async () => {
			try {
				const response = await fetch(url, { credentials: 'same-origin', signal: abort.signal })
				if (!response.ok) throw new Error(response.status === 404 ? 'This file is no longer available to you.' : `The preview could not be loaded (${response.status}).`)
				const data = await response.arrayBuffer()
				let parsed: THREE.Object3D
				const assemblyParts = live.current.parts
				if (format === 'glb' && assemblyParts?.length) {
					const result = await parseCadAssembly(data)
					parsed = result.scene
					if (!disposed) viewRef.current = new AssemblyView(parsed, assemblyParts, result.nodeObjects, live.current.explodeGroups)
					if (!disposed && viewRef.current) { setPairs(viewRef.current.alternatives); live.current.onAlternatives?.(viewRef.current.alternatives) }
				} else parsed = await parseCadPreview(data, format)
				if (disposed) { disposeObject(parsed); viewRef.current?.dispose(); viewRef.current = null; return }
				model = parsed
				scene.add(parsed)
				modelFrame = frameOf(parsed)
				const grid = new THREE.GridHelper(Math.max(modelFrame.radius * 5, 1), 20, '#3e6273', '#263c48')
				grid.position.y = modelFrame.center.y - modelFrame.size.y / 2
				gridRef.current = { grid, assembledY: grid.position.y }
				scene.add(grid)
				fitCamera(camera, modelFrame, controls)
				setSize([modelFrame.size.x, modelFrame.size.y, modelFrame.size.z])
				setLoading(false)
				requestDraw()
			} catch (caught) {
				if (disposed || abort.signal.aborted) return
				setLoading(false)
				setError(caught instanceof Error && caught.message ? caught.message : 'The preview could not be shown.')
			}
		})()

		return () => {
			disposed = true
			abort.abort()
			cancelAnimationFrame(frame)
			observer.disconnect()
			controls.removeEventListener('change', requestDraw)
			controls.dispose()
			disposeObject(scene)
			if (model) scene.remove(model)
			renderer.dispose()
			renderer.forceContextLoss()
			renderer.domElement.remove()
			resetRef.current = null
			fitExplodedRef.current = null
			gridRef.current = null
			redrawRef.current = null
			renderer.domElement.removeEventListener('pointerdown', onPointerDown)
			renderer.domElement.removeEventListener('pointerup', onPointerUp)
			live.current.onAlternatives?.([])
			viewRef.current?.dispose()
			viewRef.current = null
		}
	}, [url, format])

	const dimension = (value: number) => (value >= 100 ? value.toFixed(0) : value.toFixed(2).replace(/\.?0+$/, ''))
	return <div className="cad-viewer-wrap">
		<div ref={hostRef} className="cad-viewer" role="img" aria-label={`3D preview of ${label}`} />
		<div className="cad-viewer-help">Drag to rotate · right-drag or Shift-drag to pan · wheel to zoom</div>
		<button className="cad-view-reset" type="button" onClick={() => resetRef.current?.()} disabled={loading || !!error}>Fit / reset view</button>
		{parts?.length ? <button className="cad-view-reset cad-view-fit-exploded" type="button" onClick={() => fitExplodedRef.current?.()} disabled={loading || !!error || explosion <= 0}
			title="Frames the parts as drawn now, keeping your viewing angle. Fit / reset view returns to the assembled framing.">Fit exploded view</button> : null}
		{explosion > 0 ? <div className="cad-viewer-badge" role="note">Exploded view: a drawing to read the parts apart. Not mates, fit, clearance or disassembly.{pairs.filter((pair) => alternativeChoice(hiddenKeys ?? new Set(), pair.keys) === 'both').map((pair) => <span key={pair.keys.join('|')} className="cad-viewer-badge-extra">{pair.names[0]} and {pair.names[1]} sit in the same place in the file, so they are drawn apart here only to show both. Where they are drawn is not a mounting position.</span>)}</div> : null}
		{size ? <div className="cad-viewer-size" title="Bounding box of the preview as the file arranged it, in the model's units. The exploded view does not change it.">{explosion > 0 ? 'assembled ' : ''}{dimension(size[0])} × {dimension(size[1])} × {dimension(size[2])} {units}</div> : null}
		{loading && !error ? <div className="cad-viewer-note" role="status">Loading the 3D preview…</div> : null}
		{error ? <div className="cad-viewer-error" role="alert">{error}</div> : null}
	</div>
}
