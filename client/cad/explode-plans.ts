import type { LayoutPlan } from './explode-layout'

/**
 * Recorded explosion layouts for specific files. Each is applied only when the loaded file has exactly that plan's group names and
 * every group's centre still sits where it was measured (see `planMatches`); any other file gets the automatic layout.
 *
 * Source: the grouped Otto DIY preview GLB (STEP product OttoDIY+ v84, converted at millimetres, Y up). The names are the STEP
 * product names of the root's 15 children. The centres are measured from that file's geometry. Directions are chosen for legibility
 * from where each group sits in that geometry (which end of the assembly, which side of the leg block, what it is inside of).
 * They are NOT assembly sequences, mates, fits, clearances or disassembly paths, and the file does not say which servo or
 * screw belongs to which side of the robot, so no left or right is claimed: "+X" and "-X" are only the file's own axes.
 * Distances are not recorded here. The planner computes each one as the smallest step along the line that leaves the group clear of
 * the groups placed before it.
 */
export const OTTO_DIY_LAYOUT: LayoutPlan = {
	id: 'otto-diy-v09-grouped',
	size: [115, 120, 74.2],
	groups: [
		{ name: 'Body', direction: [0, 0, 0], centre: [-0.5, 10.5, -2.6] },
		{ name: 'Leg', direction: [0, -1, 0], centre: [-0.5, -31, -1.1] },
		{ name: 'Feet', direction: [0, -1, 0], centre: [0, -46, -2.6] },
		{ name: 'Servo_SG90 v4', direction: [1, 0, 0], centre: [25, -36.1, -8.3] },
		{ name: 'Servo_MG90S v2', direction: [0, 0, 1], centre: [25, -36.1, -6.9] },
		{ name: 'Servo_SG90_horn v1', direction: [0, 0, -1], centre: [25, -35.3, -23.4] },
		{ name: 'Servo_SG90_cross v1', direction: [1, 0, 0], centre: [25, -12.3, -3.6] },
		{ name: 'Servo_SG90_doublearm v1', direction: [-1, 0, 0], centre: [-26.2, -41.3, -22.2] },
		{ name: 'Screw_short v2', direction: [-1, 0, 0], centre: [-26, -41.6, 19.7] },
		{ name: 'Screw_pointed v2', direction: [0, 0, 1], centre: [-26, -48.5, 18.4] },
		{ name: 'AABattery Holder v2', direction: [0, 1, 0], centre: [-0.5, 9.8, -6.2] },
		{ name: 'Arduino_NANO v2', direction: [0, 1, 0], centre: [7.5, 38.5, -2.9] },
		{ name: 'Arduino_NANO_shield v5', direction: [0, 1, 0], centre: [1.7, 49.7, -3.8] },
		{ name: 'Head', direction: [0, 1, 0], centre: [-0.5, 41.5, -2.6] },
		{ name: 'Ultrasound v3', direction: [0, 0, 1], centre: [-0.4, 43.4, 27.5] },
	],
	// Verified in the GLB: two different meshes (SG90: 1,622 vertices, blue; MG90S: 2,934 vertices, black), the same 12 x 32.8 mm footprint, with
	// the SG90's box lying inside the MG90S's (MG90S is 3 mm longer in Z) and centres 0.0 / 0.0 / 1.4 mm apart. The STEP lists each once under the
	// root assembly ("Servo_SG90 v4:2", "Servo_MG90S v2:1") and carries no flag saying one is an alternative, suppressed or the fitted one. So the
	// viewer states the overlap and lets the reviewer view either or both; it does not decide, remove or relocate either.
	alternatives: [{ names: ['Servo_SG90 v4', 'Servo_MG90S v2'] }],
}

