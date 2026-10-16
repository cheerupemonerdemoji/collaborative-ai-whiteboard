import { z } from 'zod'

/**
 * Shared vocabulary for board layout: constants, the layout action schemas, the browser measurement report, the
 * fingerprint that ties a measurement to the exact content it measured, and the conservative text estimator.
 *
 * Nothing in `shared/layout*.ts` imports the server, the client or tldraw's runtime, so the same pure engine can be
 * called by the Machine API today and by a human-facing "Tidy" command later.
 *
 * Geometry authority, strongest first:
 *   measured   a browser reported the shape's real size (tldraw measures text in the DOM, so this is the only
 *              authoritative source for text);
 *   declared   the size is stored in the record (geo, frame, image, ...) and needs no measurement;
 *   estimated  no measurement exists, so the size is a deliberately LARGE guess. Anything that rests on an estimate
 *              is reported `unverified`, never as if it were exact.
 */

/** The one default spacing between laid-out items, in page units. */
export const LAYOUT_GAP = 64
/** Two edges closer than this are "aligned". */
export const ALIGNMENT_TOLERANCE = 2
/** Slack when comparing a measured gap against a requested one (float noise only). */
export const SPACING_TOLERANCE = 1
/** Upper bound on shapes one layout read returns before it asks the caller to narrow with `ids` or `types`. */
export const MAX_LAYOUT_SHAPES = 1_500
export const MAX_LAYOUT_ITEMS = 60

export type BoundsSource = 'measured' | 'declared' | 'estimated'
export type Verification = 'verified' | 'unverified'

export interface Rect {
	x: number
	y: number
	w: number
	h: number
}

export interface Point {
	x: number
	y: number
}

/* ------------------------------------------------------------------------- actions -- */

const shapeId = z.string().regex(/^shape:[A-Za-z0-9_-]{1,80}$/)
const gap = z.number().finite().min(0).max(2_000).optional()
const coordinate = z.number().finite().min(-100_000).max(100_000)
const dimension = z.number().finite().min(10).max(5_000)
const ids = (min: number) => z.array(shapeId).min(min).max(MAX_LAYOUT_ITEMS)

const placeBelow = z.object({ tool: z.literal('place_below'), id: shapeId, targetId: shapeId, gap, align: z.enum(['start', 'center', 'end']).optional() }).strict()
const placeRightOf = z.object({ tool: z.literal('place_right_of'), id: shapeId, targetId: shapeId, gap, align: z.enum(['start', 'center', 'end']).optional() }).strict()
const findFreeRegion = z.object({ tool: z.literal('find_free_region'), width: dimension, height: dimension, near: shapeId.optional(), direction: z.enum(['below', 'right', 'any']).optional(), gap }).strict()
const align = z.object({ tool: z.literal('align'), ids: ids(2), axis: z.enum(['left', 'center-x', 'right', 'top', 'center-y', 'bottom']) }).strict()
const distribute = z.object({ tool: z.literal('distribute'), ids: ids(3), direction: z.enum(['horizontal', 'vertical']), gap }).strict()
const row = z.object({ tool: z.literal('row'), ids: ids(1), gap, align: z.enum(['top', 'center', 'bottom']).optional(), x: coordinate.optional(), y: coordinate.optional(), avoidCollisions: z.boolean().optional() }).strict()
const stack = z.object({ tool: z.literal('stack'), ids: ids(1), gap, align: z.enum(['left', 'center', 'right']).optional(), x: coordinate.optional(), y: coordinate.optional(), avoidCollisions: z.boolean().optional() }).strict()
const grid = z.object({ tool: z.literal('grid'), ids: ids(1), columns: z.number().int().min(1).max(12), gap, columnGap: gap, rowGap: gap, x: coordinate.optional(), y: coordinate.optional(), avoidCollisions: z.boolean().optional() }).strict()

/**
 * Layout intents. A deliberately separate union from `canvasActionSchema` (which `tests/` pins) and from the semantic
 * actions: the server combines them in `canvas-api.ts`. They take shape ids and relationships, not raw coordinates:
 * the agent says what it wants, and deterministic code computes the positions and verifies the result.
 */
export const layoutActionSchema = z.discriminatedUnion('tool', [placeBelow, placeRightOf, findFreeRegion, align, distribute, row, stack, grid])
export type LayoutAction = z.infer<typeof layoutActionSchema>
export const LAYOUT_TOOLS = ['place_below', 'place_right_of', 'find_free_region', 'align', 'distribute', 'row', 'stack', 'grid'] as const
export type LayoutTool = (typeof LAYOUT_TOOLS)[number]

/* ------------------------------------------------------------------- measurements -- */

/** One browser measurement: the shape's own (unrotated) size, tied to the content it measured by `fp`. */
export const measurementSchema = z.object({
	id: shapeId,
	w: z.number().finite().min(1).max(50_000),
	h: z.number().finite().min(1).max(50_000),
	fp: z.string().regex(/^[0-9a-f]{16}$/),
}).strict()
export const measurementReportSchema = z.object({ measurements: z.array(measurementSchema).min(1).max(500) }).strict()
export type Measurement = z.infer<typeof measurementSchema>
export type MeasurementReport = z.infer<typeof measurementReportSchema>

/** Shape types whose size depends on DOM measurement, i.e. the ones a browser needs to report. */
export const MEASURED_SHAPE_TYPES: ReadonlySet<string> = new Set(['text', 'note'])

function stableStringify(value: unknown): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
	const object = value as Record<string, unknown>
	return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`).join(',')}}`
}

