import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

type Client = {
	name: string
	tokenHash: string
	rooms: string[]
	permissions: string[]
}

const script = resolve('scripts/manage-api-tokens.mjs')
const temporaryDirectories: string[] = []

function workspace() {
	const directory = mkdtempSync(join(tmpdir(), 'canvas-token-store-'))
	temporaryDirectories.push(directory)
	return { directory, file: join(directory, 'api-tokens.json') }
}

function fixture(name: string, room = 'board-a'): Client {
	return { name, tokenHash: `${name}-hash`, rooms: [room], permissions: ['read', 'write'] }
}

function writeStore(file: string, clients: Client[]) {
	writeFileSync(file, `${JSON.stringify({ clients }, null, 2)}\n`, { mode: 0o600 })
}

function run(file: string, args: string[], extraEnvironment: NodeJS.ProcessEnv = {}) {
	return execFileSync(process.execPath, [script, ...args], {
		cwd: process.cwd(),
		env: { ...process.env, CANVAS_API_TOKENS_FILE: file, ...extraEnvironment },
		stdio: 'pipe',
	})
}

function readStore(file: string): { clients: Client[] } {
	return JSON.parse(readFileSync(file, 'utf8'))
}

function backups(directory: string) {
	return readdirSync(directory).filter((entry) => entry.endsWith('.bak'))
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('API token-store mutations', () => {
	it('creating B preserves existing A and backs up the pre-mutation state', () => {
		const { directory, file } = workspace()
		const clientA = fixture('client-a')
		writeStore(file, [clientA])
		const before = readFileSync(file, 'utf8')

		run(file, ['create', 'client-b', 'board-b', 'read'])

		const clients = readStore(file).clients
		expect(clients.map((client) => client.name)).toEqual(['client-a', 'client-b'])
		expect(clients[0]).toEqual(clientA)
		const backupFiles = backups(directory)
		expect(backupFiles).toHaveLength(1)
		expect(readFileSync(join(directory, backupFiles[0]), 'utf8')).toBe(before)
		if (process.platform !== 'win32') expect(statSync(join(directory, backupFiles[0])).mode & 0o777).toBe(0o600)
	})

	it('revoking B preserves A and removes only B', () => {
		const { directory, file } = workspace()
		const clientA = fixture('client-a')
		writeStore(file, [clientA, fixture('client-b', 'board-b')])

		run(file, ['revoke', 'client-b'])

		expect(readStore(file).clients).toEqual([clientA])
		expect(backups(directory)).toHaveLength(1)
	})

	it('creates a new store when the token file is missing', () => {
		const { directory, file } = workspace()

		run(file, ['create', 'client-a', 'board-a', 'read-write'])

		expect(readStore(file).clients.map((client) => client.name)).toEqual(['client-a'])
		const backupFiles = backups(directory)
		expect(backupFiles).toHaveLength(1)
		expect(JSON.parse(readFileSync(join(directory, backupFiles[0]), 'utf8'))).toEqual({ clients: [] })
	})

	it('leaves a malformed store unchanged', () => {
		const { directory, file } = workspace()
		const malformed = '{ definitely not valid JSON'
		writeFileSync(file, malformed, { mode: 0o600 })

		expect(() => run(file, ['create', 'client-b', 'board-b', 'read'])).toThrow()

		expect(readFileSync(file, 'utf8')).toBe(malformed)
		expect(backups(directory)).toHaveLength(0)
	})

	it('leaves the previous store intact when the final write fails', () => {
		const { directory, file } = workspace()
		writeStore(file, [fixture('client-a')])
		const before = readFileSync(file, 'utf8')

		expect(() => run(file, ['create', 'client-b', 'board-b', 'read'], { CANVAS_API_TOKENS_TEST_FAILPOINT: 'before-rename' })).toThrow()

		expect(readFileSync(file, 'utf8')).toBe(before)
		const backupFiles = backups(directory)
		expect(backupFiles).toHaveLength(1)
		expect(readFileSync(join(directory, backupFiles[0]), 'utf8')).toBe(before)
		expect(readdirSync(directory).some((entry) => entry.endsWith('.tmp'))).toBe(false)
	})
})
