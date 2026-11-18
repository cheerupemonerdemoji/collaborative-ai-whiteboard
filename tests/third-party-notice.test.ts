import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/*
 * The browser bundle contains three.js, and its MIT licence requires the copyright and permission notice to travel with
 * the software. The minified bundle carries no licence comment, so `public/third-party-licenses.txt` (copied to
 * dist/client by Vite and served as a static file) is what ships the notice. These tests keep that file honest: it must
 * hold the installed package's licence text verbatim and name the installed version, so a dependency bump that changes
 * either fails here instead of shipping a stale notice.
 */
const root = join(__dirname, '..')
const read = (path: string) => readFileSync(join(root, path), 'utf8').replace(/\r\n/g, '\n')

describe('three.js licence notice shipped with the bundle', () => {
	const notice = read('public/third-party-licenses.txt')
	const licence = read('node_modules/three/LICENSE').trim()
	const installed = JSON.parse(read('node_modules/three/package.json')) as { version: string; license: string }

	it('contains the installed three package licence text verbatim', () => {
		expect(installed.license).toBe('MIT')
		expect(notice).toContain(licence)
	})

	it('names the installed three version, so a version bump forces a review of the notice', () => {
		expect(notice).toContain(`three (three.js) ${installed.version} - MIT License`)
	})

	it('reaches dist/client: the production Vite config keeps the default public directory', () => {
		expect(read('vite.selfhost.config.ts')).not.toMatch(/publicDir/)
	})
})