/** Two independent 32-bit string hashes, joined: enough to detect "this content changed", not a security boundary. */
function hash16(text: string): string {
	let a = 0x811c9dc5
	let b = 5381
	for (let index = 0; index < text.length; index += 1) {
		const code = text.charCodeAt(index)
		a = Math.imul(a ^ code, 0x01000193) >>> 0
		b = (Math.imul(b, 33) ^ code) >>> 0
	}
	return `${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`
}

/**
 * Identifies exactly the inputs that decide a shape's rendered size, so a measurement is only trusted while the shape
 * still has that content. Position, rotation and colour are excluded on purpose: moving a shape must not discard
 * its measurement. `growY` is excluded because it is an OUTPUT of measuring (a note grows to fit its label).
 */
export function layoutFingerprint(shape: { type: string; props: Record<string, unknown> }): string {
	const p = shape.props
	const inputs = shape.type === 'text'
		? { t: 'text', richText: p.richText, size: p.size, font: p.font, scale: p.scale, autoSize: p.autoSize, w: p.autoSize ? null : p.w }
		: shape.type === 'note'
			? { t: 'note', richText: p.richText, size: p.size, font: p.font, scale: p.scale }
			: { t: shape.type }
	return hash16(stableStringify(inputs))
}

/* ------------------------------------------------------------------ text estimator -- */

/** tldraw's default theme: base font 16px, line height 1.35, text sizes are em multiples of the base. */
const BASE_FONT_PX = 16
const LINE_HEIGHT = 1.35
const TEXT_SIZE_EM: Record<string, number> = { s: 1.125, m: 1.5, l: 2.25, xl: 2.75 }
const LABEL_SIZE_EM: Record<string, number> = { s: 1.125, m: 1.375, l: 1.625, xl: 2 }
/**
 * Average glyph width as a fraction of the font size, set HIGH on purpose: an estimate must err toward "this takes
 * more room", because under-estimating produces exactly the overlap this module exists to prevent.
 */
const AVERAGE_GLYPH_EM: Record<string, number> = { draw: 0.65, sans: 0.6, serif: 0.6, mono: 0.62 }
/** Word wrapping wastes some of every line. */
const WRAP_SLACK = 1.15
const LABEL_PADDING = 16

export function textFontPx(size: unknown): number {
	return BASE_FONT_PX * (TEXT_SIZE_EM[String(size)] ?? TEXT_SIZE_EM.m)
}

export function labelFontPx(size: unknown): number {
	return BASE_FONT_PX * (LABEL_SIZE_EM[String(size)] ?? LABEL_SIZE_EM.m)
}

/** The paragraphs of a tldraw rich-text document, as plain strings (an empty paragraph is an empty string). */
export function richTextParagraphs(value: unknown): string[] {
	const out: string[] = []
	function inline(node: unknown): string {
		if (!node || typeof node !== 'object') return ''
		const item = node as Record<string, unknown>
		if (item.type === 'text' && typeof item.text === 'string') return item.text
		if (item.type === 'hardBreak') return '\n'
		return Array.isArray(item.content) ? item.content.map(inline).join('') : ''
	}
	function block(node: unknown) {
		if (!node || typeof node !== 'object') return
		const item = node as Record<string, unknown>
		const children = Array.isArray(item.content) ? item.content : []
		if (item.type === 'doc') { children.forEach(block); return }
		if (children.some((child) => child && typeof child === 'object' && ['paragraph', 'bulletList', 'orderedList', 'listItem', 'codeBlock', 'heading', 'blockquote'].includes(String((child as Record<string, unknown>).type)))) {
			children.forEach(block)
			return
		}
		for (const line of inline(item).split('\n')) out.push(line)
	}
	block(value)
	return out.length > 0 ? out : ['']
}

export interface TextEstimate {
	w: number
	h: number
	lines: number
}

/**
 * A conservative size for text that no browser has measured. `fixedWidth` is the wrap width (a text shape with
 * `autoSize: false`, or a geo label's available width); without it the text does not wrap, which is how tldraw sizes
 * `autoSize` text, so each paragraph is one line and the width is the longest one.
 */
export function estimateText(paragraphs: readonly string[], options: { fontPx: number; font?: unknown; fixedWidth?: number }): TextEstimate {
	const glyph = options.fontPx * (AVERAGE_GLYPH_EM[String(options.font)] ?? AVERAGE_GLYPH_EM.draw)
	const lineHeight = options.fontPx * LINE_HEIGHT
	let lines = 0
	let longest = 0
	for (const paragraph of paragraphs) {
		const natural = paragraph.length * glyph
		longest = Math.max(longest, natural)
		lines += options.fixedWidth === undefined ? 1 : Math.max(1, Math.ceil((natural * WRAP_SLACK) / Math.max(1, options.fixedWidth)))
	}
	return { w: options.fixedWidth ?? Math.max(options.fontPx, Math.ceil(longest) + 1), h: Math.max(options.fontPx, Math.ceil(lines * lineHeight)), lines }
}

/** Estimated height a geo label needs inside a box of the given width, padding included. */
export function estimateLabelNeed(paragraphs: readonly string[], boxWidth: number, options: { size: unknown; font: unknown }): number {
	const fontPx = labelFontPx(options.size)
	if (paragraphs.every((line) => line.length === 0)) return 0
	const wrapped = estimateText(paragraphs, { fontPx, font: options.font, fixedWidth: Math.max(1, boxWidth - LABEL_PADDING * 2) })
	return wrapped.h + LABEL_PADDING * 2
}
