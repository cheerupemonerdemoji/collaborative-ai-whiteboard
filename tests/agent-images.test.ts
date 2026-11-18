import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isMachineRoute } from '../server/host-policy'
import { IMAGE_ASSET_ID, IMAGE_LIMITS, imageContentType, inspectImage, readStoredImage } from '../server/image-artifacts'
import { getRoomHandle } from '../server/rooms'
import { createClient } from '../server/token-store.mjs'
import { isSafeLink } from '../shared/media-actions'
import { createAcceptanceFixture, type AcceptanceFixture } from './helpers/acceptance-fixture'

;(globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame ??= (callback: (time: number) => void) => setTimeout(() => callback(Date.now()), 16)
;(globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame ??= (id: ReturnType<typeof setTimeout>) => clearTimeout(id)

/**
 * Agent images and links (the agent images and links design note): an image is uploaded as bytes, inspected, stored under
 * its own hash and placed with `create_image`; a link is a plain https address on a shape that can hold one.
 */

/** Tiny but structurally valid files. `seed` makes the bytes (and so the hash) differ without changing the picture's size. */
function png(width = 40, height = 20, seed = 0): Buffer {
	const bytes = Buffer.alloc(33 + 4)
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0)
	bytes.writeUInt32BE(13, 8); bytes.write('IHDR', 12, 'latin1')
	bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20)
	bytes[24] = 8; bytes[25] = 2
	bytes.writeUInt32BE(seed, 33)
	return bytes
}
function jpeg(width = 40, height = 20): Buffer {
	const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x03, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1])
	return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46]), sof, Buffer.from([0xff, 0xd9])])
}
function gif(width = 40, height = 20): Buffer {
	const bytes = Buffer.alloc(14)
	bytes.write('GIF89a', 0, 'latin1'); bytes.writeUInt16LE(width, 6); bytes.writeUInt16LE(height, 8)
	return bytes
}
function webp(width = 40, height = 20): Buffer {
	const bytes = Buffer.alloc(30)
	bytes.write('RIFF', 0, 'latin1'); bytes.writeUInt32LE(22, 4); bytes.write('WEBPVP8X', 8, 'latin1'); bytes.writeUInt32LE(10, 16)
	bytes.writeUIntLE(width - 1, 24, 3); bytes.writeUIntLE(height - 1, 27, 3)
	return bytes
}
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

