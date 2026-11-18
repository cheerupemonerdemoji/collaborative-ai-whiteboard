import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HttpError } from './http'

/**
 * Structural checks on an image an agent uploads, before a byte of it is stored (the agent images and links design note).
 *
 * What is trusted is the file's own bytes, never the client's word for its type: the declared content type and the
 * file name are ignored. Only PNG, JPEG, GIF and WebP are accepted. SVG is refused outright, because it is a document
 * that can carry script. Size and pixel count are capped so a small file cannot expand into a huge bitmap.
 *
 * These checks prove a file is the kind of image it claims to be and is within limits. They do not prove the picture is
 * appropriate, and they do not re-encode it. The asset route serves it with its own type, `nosniff` and a locked-down
 * Content-Security-Policy, so even a hostile file cannot run as anything but an image.
 */
export const IMAGE_LIMITS = {
	maxBytes: 4_000_000,
	maxDimension: 8_192,
	maxPixels: 36_000_000,
	maxImagesPerBoard: 100,
} as const

export const IMAGE_KINDS = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' } as const
export type ImageExtension = keyof typeof IMAGE_KINDS

export interface InspectedImage {
	assetId: string
	extension: ImageExtension
	mimeType: (typeof IMAGE_KINDS)[ImageExtension]
	sha256: string
	bytes: number
	width: number
	height: number
}

/** The only shape an agent-uploaded image's stored name can have. Content-addressed, so a name always says what its bytes are. */
export const IMAGE_ASSET_ID = /^img-([0-9a-f]{64})\.(png|jpg|gif|webp)$/

export function imageAssetId(sha256: string, extension: ImageExtension): string {
	return `img-${sha256}.${extension}`
}

export function imageContentType(assetId: string): string | null {
	const match = IMAGE_ASSET_ID.exec(assetId)
	return match ? IMAGE_KINDS[match[2] as ImageExtension] : null
}

function reject(message: string): never {
	throw new HttpError(422, message)
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function pngSize(bytes: Buffer): { width: number; height: number } {
	if (bytes.length < 33 || bytes.readUInt32BE(8) !== 13 || bytes.toString('latin1', 12, 16) !== 'IHDR') reject('This PNG file is damaged: its header is missing')
	return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

function gifSize(bytes: Buffer): { width: number; height: number } {
	if (bytes.length < 10) reject('This GIF file is too short')
	return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) }
}

const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])

function jpegSize(bytes: Buffer): { width: number; height: number } {
	let offset = 2
	while (offset + 4 <= bytes.length) {
		if (bytes[offset] !== 0xff) { offset += 1; continue }
		let marker = bytes[offset + 1]
		while (marker === 0xff && offset + 2 < bytes.length) { offset += 1; marker = bytes[offset + 1] }
		offset += 2
		// Markers with no length: SOI, EOI, TEM, restart markers.
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) continue
		if (offset + 2 > bytes.length) break
		const length = bytes.readUInt16BE(offset)
		if (length < 2) reject('This JPEG file is damaged')
		if (JPEG_SOF.has(marker)) {
			if (offset + 7 > bytes.length) break
			return { height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) }
		}
		offset += length
	}
	return reject('This JPEG file is damaged: its size could not be read')
}

function webpSize(bytes: Buffer): { width: number; height: number } {
	if (bytes.length < 30) reject('This WebP file is too short')
	const chunk = bytes.toString('latin1', 12, 16)
	if (chunk === 'VP8 ') {
		if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) reject('This WebP file is damaged')
		return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff }
	}
	if (chunk === 'VP8L') {
		if (bytes[20] !== 0x2f) reject('This WebP file is damaged')
		const bits = bytes.readUInt32LE(21)
		return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
	}
	if (chunk === 'VP8X') return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 }
	return reject('This WebP file is not a supported kind')
}

function detect(bytes: Buffer): { extension: ImageExtension; size: { width: number; height: number } } {
	if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return { extension: 'png', size: pngSize(bytes) }
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { extension: 'jpg', size: jpegSize(bytes) }
	const head = bytes.toString('latin1', 0, 6)
	if (head === 'GIF87a' || head === 'GIF89a') return { extension: 'gif', size: gifSize(bytes) }
	if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return { extension: 'webp', size: webpSize(bytes) }
	// SVG and anything else: say why, since "unsupported" alone would send an agent hunting.
	const text = bytes.toString('utf8', 0, 512).trimStart().toLowerCase()
	if (text.startsWith('<svg') || text.startsWith('<?xml') || text.includes('<svg')) reject('SVG files are not accepted because they can carry script. Send a PNG, JPEG, GIF or WebP image.')
	return reject('This is not a PNG, JPEG, GIF or WebP image')
}

/** Validates the bytes and returns the content-addressed name to store them under. Throws a 422/413 with a plain reason. */
export function inspectImage(bytes: unknown): InspectedImage & { data: Buffer } {
	if (!Buffer.isBuffer(bytes) || bytes.length === 0) reject('Send the image as the request body (Content-Type: application/octet-stream or image/*)')
	if (bytes.length > IMAGE_LIMITS.maxBytes) throw new HttpError(413, `This image is larger than the ${Math.round(IMAGE_LIMITS.maxBytes / 1_000_000)} MB limit`)
	const { extension, size } = detect(bytes)
	const { width, height } = size
	if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) reject('This image reports no usable size')
	if (width > IMAGE_LIMITS.maxDimension || height > IMAGE_LIMITS.maxDimension) reject(`This image is larger than ${IMAGE_LIMITS.maxDimension} x ${IMAGE_LIMITS.maxDimension} pixels`)
	if (width * height > IMAGE_LIMITS.maxPixels) reject('This image has too many pixels')
	const sha256 = createHash('sha256').update(bytes).digest('hex')
	return { assetId: imageAssetId(sha256, extension), extension, mimeType: IMAGE_KINDS[extension], sha256, bytes: bytes.length, width, height, data: bytes }
}

/**
 * Reads a stored image back and checks it again: the name must be a well-formed content-addressed image name, the file must
 * hash to it, and it must still pass the inspection. Sizes therefore come from disk, never from a client, and a file that is
 * not what its name says is never placed on a board. Returns null when the file is missing or fails any check.
 */
export function readStoredImage(directory: string, assetId: string): InspectedImage | null {
	const match = IMAGE_ASSET_ID.exec(assetId)
	if (!match) return null
	let bytes: Buffer
	try { bytes = readFileSync(join(directory, assetId)) } catch { return null }
	try {
		const inspected = inspectImage(bytes)
		if (inspected.sha256 !== match[1] || inspected.extension !== match[2]) return null
		const { data: _data, ...info } = inspected
		return info
	} catch { return null }
}
