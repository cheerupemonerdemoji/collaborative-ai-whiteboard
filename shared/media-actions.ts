import { z } from 'zod'

/**
 * Agent actions for images and links (the agent images and links design note).
 *
 * A separate union from `canvasActionSchema`, like the layout and semantic actions: a test pins the core union's exact
 * shape, so new capabilities are added beside it and never edited into it.
 */

const shapeId = z.string().regex(/^shape:[A-Za-z0-9_-]{1,80}$/)
const coordinate = z.number().finite().min(-100_000).max(100_000)
const size = z.number().finite().min(20).max(5_000)

/** The name an image takes once uploaded: content-addressed, so it always says what its bytes are. Mirrors server/image-artifacts.ts. */
export const IMAGE_ASSET_ID_PATTERN = /^img-[0-9a-f]{64}\.(png|jpg|gif|webp)$/

/** Width an uploaded image is shown at when the agent gives none: its own width, but never wider than this. */
export const DEFAULT_IMAGE_WIDTH = 800

export const MAX_LINK_LENGTH = 2_000

/**
 * A link a shape may carry. `https` only: no `http`, `javascript:`, `data:`, `file:` or `mailto:`, no embedded user name or
 * password, no whitespace or control characters, and a host. Anything else is refused, not repaired.
 */
export function isSafeLink(value: string): boolean {
	if (value.length === 0 || value.length > MAX_LINK_LENGTH) return false
	if (/[\s\u0000-\u001f\u007f]/.test(value)) return false
	let url: URL
	try { url = new URL(value) } catch { return false }
	return url.protocol === 'https:' && url.hostname.length > 0 && url.username === '' && url.password === ''
}

export const safeLink = z.string().refine(isSafeLink, 'A link must be a plain https:// address of at most 2000 characters, with no spaces and no user name or password')

const createImage = z.object({
	tool: z.literal('create_image'),
	id: shapeId,
	assetId: z.string().regex(IMAGE_ASSET_ID_PATTERN),
	x: coordinate,
	y: coordinate,
	width: size.optional(),
	altText: z.string().trim().max(300).optional(),
	url: safeLink.optional(),
}).strict()

/** Sets, or with `null` clears, the link on a shape that can hold one: a rectangle or ellipse, a note or an image. */
const setLink = z.object({ tool: z.literal('set_link'), id: shapeId, url: safeLink.nullable() }).strict()

export const mediaActionSchema = z.discriminatedUnion('tool', [createImage, setLink])
export type MediaAction = z.infer<typeof mediaActionSchema>
export const MEDIA_TOOLS = ['create_image', 'set_link'] as const

/** Shape types that carry a `url` property in tldraw. Text does not, so a text box cannot hold a link. */
export const LINKABLE_SHAPE_TYPES = ['geo', 'note', 'image'] as const