describe('inspecting an image', () => {
	it('accepts PNG, JPEG, GIF and WebP by their bytes, names them by hash, and reads their real size', () => {
		const cases = [['png', png(120, 60)], ['jpg', jpeg(300, 200)], ['gif', gif(64, 48)], ['webp', webp(500, 250)]] as const
		for (const [extension, bytes] of cases) {
			const result = inspectImage(bytes)
			expect(result.extension).toBe(extension)
			expect(result.assetId).toBe(`img-${sha(bytes)}.${extension}`)
			expect(IMAGE_ASSET_ID.test(result.assetId)).toBe(true)
			expect(imageContentType(result.assetId)).toBe(result.mimeType)
		}
		expect(inspectImage(png(120, 60))).toMatchObject({ width: 120, height: 60, mimeType: 'image/png' })
		expect(inspectImage(jpeg(300, 200))).toMatchObject({ width: 300, height: 200, mimeType: 'image/jpeg' })
		expect(inspectImage(gif(64, 48))).toMatchObject({ width: 64, height: 48, mimeType: 'image/gif' })
		expect(inspectImage(webp(500, 250))).toMatchObject({ width: 500, height: 250, mimeType: 'image/webp' })
	})

	it('refuses SVG, with the reason, and anything that is not one of the four kinds', () => {
		expect(() => inspectImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).toThrow(/SVG files are not accepted/)
		expect(() => inspectImage(Buffer.from('<?xml version="1.0"?><svg/>'))).toThrow(/SVG files are not accepted/)
		expect(() => inspectImage(Buffer.from('<html><body>hello</body></html>'))).toThrow(/not a PNG, JPEG, GIF or WebP/)
		expect(() => inspectImage(Buffer.from('MZ\u0090\u0000 not an image'))).toThrow(/not a PNG, JPEG, GIF or WebP/)
		expect(() => inspectImage(Buffer.alloc(0))).toThrow(/request body/)
		expect(() => inspectImage('a string, not bytes')).toThrow(/request body/)
	})

	it('trusts the bytes, not the claim: a file with a PNG name or type but other contents is refused', () => {
		// The route never reads a name or content type, so the only thing to test is that the bytes decide.
		expect(() => inspectImage(Buffer.from('GIF89 pretending'))).toThrow()
		expect(inspectImage(gif()).extension).toBe('gif')
	})

	it('caps size, dimensions and pixel count, and refuses a damaged header', () => {
		expect(() => inspectImage(Buffer.concat([png(), Buffer.alloc(IMAGE_LIMITS.maxBytes)]))).toThrow(/larger than the 4 MB limit/)
		expect(() => inspectImage(png(IMAGE_LIMITS.maxDimension + 1, 10))).toThrow(/larger than 8192/)
		expect(() => inspectImage(png(10, IMAGE_LIMITS.maxDimension + 1))).toThrow(/larger than 8192/)
		expect(() => inspectImage(png(8_000, 8_000))).toThrow(/too many pixels/)
		expect(() => inspectImage(png(0, 10))).toThrow(/no usable size/)
		expect(() => inspectImage(png(10, 10).subarray(0, 20))).toThrow(/damaged/)
		expect(() => inspectImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46]))).toThrow(/damaged/)
		expect(() => inspectImage(Buffer.from('RIFF0000WEBPVP9 ........................'))).toThrow()
	})

	it('reads a stored image back only if its name, hash and contents all agree', () => {
		const directory = mkdtempSync(join(tmpdir(), 'image-store-'))
		try {
			const good = png(30, 15, 1)
			const { assetId } = inspectImage(good)
			writeFileSync(join(directory, assetId), good)
			expect(readStoredImage(directory, assetId)).toMatchObject({ width: 30, height: 15, mimeType: 'image/png' })
			// A different image placed under another image's name must not be trusted.
			writeFileSync(join(directory, assetId), png(31, 15, 2))
			expect(readStoredImage(directory, assetId)).toBeNull()
			expect(readStoredImage(directory, 'img-nothing.png')).toBeNull()
			expect(readStoredImage(directory, `img-${'0'.repeat(64)}.png`)).toBeNull()
			expect(readStoredImage(directory, '../etc/passwd')).toBeNull()
		} finally { rmSync(directory, { recursive: true, force: true }) }
	})
})

describe('which links a shape may carry', () => {
	it('accepts a plain https address and nothing else', () => {
		expect(isSafeLink('https://example.com')).toBe(true)
		expect(isSafeLink('https://whiteboard.example.com/login?x=1#frag')).toBe(true)
		for (const bad of ['http://example.com', 'javascript:alert(1)', 'data:text/html,<b>x</b>', 'file:///etc/passwd', 'mailto:a@b.c', 'ftp://example.com',
			'https://user:pass@example.com', 'https://user@example.com', 'https://exa mple.com', ' https://example.com', 'https://example.com\n', '//example.com', 'example.com', '', 'https://',
			`https://example.com/${'a'.repeat(2_000)}`]) expect(isSafeLink(bad), JSON.stringify(bad.slice(0, 40))).toBe(false)
	})
})