/**
 * The assembly-level exploded view of the TurtleBot3 Burger (Level A): 20 groups derived from four pinned visual meshes (ROBOTIS-GIT/turtlebot3 @ 754a9ddd),
 * the file `turtlebot3_burger_exploded_assembly.glb`, SHA-256 7101dbcd5cb572396794870eca893913220e0c31c6412bf2bc9d3d2448733a0b, millimetres, Y up (+Z front, +X left).
 * The names are the file's own group node names; the centres are measured from the file's geometry. Seventeen of the groups are separate shells of one merged base mesh,
 * named from their size and position ("-sized", "inferred", "unidentified": no vendor file names these parts).
 *
 * The directions are chosen for legibility, as the Otto plan's are, and are NOT assembly sequences, mates, fits, clearances or removal paths. The column of plates, boards,
 * battery, brackets, lidar and caster goes up and down from plate 3, which stays; each motor-sized block goes outward and its tire further out, so each side reads column, motor-sized block, tire; the
 * three standoff sets, which span two plates and cannot sit in the gap the planner keeps, are drawn beside the column, front or back, at their own heights.
 * Distances are not recorded: the planner computes each one. The file's author and the app have no way to say which fastener holds what.
 */
export const TURTLEBOT3_BURGER_LEVEL_A_LAYOUT: LayoutPlan = {
	id: 'tb3-burger-level-a-v1',
	size: [178.2, 191.1, 137.5],
	groups: [
		{ name: 'Plate, level 3 with its nearby fasteners (inferred)', direction: [0, 0, 0], centre: [0, 9.1, 0] },
		{ name: 'Small board with connectors, plate-3 level (unidentified)', direction: [0, 1, 0], centre: [-0.2, 10.4, 21] },
		{ name: 'Board, Raspberry-Pi-sized, 85 x 56 mm, with 4 mounts (inferred)', direction: [0, 1, 0], centre: [-1.3, 14.5, -32] },
		{ name: 'Plate, level 4 (top) with its nearby fasteners (inferred)', direction: [0, 1, 0], centre: [0, 53.4, 0] },
		{ name: 'Lidar mount feet x4 (inferred)', direction: [0, 1, 0], centre: [0, 61.1, 6.7] },
		{ name: 'Lidar mounting screws and washers x4 (inferred)', direction: [0, 1, 0], centre: [0, 68.2, 6.5] },
		{ name: 'Lidar housing, generic (lds.stl)', direction: [0, 1, 0], centre: [0.1, 76, 13.9] },
		{ name: 'Board, OpenCR-sized, 105 x 75 mm, with 4 mounts (inferred)', direction: [0, -1, 0], centre: [0, -33.1, 0] },
		{ name: 'Plate, level 2 with its nearby fasteners (inferred)', direction: [0, -1, 0], centre: [0, -38.2, 0] },
		{ name: 'Battery-sized block, 85 x 41 x 27.5 mm (inferred)', direction: [0, -1, 0], centre: [3, -62.7, -2.6] },
		{ name: 'Brackets and small parts, plates 1-2 level (unidentified)', direction: [0, -1, 0], centre: [0, -62.9, 3] },
		{ name: 'Plate, level 1 (bottom) with its nearby fasteners (inferred)', direction: [0, -1, 0], centre: [0, -79.2, 0] },
		{ name: 'Rear caster at the URDF caster position (inferred)', direction: [0, -1, 0], centre: [0, -88.6, -49] },
		{ name: 'Standoffs x6, plates 3 to 4, 45 mm long (inferred)', direction: [0, 0, 1], centre: [0, 27.8, 0] },
		{ name: 'Standoffs x4, plates 2 to 3, 45 mm long (inferred)', direction: [0, 0, -1], centre: [0, -19.7, 20.2] },
		{ name: 'Standoffs x4, plates 1 to 2, 35 mm long (inferred)', direction: [0, 0, 1], centre: [0, -62.2, 0] },
		{ name: 'Motor-sized block, left, with hub and small parts (inferred)', direction: [1, 0, 0], centre: [50.9, -62.2, 15.9] },
		{ name: 'Motor-sized block, right, with hub and small parts (inferred)', direction: [-1, 0, 0], centre: [-50.9, -62.2, 15.9] },
		{ name: 'Left tire (left_tire.stl)', direction: [1, 0, 0], centre: [80, -62.4, 32] },
		{ name: 'Right tire (right_tire.stl)', direction: [-1, 0, 0], centre: [-80, -62.4, 32] },
	],
}

export const EXPLODE_PLANS: readonly LayoutPlan[] = [OTTO_DIY_LAYOUT, TURTLEBOT3_BURGER_LEVEL_A_LAYOUT]
