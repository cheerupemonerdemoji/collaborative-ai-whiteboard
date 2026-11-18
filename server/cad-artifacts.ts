import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CAD_ARTIFACT_EXTENSIONS, CAD_LIMITS, cadArtifactId, type CadArtifactKind } from '../shared/cad-model'
import { HttpError } from './http'

/**
 * Structural checks on an uploaded CAD artifact, before a byte of it is stored.
 *
 * These do not prove a file is a good model. They prove it is the kind of file it claims to be, that it is within
 * size limits, and that a GLB cannot make a viewer fetch anything outside the board: no external buffers or images,
 * and no compression extension the viewer ships no decoder for. Every failure is a 422 with a plain reason.
 */
export const CAD_ARTIFACT_KINDS = Object.keys(CAD_ARTIFACT_EXTENSIONS) as CadArtifactKind[]

export interface InspectedArtifact {
	kind: CadArtifactKind
	assetId: string
	sha256: string
	bytes: number
}

const GLB_MAGIC = 0x46546c67
const GLB_JSON = 0x4e4f534a
const MAX_GLB_JSON_BYTES = 8_000_000
const MAX_GLB_COUNT = 50_000
/** Extensions the bundled viewer cannot decode (it ships no Draco, Meshopt or Basis decoder), or that pull outside data. */
const UNSUPPORTED_GLB_EXTENSIONS = new Set(['KHR_draco_mesh_compression', 'EXT_meshopt_compression', 'KHR_texture_basisu', 'EXT_texture_webp', 'KHR_materials_variants'])
const SUPPORTED_REQUIRED_EXTENSIONS = new Set([
	'KHR_materials_unlit', 'KHR_texture_transform', 'KHR_materials_emissive_strength',
	'KHR_mesh_quantization', 'KHR_materials_ior', 'KHR_materials_specular',
])

function reject(message: string): never {
	throw new HttpError(422, message)
}

