import { existsSync } from 'node:fs'
import * as THREE from 'three'
import type { LayoutGroup } from '../../client/cad/explode-layout'

/**
 * The Level A TurtleBot3 Burger exploded-assembly GLB (SHA-256 7101dbcd...) and the 20 group boxes measured from it, in millimetres, Y up. The boxes let the layout and plan
 * tests run everywhere; the file itself is loaded only where it exists (set TURTLEBOT_LEVEL_A_GLB to point at it). The group names are the file's own node names.
 */
export const TURTLEBOT_GLB = process.env.TURTLEBOT_LEVEL_A_GLB ?? ''
export const TURTLEBOT_SHA256 = '7101dbcd5cb572396794870eca893913220e0c31c6412bf2bc9d3d2448733a0b'
export const haveTurtlebot = existsSync(TURTLEBOT_GLB)

export const TURTLEBOT_BOXES: [string, number[], number[]][] = [
	['Lidar housing, generic (lds.stl)', [-34.38, 151.8, -65], [34.5, 191, 28.85]],
	['Lidar mounting screws and washers x4 (inferred)', [-34.5, 154.8, -57.5], [34.5, 172.47, 6.5]],
	['Lidar mount feet x4 (inferred)', [-35.4, 151.5, -58.4], [35.4, 161.5, 7.72]],
	['Plate, level 4 (top) with its nearby fasteners (inferred)', [-68.77, 139, -100.77], [68.77, 158.6, 36.77]],
	['Standoffs x6, plates 3 to 4, 45 mm long (inferred)', [-66.89, 99.5, -98.89], [66.89, 147, 34.89]],
	['Board, Raspberry-Pi-sized, 85 x 56 mm, with 4 mounts (inferred)', [-46.03, 104, -92.95], [43.45, 115.95, -35.14]],
	['Small board with connectors, plate-3 level (unidentified)', [-15.43, 100, -20], [15, 111.7, -2]],
	['Plate, level 3 with its nearby fasteners (inferred)', [-68.77, 91.5, -100.77], [68.77, 117.62, 36.77]],
	['Standoffs x4, plates 2 to 3, 45 mm long (inferred)', [-66.89, 52, -58.5], [66.89, 99.5, 34.89]],
	['Board, OpenCR-sized, 105 x 75 mm, with 4 mounts (inferred)', [-37.5, 56.5, -84.5], [37.5, 68.21, 20.5]],
	['Plate, level 2 with its nearby fasteners (inferred)', [-68.77, 44, -100.77], [68.77, 70.5, 36.77]],
	['Standoffs x4, plates 1 to 2, 35 mm long (inferred)', [-26.5, 14.5, -98.89], [26.5, 52, 34.89]],
	['Battery-sized block, 85 x 41 x 27.5 mm (inferred)', [-17.5, 19, -77.27], [23.46, 46.5, 8]],
	['Brackets and small parts, plates 1-2 level (unidentified)', [-33, 15.9, -90], [33, 49.1, 32]],
	['Motor-sized block, left, with hub and small parts (inferred)', [27.6, 8.34, -43.4], [74.17, 58.16, 11.25]],
	['Motor-sized block, right, with hub and small parts (inferred)', [-74.17, 8.34, -43.4], [-27.6, 58.16, 11.25]],
	['Plate, level 1 (bottom) with its nearby fasteners (inferred)', [-68.77, 9, -100.77], [68.77, 23.5, 36.77]],
	['Rear caster at the URDF caster position (inferred)', [-9, -0.12, -96], [9, 13.8, -66]],
	['Left tire (left_tire.stl)', [70.9, 0, -33], [89.1, 66, 33]],
	['Right tire (right_tire.stl)', [-89.1, 0, -33], [-70.9, 66, 33]],
]

export const turtlebotGroups = (): LayoutGroup[] => TURTLEBOT_BOXES.map(([name, min, max]) => ({ key: `k-${name}`, name, box: new THREE.Box3(new THREE.Vector3(...min), new THREE.Vector3(...max)) }))
