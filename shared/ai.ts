import { z } from 'zod'
import { chartDefinitionSchema } from './chart'
const id = z.string().regex(/^shape:[A-Za-z0-9_-]{1,80}$/)
const coordinate = z.number().finite().min(-100_000).max(100_000)
const dimension = z.number().finite().min(10).max(5_000)
/** What one canvas read shows of a shape's text. Anything longer is a preview, and is marked as one. */
export const TEXT_PREVIEW_LIMIT = 500
/** The longest text one update_text may write: enough to edit a full-length text a lossless read returned. Creation keeps the smaller limit. */
export const MAX_UPDATE_TEXT_LENGTH = 20_000
const text = z.string().trim().min(1).max(TEXT_PREVIEW_LIMIT)
const updateTextValue = z.string().trim().min(1).max(MAX_UPDATE_TEXT_LENGTH)
/** A per-record revision: the document clock at which the record last changed. */
const revision = z.number().int().nonnegative()
export const LOSS_REASONS = ['truncated', 'paragraph_structure_omitted', 'formatting_omitted', 'content_not_exactly_representable'] as const
export type LossReason = (typeof LOSS_REASONS)[number]
export const canvasObjectSchema = z.object({ id, type: z.string().max(40), text: z.string().max(TEXT_PREVIEW_LIMIT), x: coordinate, y: coordinate, width: z.number().finite().min(0).max(5_000), height: z.number().finite().min(0).max(5_000), chart: chartDefinitionSchema.optional(), startX: coordinate.optional(), startY: coordinate.optional(), endX: coordinate.optional(), endY: coordinate.optional(), fromId: id.optional(), toId: id.optional(), revision: revision.optional(), textTruncated: z.boolean().optional(), originalLength: z.number().int().nonnegative().optional(), contentLossy: z.boolean().optional(), lossReasons: z.array(z.enum(LOSS_REASONS)).max(4).optional() }).strict()
const createShape = z.object({ tool: z.literal('create_shape'), id, type: z.enum(['rectangle', 'ellipse']), text, x: coordinate, y: coordinate, width: dimension, height: dimension }).strict()
const createChart = z.object({ tool: z.literal('create_chart'), id, chart: chartDefinitionSchema, x: coordinate, y: coordinate, width: dimension.min(300), height: dimension.min(240) }).strict()
const updateChart = z.object({ tool: z.literal('update_chart'), id, chart: chartDefinitionSchema, expectedRevision: revision }).strict()
const createText = z.object({ tool: z.literal('create_text'), id, text, x: coordinate, y: coordinate, width: z.number().finite().min(20).max(5_000).optional() }).strict()
const createArrow = z.object({ tool: z.literal('create_arrow'), id, x: coordinate, y: coordinate, endX: coordinate, endY: coordinate }).strict()
/**
 * Replaces a shape's text with plain paragraphs. A text whose current content a canvas read could not show exactly (truncated, or
 * paragraph and formatting structure omitted) is only replaced when the caller proves it read the full content
 * (`expectedContentDigest`, which only the lossless shape read returns) or explicitly acknowledges the loss
 * (`overwriteTruncatedSource`). Either way `expectedRevision` must match the record as it stands: an acknowledgement never bypasses concurrency.
 */
const updateText = z.object({ tool: z.literal('update_text'), id, text: updateTextValue, expectedRevision: revision.optional(), expectedContentDigest: z.string().regex(/^[0-9a-f]{64}$/).optional(), overwriteTruncatedSource: z.boolean().optional() }).strict()
const moveShape = z.object({ tool: z.literal('move_shape'), id, x: coordinate, y: coordinate }).strict()
const resizeShape = z.object({ tool: z.literal('resize_shape'), id, width: dimension, height: dimension }).strict()
const deleteShape = z.object({ tool: z.literal('delete_shape'), id }).strict()
const connectShapes = z.object({ tool: z.literal('connect_shapes'), id, fromId: id, toId: id }).strict()
export const canvasActionSchema = z.discriminatedUnion('tool', [createShape, createChart, createText, createArrow, updateText, updateChart, moveShape, resizeShape, deleteShape, connectShapes])
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