function inspectGlb(bytes: Buffer): void {
	if (bytes.length < 28) reject('This is not a GLB file: it is too short')
	if (bytes.readUInt32LE(0) !== GLB_MAGIC) reject('This is not a GLB file: the header is missing')
	if (bytes.readUInt32LE(4) !== 2) reject('Only glTF 2.0 binary (GLB) files are supported')
	if (bytes.readUInt32LE(8) !== bytes.length) reject('This GLB file is truncated or its declared length is wrong')
	const jsonLength = bytes.readUInt32LE(12)
	if (bytes.readUInt32LE(16) !== GLB_JSON) reject('This GLB file does not start with a JSON chunk')
	if (jsonLength > MAX_GLB_JSON_BYTES || 20 + jsonLength > bytes.length) reject('This GLB file has an invalid JSON chunk')
	let gltf: Record<string, unknown>
	try { gltf = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8')) as Record<string, unknown> }
	catch { reject('This GLB file has unreadable metadata') }
	if (typeof gltf !== 'object' || gltf === null || Array.isArray(gltf)) reject('This GLB file has unreadable metadata')
	const asset = gltf.asset as { version?: unknown } | undefined
	if (asset?.version !== '2.0') reject('Only glTF 2.0 files are supported')
	for (const key of ['nodes', 'meshes', 'accessors', 'bufferViews', 'materials', 'images', 'textures']) {
		const list = gltf[key]
		if (list !== undefined && (!Array.isArray(list) || list.length > MAX_GLB_COUNT)) reject(`This GLB file has an invalid or oversized "${key}" list`)
	}
	if (!Array.isArray(gltf.meshes) || gltf.meshes.length === 0) reject('This GLB file contains no mesh to display')
	for (const buffer of (gltf.buffers as Array<{ uri?: unknown }> | undefined) ?? []) {
		if (buffer?.uri !== undefined) reject('This GLB file points at an external buffer. Export it as a self-contained GLB.')
	}
	for (const image of (gltf.images as Array<{ uri?: unknown }> | undefined) ?? []) {
		if (image?.uri !== undefined && !(typeof image.uri === 'string' && /^data:image\/(png|jpeg);base64,/.test(image.uri))) {
			reject('This GLB file points at an external image. Embed textures in the GLB.')
		}
	}
	const used = Array.isArray(gltf.extensionsUsed) ? gltf.extensionsUsed : []
	const required = Array.isArray(gltf.extensionsRequired) ? gltf.extensionsRequired : []
	for (const name of [...used, ...required]) {
		if (typeof name === 'string' && UNSUPPORTED_GLB_EXTENSIONS.has(name)) reject(`This GLB file uses ${name}, which the viewer cannot decode. Export it without compression.`)
	}
	for (const name of required) {
		if (typeof name !== 'string' || !SUPPORTED_REQUIRED_EXTENSIONS.has(name)) reject(`This GLB file requires an unsupported extension (${String(name)})`)
	}
}

function inspectStl(bytes: Buffer): void {
	if (bytes.length >= 84) {
		const triangles = bytes.readUInt32LE(80)
		if (triangles > 0 && 84 + triangles * 50 === bytes.length) return
	}
	const head = bytes.subarray(0, Math.min(bytes.length, 1_024)).toString('latin1')
	const tail = bytes.subarray(Math.max(0, bytes.length - 1_024)).toString('latin1')
	if (/^\s*solid/.test(head) && head.includes('facet') && /endsolid/.test(tail)) return
	reject('This is not a valid STL file')
}

function inspectStep(bytes: Buffer): void {
	const head = bytes.subarray(0, Math.min(bytes.length, 65_536))
	if (head.includes(0)) reject('This is not a STEP file: it contains binary data')
	if (!/^\s*ISO-10303-21;/.test(head.toString('latin1', 0, 256))) reject('This is not a STEP file: the ISO-10303-21 header is missing')
	if (!bytes.subarray(Math.max(0, bytes.length - 2_048)).toString('latin1').includes('END-ISO-10303-21;')) reject('This STEP file is truncated: it has no END-ISO-10303-21 trailer')
}

function inspectPng(bytes: Buffer): void {
	const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
	if (bytes.length < 33 || signature.some((value, index) => bytes[index] !== value)) reject('The thumbnail is not a PNG image')
	if (bytes.toString('latin1', 12, 16) !== 'IHDR') reject('The thumbnail PNG is malformed')
	const width = bytes.readUInt32BE(16)
	const height = bytes.readUInt32BE(20)
	if (width < 1 || height < 1 || width > 2_048 || height > 2_048) reject('The thumbnail must be at most 2048 x 2048 pixels')
}

/** Validates the bytes for the named kind and returns the content-addressed artifact id to store them under. */
export function inspectCadArtifact(kind: CadArtifactKind, bytes: unknown): InspectedArtifact & { data: Buffer } {
	if (!Buffer.isBuffer(bytes) || bytes.length === 0) reject('Send the file as the request body (application/octet-stream)')
	const limit = kind === 'thumbnail' ? CAD_LIMITS.maxThumbnailBytes : CAD_LIMITS.maxArtifactBytes
	if (bytes.length > limit) throw new HttpError(413, `This file is larger than the ${Math.round(limit / 1_000_000)} MB limit`)
	if (kind === 'glb') inspectGlb(bytes)
	else if (kind === 'stl') inspectStl(bytes)
	else if (kind === 'step') inspectStep(bytes)
	else inspectPng(bytes)
	const sha256 = createHash('sha256').update(bytes).digest('hex')
	return { kind, assetId: cadArtifactId(sha256, kind), sha256, bytes: bytes.length, data: bytes }
}

export interface ArtifactFileOps {
	writeFile: typeof writeFile
	rename: typeof rename
	unlink: typeof unlink
}

/**
 * Puts validated bytes at their content-addressed name, so the name never exists half-written.
 *
 * The bytes go to a private temporary name first and are renamed into place, which is atomic. A crash or a full disk
 * therefore leaves at worst a stray `.tmp` file, never a truncated file at a name that the rest of the system treats as
 * "already stored, by construction these bytes". Two uploads of the same bytes at once are both fine: whichever
 * rename lands second finds the file in place.
 */
export async function storeCadArtifact(directory: string, assetId: string, data: Buffer, ops: ArtifactFileOps = { writeFile, rename, unlink }): Promise<void> {
	const finalPath = join(directory, assetId)
	if (existsSync(finalPath)) return
	const temporary = `${finalPath}.${randomBytes(6).toString('hex')}.tmp`
	try {
		await ops.writeFile(temporary, data, { flag: 'wx' })
		try { await ops.rename(temporary, finalPath) }
		catch (error) { if (!existsSync(finalPath)) throw error }
	} finally {
		await ops.unlink(temporary).catch(() => {})
	}
}

export function cadContentType(assetId: string): string | null {
	if (assetId.endsWith('.glb')) return 'model/gltf-binary'
	if (assetId.endsWith('.png')) return 'image/png'
	if (assetId.endsWith('.stl')) return 'model/stl'
	if (assetId.endsWith('.step')) return 'application/step'
	return null
}

export function cleanFileName(value: unknown, fallback: string): string {
	const text = typeof value === 'string' ? value : ''
	const cleaned = text.replace(/[^A-Za-z0-9._ -]/g, '_').replace(/^\.+/, '').trim().slice(0, 120)
	return cleaned || fallback
}
