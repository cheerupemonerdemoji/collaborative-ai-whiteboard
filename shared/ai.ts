import { z } from 'zod'
const id = z.string().regex(/^shape:[A-Za-z0-9_-]{1,80}$/)
const coordinate = z.number().finite().min(-100_000).max(100_000)
const dimension = z.number().finite().min(10).max(5_000)
const text = z.string().trim().min(1).max(500)
export const canvasObjectSchema = z.object({ id, type: z.string().max(40), text: z.string().max(500), x: coordinate, y: coordinate, width: z.number().finite().min(0).max(5_000), height: z.number().finite().min(0).max(5_000), startX: coordinate.optional(), startY: coordinate.optional(), endX: coordinate.optional(), endY: coordinate.optional(), fromId: id.optional(), toId: id.optional() }).strict()
const createShape = z.object({ tool: z.literal('create_shape'), id, type: z.enum(['rectangle', 'ellipse']), text, x: coordinate, y: coordinate, width: dimension, height: dimension }).strict()
const createText = z.object({ tool: z.literal('create_text'), id, text, x: coordinate, y: coordinate }).strict()
const createArrow = z.object({ tool: z.literal('create_arrow'), id, x: coordinate, y: coordinate, endX: coordinate, endY: coordinate }).strict()
const updateText = z.object({ tool: z.literal('update_text'), id, text }).strict()
const moveShape = z.object({ tool: z.literal('move_shape'), id, x: coordinate, y: coordinate }).strict()
const resizeShape = z.object({ tool: z.literal('resize_shape'), id, width: dimension, height: dimension }).strict()
const deleteShape = z.object({ tool: z.literal('delete_shape'), id }).strict()
const connectShapes = z.object({ tool: z.literal('connect_shapes'), id, fromId: id, toId: id }).strict()
export const canvasActionSchema = z.discriminatedUnion('tool', [createShape, createText, createArrow, updateText, moveShape, resizeShape, deleteShape, connectShapes])
export const canvasActionsSchema = z.array(canvasActionSchema).min(1).max(30)
export type CanvasAction = z.infer<typeof canvasActionSchema>
export type CanvasObject = z.infer<typeof canvasObjectSchema>
export const aiRequestSchema = z.object({ roomId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/), prompt: z.string().trim().min(1).max(2_000), objects: z.array(canvasObjectSchema).max(500), mode: z.enum(['auto', 'mock']).default('auto') }).strict()
export function validateReferences(actions: CanvasAction[], objects: CanvasObject[]): CanvasAction[] {
	const known = new Set(objects.map((object) => object.id))
	for (const action of actions) {
		if (action.tool.startsWith('create_') || action.tool === 'connect_shapes') {
			if (known.has(action.id)) throw new Error(`Object ID already exists: ${action.id}`)
			if (action.tool === 'connect_shapes' && (!known.has(action.fromId) || !known.has(action.toId))) throw new Error('Connection references an unknown object ID')
			known.add(action.id)
		} else {
			if (!known.has(action.id)) throw new Error(`Unknown object ID: ${action.id}`)
			if (action.tool === 'delete_shape') known.delete(action.id)
		}
	}
	return actions
}
