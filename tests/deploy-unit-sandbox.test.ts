/**
 * The service unit is hardened with ProtectSystem=strict and ProtectHome=read-only, so every directory the service writes has to be listed in
 * ReadWritePaths. On 2026-10-26 the token store directory was not, and creating or rotating an agent failed with EROFS (HTTP 500) in production.
 * These checks read the unit as written and fail if a directory the service writes is no longer writable under that sandbox.
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path/posix'
import { describe, expect, it } from 'vitest'

const unit = readFileSync(new URL('../deploy/collaborative-ai-canvas.service', import.meta.url), 'utf8')

/** The values of every `Key=value` line in the [Service] section (later lines for the same key accumulate, as systemd does for ReadWritePaths). */
function lines(key: string): string[] {
	return unit.split(/\r?\n/).filter((line) => line.startsWith(`${key}=`)).map((line) => line.slice(key.length + 1).trim())
}
const environment = (name: string) => {
	const entry = lines('Environment').find((value) => value.startsWith(`${name}=`))
	return entry ? entry.slice(name.length + 1) : undefined
}
const writable = lines('ReadWritePaths').flatMap((value) => value.split(/\s+/)).filter(Boolean)
const isWritable = (path: string) => writable.some((root) => { const base = resolve(root); const target = resolve(path); return target === base || target.startsWith(base.endsWith(sep) ? base : base + sep) })

describe('the service unit sandbox', () => {
	it('keeps the hardening that makes the writable paths matter', () => {
		expect(lines('ProtectSystem')).toEqual(['strict'])
		expect(lines('ProtectHome')).toEqual(['read-only'])
		expect(lines('NoNewPrivileges')).toEqual(['true'])
	})

	it('lets the service write the data directory', () => {
		const data = environment('CANVAS_DATA_DIR')
		expect(data).toBeTruthy()
		expect(isWritable(data!)).toBe(true)
	})

	it('lets the service write the token store directory (lock file and backups sit beside the store)', () => {
		const store = environment('CANVAS_API_TOKENS_FILE')
		expect(store).toBeTruthy()
		expect(isWritable(dirname(store!))).toBe(true)
		expect(isWritable(`${store}.lock`)).toBe(true)
	})

	it('does not widen the writable set beyond those two directories', () => {
		expect(writable.sort()).toEqual([dirname(environment('CANVAS_API_TOKENS_FILE')!), environment('CANVAS_DATA_DIR')!].sort())
	})
})