describe('the image route and the image actions', () => {
	let f: AcceptanceFixture
	let storeDirectory: string
	let storeFile: string
	beforeEach(async () => {
		f = await createAcceptanceFixture({ rateLimits: { upload: { limit: 10_000, windowMs: 60_000 }, write: { limit: 10_000, windowMs: 60_000 } } })
		storeDirectory = mkdtempSync(join(tmpdir(), 'agent-images-store-'))
		storeFile = join(storeDirectory, 'api-tokens.json')
		process.env.CANVAS_API_TOKENS_FILE = storeFile
	})
	afterEach(async () => { await f.cleanup(); rmSync(storeDirectory, { recursive: true, force: true }) })

	const OCTET = { 'content-type': 'application/octet-stream' }
	const token = async (access: 'read' | 'read-write' = 'read-write') => (await createClient({ file: storeFile, name: `agent-${access}`, rooms: [f.boardId], access })).token
	const upload = (bearer: string | null, body: Buffer | string, boardId = f.boardId) =>
		f.app.inject({ method: 'POST', url: `/api/boards/${boardId}/images`, headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...OCTET }, payload: body })
	const act = (bearer: string, actions: unknown[], pageId?: string) =>
		f.app.inject({ method: 'POST', url: `/api/rooms/${f.boardId}/actions`, headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, payload: { ...(pageId ? { pageId } : {}), actions } as never })
	const records = () => getRoomHandle(f.boardId).room.getCurrentSnapshot().documents.map((entry) => entry.state as unknown as Record<string, any>)
	const imageFiles = () => readdirSync(join(f.directory, 'assets')).filter((name) => name.startsWith('img-') && !name.endsWith('.tmp'))

	it('is routed on the machine hostname, and only as POST to one board', () => {
		expect(isMachineRoute('POST', '/api/boards/board-x/images')).toBe(true)
		expect(isMachineRoute('GET', '/api/boards/board-x/images')).toBe(false)
		expect(isMachineRoute('POST', '/api/boards/board-x/images/extra')).toBe(false)
	})

	describe('uploading', () => {
		it('stores a valid image for a credential with write access, under its hash, and says how to place it', async () => {
			const bytes = png(200, 100)
			const response = await upload(await token(), bytes)
			expect(response.statusCode).toBe(201)
			expect(response.json().image).toEqual({ assetId: `img-${sha(bytes)}.png`, mimeType: 'image/png', width: 200, height: 100, bytes: bytes.length })
			expect(imageFiles()).toEqual([`img-${sha(bytes)}.png`])
		})

		it('treats the same bytes sent twice as one stored file', async () => {
			const t = await token()
			const bytes = jpeg(50, 50)
			expect((await upload(t, bytes)).statusCode).toBe(201)
			expect((await upload(t, bytes)).statusCode).toBe(201)
			expect(imageFiles()).toHaveLength(1)
		})

		it('refuses a read-only credential, no credential, a made-up one and a credential for another board, storing nothing', async () => {
			expect([401, 403]).toContain((await upload(await token('read'), png())).statusCode)
			expect((await upload(null, png())).statusCode).toBe(401)
			expect((await upload('not-a-real-token-at-all-0123456789', png())).statusCode).toBe(401)
			expect([401, 403, 404]).toContain((await upload(await token(), png(), 'some-other-board')).statusCode)
			expect(imageFiles()).toEqual([])
		})

		it('refuses SVG, other files and oversize ones with the reason, storing nothing', async () => {
			const t = await token()
			const svg = await upload(t, '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>')
			expect(svg.statusCode).toBe(422)
			expect(svg.json().error).toMatch(/SVG files are not accepted/)
			expect((await upload(t, 'just some text')).statusCode).toBe(422)
			expect((await upload(t, Buffer.concat([png(), Buffer.alloc(IMAGE_LIMITS.maxBytes)]))).statusCode).toBe(413)
			expect((await upload(t, png(IMAGE_LIMITS.maxDimension + 1, 4))).statusCode).toBe(422)
			expect(imageFiles()).toEqual([])
		})

		it('lets an editor upload and refuses a viewer, an outsider and an anonymous caller', async () => {
			const as = (who: { request: AcceptanceFixture['owner']['request'] }, bytes: Buffer) => who.request('POST', `/api/boards/${f.boardId}/images`, bytes, OCTET)
			expect((await as(f.editor, png(10, 10, 1))).statusCode).toBe(201)
			expect((await as(f.viewer, png(10, 10, 2))).statusCode).toBe(403)
			expect((await as(f.nonmember, png(10, 10, 3))).statusCode).toBe(404)
			expect((await as(f.anonymous, png(10, 10, 4))).statusCode).toBe(401)
			expect(imageFiles()).toHaveLength(1)
		})

		it('stops at the per-board image limit without writing past it', async () => {
			const t = await token()
			for (let n = 0; n < IMAGE_LIMITS.maxImagesPerBoard; n += 1) expect((await upload(t, png(10, 10, n))).statusCode, `image ${n}`).toBe(201)
			const over = await upload(t, png(10, 10, 9_999))
			expect(over.statusCode).toBe(422)
			expect(over.json().error).toMatch(/image limit/)
			expect(imageFiles()).toHaveLength(IMAGE_LIMITS.maxImagesPerBoard)
			// An image already on the board is still accepted: it costs nothing.
			expect((await upload(t, png(10, 10, 0))).statusCode).toBe(201)
		}, 60_000)

		it('cannot be bypassed through the general upload route, which refuses img- names', async () => {
			const response = await f.owner.request('POST', `/api/boards/${f.boardId}/uploads/img-${'a'.repeat(64)}.png`, png(), OCTET)
			expect(response.statusCode).toBe(400)
			expect(imageFiles()).toEqual([])
		})
	})

	describe('serving', () => {
		it('serves a stored image as exactly its own type, never sniffed, to a member', async () => {
			const bytes = png(60, 30)
			const { assetId } = (await upload(await token(), bytes)).json().image
			const response = await f.owner.get(`/api/boards/${f.boardId}/assets/${assetId}`)
			expect(response.statusCode).toBe(200)
			expect(response.headers['content-type']).toBe('image/png')
			expect(response.headers['x-content-type-options']).toBe('nosniff')
			expect(response.headers['content-security-policy']).toBe("default-src 'none'")
			expect((await f.nonmember.get(`/api/boards/${f.boardId}/assets/${assetId}`)).statusCode).toBe(404)
			expect((await f.anonymous.get(`/api/boards/${f.boardId}/assets/${assetId}`)).statusCode).toBe(401)
		})
	})

	describe('create_image', () => {
		const place = async (t: string, bytes: Buffer, extra: Record<string, unknown> = {}) => {
			const { assetId } = (await upload(t, bytes)).json().image
			return { assetId, response: await act(t, [{ tool: 'create_image', id: 'shape:pic', assetId, x: 100, y: 200, ...extra }]) }
		}

		it('places an uploaded image, keeping its proportions, with an asset record the browser can load', async () => {
			const t = await token()
			const { assetId, response } = await place(t, png(400, 200), { width: 300, altText: 'The Share button in the top bar' })
			expect(response.statusCode).toBe(200)
			const shape = records().find((record) => record.id === 'shape:pic')!
			expect(shape).toMatchObject({ typeName: 'shape', type: 'image', x: 100, y: 200 })
			expect(shape.props).toMatchObject({ w: 300, h: 150, url: '', altText: 'The Share button in the top bar' })
			const asset = records().find((record) => record.id === shape.props.assetId)!
			expect(asset).toMatchObject({ typeName: 'asset', type: 'image' })
			expect(asset.props).toMatchObject({ w: 400, h: 200, mimeType: 'image/png', src: `/api/boards/${f.boardId}/assets/${assetId}` })
			// The canvas read lists it like any other shape.
			const read = await f.app.inject({ method: 'GET', url: `/api/rooms/${f.boardId}/canvas`, headers: { authorization: `Bearer ${t}` } })
			expect(read.json().objects.find((object: { id: string }) => object.id === 'shape:pic')).toMatchObject({ type: 'image', width: 300, height: 150 })
		})

		it('shows an image at its own width, up to a limit, when no width is given', async () => {
			const t = await token()
			expect((await place(t, png(500, 250))).response.statusCode).toBe(200)
			expect(records().find((record) => record.id === 'shape:pic')!.props).toMatchObject({ w: 500, h: 250 })
			const wide = await act(t, [{ tool: 'create_image', id: 'shape:wide', assetId: (await upload(t, png(2_000, 1_000))).json().image.assetId, x: 0, y: 900 }])
			expect(wide.statusCode).toBe(200)
			expect(records().find((record) => record.id === 'shape:wide')!.props).toMatchObject({ w: 800, h: 400 })
		})

		it('shares one asset record between pictures of the same file', async () => {
			const t = await token()
			const { assetId } = (await upload(t, png(100, 100))).json().image
			expect((await act(t, [{ tool: 'create_image', id: 'shape:a', assetId, x: 0, y: 0 }, { tool: 'create_image', id: 'shape:b', assetId, x: 200, y: 0 }])).statusCode).toBe(200)
			expect(records().filter((record) => record.typeName === 'asset' && record.props.name === assetId)).toHaveLength(1)
		})

		it('refuses an image that was never uploaded to this board, a malformed name and a duplicate shape id', async () => {
			const t = await token()
			const ghost = `img-${'1'.repeat(64)}.png`
			expect((await act(t, [{ tool: 'create_image', id: 'shape:x', assetId: ghost, x: 0, y: 0 }])).statusCode).toBe(404)
			// A real, valid file on disk that this board never registered is just as unreachable.
			const stray = png(10, 10, 77)
			const strayId = inspectImage(stray).assetId
			writeFileSync(join(f.directory, 'assets', strayId), stray)
			expect((await act(t, [{ tool: 'create_image', id: 'shape:y', assetId: strayId, x: 0, y: 0 }])).statusCode).toBe(404)
			expect((await act(t, [{ tool: 'create_image', id: 'shape:z', assetId: '../../etc/passwd', x: 0, y: 0 }])).statusCode).toBe(422)
			expect((await act(t, [{ tool: 'create_image', id: 'shape:z', assetId: 'cad-abc.png', x: 0, y: 0 }])).statusCode).toBe(422)
			const { assetId } = (await upload(t, png(20, 20))).json().image
			expect((await act(t, [{ tool: 'create_image', id: 'shape:dup', assetId, x: 0, y: 0 }])).statusCode).toBe(200)
			expect((await act(t, [{ tool: 'create_image', id: 'shape:dup', assetId, x: 0, y: 0 }])).statusCode).toBe(409)
			expect(records().filter((record) => record.typeName === 'shape' && record.type === 'image').map((record) => record.id)).toEqual(['shape:dup'])
		})

		it('refuses an image whose stored file was swapped for something else', async () => {
			const t = await token()
			const { assetId } = (await upload(t, png(20, 20))).json().image
			writeFileSync(join(f.directory, 'assets', assetId), '<svg onload="alert(1)"/>')
			const response = await act(t, [{ tool: 'create_image', id: 'shape:swapped', assetId, x: 0, y: 0 }])
			expect(response.statusCode).toBe(422)
			expect(records().some((record) => record.id === 'shape:swapped')).toBe(false)
		})

		it('refuses a read-only credential, and changes nothing when any action in the request fails', async () => {
			const t = await token()
			const { assetId } = (await upload(t, png(20, 20))).json().image
			expect([401, 403]).toContain((await act(await token('read'), [{ tool: 'create_image', id: 'shape:ro', assetId, x: 0, y: 0 }])).statusCode)
			const before = records().length
			const failed = await act(t, [{ tool: 'create_image', id: 'shape:good', assetId, x: 0, y: 0 }, { tool: 'create_image', id: 'shape:bad', assetId: `img-${'2'.repeat(64)}.png`, x: 0, y: 0 }])
			expect(failed.statusCode).toBe(404)
			expect(records()).toHaveLength(before)
		})

		it('puts an optional https link on the picture, and refuses any other', async () => {
			const t = await token()
			const { assetId } = (await upload(t, png(20, 20))).json().image
			expect((await act(t, [{ tool: 'create_image', id: 'shape:linked', assetId, x: 0, y: 0, url: 'https://example.com/docs' }])).statusCode).toBe(200)
			expect(records().find((record) => record.id === 'shape:linked')!.props.url).toBe('https://example.com/docs')
			for (const url of ['http://example.com', 'javascript:alert(1)', 'https://u:p@example.com']) {
				expect((await act(t, [{ tool: 'create_image', id: 'shape:no', assetId, x: 0, y: 0, url }])).statusCode, url).toBe(422)
			}
		})
	})

	describe('set_link', () => {
		const makeShapes = (t: string) => act(t, [
			{ tool: 'create_shape', id: 'shape:box', type: 'rectangle', text: 'Sign in', x: 0, y: 0, width: 200, height: 100 },
			{ tool: 'create_text', id: 'shape:words', text: 'Plain text', x: 0, y: 300 },
		])

		it('sets a link on a rectangle, and clears it with null', async () => {
			const t = await token()
			await makeShapes(t)
			expect((await act(t, [{ tool: 'set_link', id: 'shape:box', url: 'https://whiteboard.example.com/login' }])).statusCode).toBe(200)
			expect(records().find((record) => record.id === 'shape:box')!.props.url).toBe('https://whiteboard.example.com/login')
			expect((await act(t, [{ tool: 'set_link', id: 'shape:box', url: null }])).statusCode).toBe(200)
			expect(records().find((record) => record.id === 'shape:box')!.props.url).toBe('')
		})

		it('works on an image too', async () => {
			const t = await token()
			const { assetId } = (await upload(t, png(20, 20))).json().image
			await act(t, [{ tool: 'create_image', id: 'shape:pic2', assetId, x: 0, y: 0 }])
			expect((await act(t, [{ tool: 'set_link', id: 'shape:pic2', url: 'https://example.com' }])).statusCode).toBe(200)
			expect(records().find((record) => record.id === 'shape:pic2')!.props.url).toBe('https://example.com')
		})

		it('says plainly that a text box cannot hold a link, and refuses an unknown shape', async () => {
			const t = await token()
			await makeShapes(t)
			const response = await act(t, [{ tool: 'set_link', id: 'shape:words', url: 'https://example.com' }])
			expect(response.statusCode).toBe(422)
			expect(response.json().error).toMatch(/text box cannot hold one/)
			expect((await act(t, [{ tool: 'set_link', id: 'shape:nowhere', url: 'https://example.com' }])).statusCode).toBe(404)
		})

		it('refuses every link that is not a plain https address, leaving the shape unchanged', async () => {
			const t = await token()
			await makeShapes(t)
			for (const url of ['http://example.com', 'javascript:alert(1)', 'data:text/html,x', 'https://u:p@example.com', 'https://a b.com', `https://example.com/${'a'.repeat(2_000)}`]) {
				expect((await act(t, [{ tool: 'set_link', id: 'shape:box', url }])).statusCode, url.slice(0, 30)).toBe(422)
			}
			expect(records().find((record) => record.id === 'shape:box')!.props.url).toBe('')
		})

		it('is refused for a read-only credential', async () => {
			const t = await token()
			await makeShapes(t)
			expect([401, 403]).toContain((await act(await token('read'), [{ tool: 'set_link', id: 'shape:box', url: 'https://example.com' }])).statusCode)
			expect(existsSync(storeFile)).toBe(true)
		})
	})
})
