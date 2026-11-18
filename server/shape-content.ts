import { createHash } from 'node:crypto'
import { toRichText } from '@tldraw/tlschema'
import { TEXT_PREVIEW_LIMIT, type LossReason } from '../shared/ai'

/**
 * What a shape's text really is, and whether a canvas read can show it exactly.
 *
 * The canvas read (`GET /canvas`) has always been a preview: it joins every text run with a space (so paragraph breaks vanish), ignores
 * formatting, and stops at 500 characters. That is fine for orientation and dangerous as the source of a replacement, because
 * `update_text` writes plain paragraphs over the authoritative rich text. Everything here exists so the API can SAY when the
 * preview is not the content, and so a replacement can be refused when the caller only ever saw the preview.
 *
 * "Lossy" is deliberately not the same as "long": a three-line, bold-formatted note under 500 characters is lossy too.
 */

/** Text-bearing shape types whose text the API can replace and recover. Other shapes carry labels this code does not claim to round-trip. */
export const TEXT_CONTENT_TYPES: ReadonlySet<string> = new Set(['geo', 'text', 'note'])

interface RichNode {
	type?: unknown
	text?: unknown
	attrs?: unknown
	marks?: unknown
	content?: unknown
}

const isNode = (value: unknown): value is RichNode => typeof value === 'object' && value !== null && !Array.isArray(value)
const children = (node: RichNode): RichNode[] => (Array.isArray(node.content) ? node.content.filter(isNode) : [])

/** Key-sorted JSON, so equal structures always serialise identically. */
export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
	if (value !== null && typeof value === 'object') {
		const record = value as Record<string, unknown>
		return `{${Object.keys(record).sort().filter((key) => record[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
	}
	return JSON.stringify(value) ?? 'null'
}

/**
 * The digest of the COMPLETE stored rich-text structure (marks, attributes and all), not of its flattened text. It is returned only by the
 * lossless shape read, never by a lossy canvas read, so a caller can only present it by having fetched the full content.
 */
export function contentDigest(richText: unknown): string {
	return createHash('sha256').update(canonicalJson(richText)).digest('hex')
}

/** The paragraphs of a rich text, in order. Empty paragraphs are kept: they are blank lines. */
export function paragraphsOf(richText: unknown): string[] {
	const out: string[] = []
	const walk = (node: RichNode) => {
		if (node.type === 'paragraph') {
			out.push(children(node).map((child) => (child.type === 'hardBreak' ? '\n' : typeof child.text === 'string' ? child.text : '')).join(''))
			return
		}
		children(node).forEach(walk)
	}
	if (isNode(richText)) walk(richText)
	return out
}

/** The full plain text, paragraphs separated by a newline. Not the legacy preview. */
export function plainContent(richText: unknown): { text: string; paragraphs: number } {
	const paragraphs = paragraphsOf(richText)
	return { text: paragraphs.join('\n'), paragraphs: paragraphs.length }
}

/** Every text run joined by a single space: the exact string the canvas read has always built before cutting it. */
function flattenedRuns(richText: unknown): string {
	const runs: string[] = []
	const walk = (node: RichNode) => {
		if (node.type === 'text' && typeof node.text === 'string') runs.push(node.text)
		children(node).forEach(walk)
	}
	if (isNode(richText)) walk(richText)
	return runs.join(' ')
}

/** The legacy `text` field of a canvas read, byte for byte as it was. */
export function legacyPreview(richText: unknown): string {
	return flattenedRuns(richText).slice(0, TEXT_PREVIEW_LIMIT)
}

/**
 * Formatting a plain-text replacement would drop: marks, any node other than document / paragraph / text, and any attribute other than the
 * browser's default paragraph direction (which carries no meaning and which `toRichText` never writes).
 */
function formattingOf(richText: unknown): boolean {
	let found = false
	const walk = (node: RichNode, isRoot: boolean) => {
		if (found) return
		if (Array.isArray(node.marks) && node.marks.length > 0) found = true
		if (!isRoot && node.type !== 'paragraph' && node.type !== 'text') found = true
		if (isRoot && node.type !== 'doc') found = true
		if (isNode(node.attrs)) {
			const keys = Object.keys(node.attrs).filter((key) => !(key === 'dir' && (node.attrs as Record<string, unknown>).dir === 'auto'))
			if (keys.length > 0) found = true
		}
		children(node).forEach((child) => walk(child, false))
	}
	if (isNode(richText)) walk(richText, true)
	else found = true
	return found
}

/** Drops the attributes that carry no meaning, so a browser-authored plain paragraph compares equal to `toRichText`'s. */
function normalised(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(normalised)
	if (!isNode(value)) return value
	const out: Record<string, unknown> = {}
	for (const [key, entry] of Object.entries(value)) {
		if (key === 'attrs' && isNode(entry)) {
			const kept = Object.fromEntries(Object.entries(entry).filter(([name, v]) => !(name === 'dir' && v === 'auto')))
			if (Object.keys(kept).length > 0) out.attrs = kept
			continue
		}
		out[key] = normalised(entry)
	}
	return out
}

export interface ContentAssessment {
	/** Characters of full plain text (paragraphs separated by one newline). */
	originalLength: number
	/** The legacy preview was cut at the limit. */
	textTruncated: boolean
	/** The preview is not exactly the content: it was cut, or structure was omitted, or the content cannot be rebuilt from it. */
	contentLossy: boolean
	lossReasons: LossReason[]
}

export function assessContent(richText: unknown): ContentAssessment {
	const { text, paragraphs } = plainContent(richText)
	const textTruncated = flattenedRuns(richText).length > TEXT_PREVIEW_LIMIT
	const reasons: LossReason[] = []
	if (textTruncated) reasons.push('truncated')
	if (paragraphs > 1) reasons.push('paragraph_structure_omitted')
	if (formattingOf(richText)) reasons.push('formatting_omitted')
	if (reasons.length === 0) {
		// A single plain paragraph. It is exact only if the preview rebuilds to the very same structure (for example, text split
		// into runs would not: the preview inserts a space between runs).
		const rebuilt = toRichText(legacyPreview(richText))
		if (canonicalJson(normalised(rebuilt)) !== canonicalJson(normalised(richText))) reasons.push('content_not_exactly_representable')
	}
	return { originalLength: text.length, textTruncated, contentLossy: reasons.length > 0, lossReasons: reasons }
}

/** The authoritative content of a text-bearing shape record, in full, for the lossless read and for History. */
export function contentOf(record: { type?: unknown; props?: unknown } | null | undefined) {
	const props = (record?.props ?? {}) as { richText?: unknown }
	if (!record || typeof record.type !== 'string' || !TEXT_CONTENT_TYPES.has(record.type) || !isNode(props.richText)) return null
	const { text, paragraphs } = plainContent(props.richText)
	return { type: record.type, text, paragraphs, originalLength: text.length, richText: props.richText, contentDigest: contentDigest(props.richText) }
}
