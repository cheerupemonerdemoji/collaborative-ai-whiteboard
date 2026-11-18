import { existsSync } from 'node:fs'
import * as THREE from 'three'
import type { LayoutGroup } from '../../client/cad/explode-layout'

/**
 * The grouped Otto DIY preview GLB (SHA-256 8994be40...) and the 15 group boxes measured from it, in millimetres, Y up. The boxes let the
 * layout and plan tests run everywhere; the file itself is loaded only where it exists (set OTTO_GROUPED_GLB to point at it).
 */
export const OTTO_GLB = process.env.OTTO_GROUPED_GLB ?? ''
export const OTTO_SHA256 = '8994be407317c58ee85850f235d503ae590b82fb358a1ea4f7c06da98110597d'
export const haveOtto = existsSync(OTTO_GLB)

export const OTTO_BOXES: [string, number[], number[]][] = [
	['Body', [-34.5, -39, -34.5], [34.5, 0, 34.5]],
	['Head', [-33.8, -7, -32.2], [33.8, 30, 32.2]],
	['Ultrasound v3', [-22.37, 2.35, 20.45], [22.62, 24.5, 39.7]],
	['Arduino_NANO_shield v5', [-28.6, 12, -28.06], [32.9, 27.5, 25.74]],
	['Arduino_NANO v2', [-14.54, 2.5, -9.09], [30.46, 14.5, 8.51]],
	['Leg', [-34, -82, -17.5], [34, -40, 20.5]],
	['Feet', [-57, -90, -33], [58, -62, 33]],
	['Servo_SG90 v4', [19.5, -82.5, -20.4], [31.5, -49.7, 9]],
	['Servo_MG90S v2', [19.5, -82.5, -20.5], [31.5, -49.7, 12]],
	['Servo_SG90_horn v1', [21.91, -75.1, -22.85], [29.09, -55.51, -18.65]],
	['AABattery Holder v2', [-15.75, -36.17, -32.59], [15.75, -4.17, 25.39]],
	['Servo_SG90_cross v1', [17.13, -44.5, -18.47], [33.88, -40, 16.47]],
	['Screw_short v2', [-27.14, -73.22, 19.56], [-23.84, -69.92, 24.96]],
	['Screw_pointed v2', [-28.08, -81.13, 16.92], [-22.92, -75.93, 25.17]],
	['Servo_SG90_doublearm v1', [-29.25, -87.27, -21.68], [-22.08, -55.32, -17.48]],
]

export const ottoGroups = (): LayoutGroup[] => OTTO_BOXES.map(([name, min, max]) => ({ key: `k-${name}`, name, box: new THREE.Box3(new THREE.Vector3(...min), new THREE.Vector3(...max)) }))
