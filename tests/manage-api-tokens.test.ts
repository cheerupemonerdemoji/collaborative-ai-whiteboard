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

describe('board-creating credentials (accountClients) and the command-line tool', () => {
	const creator = {
		name: 'agent-creator', tokenHash: 'c'.repeat(64), ownerUserId: 'user-1', accountPermissions: ['board:create'],
		permissions: ['read', 'write', 'history'], rooms: [] as string[], createdAt: '2026-10-14T00:00:00.000Z',
	}
	function seeded() {
		const { directory, file } = workspace()
		writeFileSync(file, `${JSON.stringify({ schemaVersion: 2, clients: [fixture('plain')], accountClients: [creator] }, null, 2)}\n`, { mode: 0o600 })
		return { directory, file }
	}

	it('lists them next to ordinary clients, with an empty board column when they hold none yet', () => {
		const { file } = seeded()
		const lines = run(file, ['list']).toString().trim().split('\n')
		expect(lines).toEqual(['plain\tboard-a\tread,write', 'agent-creator\t\tread,write,history'])
		expect(run(file, ['list', '--long']).toString()).toContain('agent-creator')
	})

	it('revokes one by name, leaving the collection, the ordinary clients and unknown top-level keys in place', () => {
		const { file } = seeded()
		expect(run(file, ['revoke', 'agent-creator']).toString()).toContain('Revoked agent-creator')
		const store = JSON.parse(readFileSync(file, 'utf8'))
		expect(store.accountClients).toEqual([])
		expect(store.schemaVersion).toBe(2)
		expect(store.clients.map((client: Client) => client.name)).toEqual(['plain'])
	})

	it('revoking an ordinary client leaves the creators untouched, byte for byte', () => {
		const { file } = seeded()
		run(file, ['revoke', 'plain'])
		const store = JSON.parse(readFileSync(file, 'utf8'))
		expect(store.accountClients).toEqual([creator])
		expect(store.clients).toEqual([])
	})

	it('refuses to create an ordinary client under a creator\'s name', () => {
		const { file } = seeded()
		expect(() => run(file, ['create', 'agent-creator', 'board-x', 'read'])).toThrow()
		expect(JSON.parse(readFileSync(file, 'utf8')).clients.map((client: Client) => client.name)).toEqual(['plain'])
	})

	it('accepts the read-write-history mode for an ordinary client', () => {
		const { file } = workspace()
		run(file, ['create', 'history-agent', 'board-x', 'read-write-history'])
		expect(readStore(file).clients[0].permissions).toEqual(['read', 'write', 'history'])
	})
})

describe('the cad-upload capability (ADR 013)', () => {
	type CapClient = Client & { capabilities?: string[]; expiresAt?: string }
	const stored = (file: string) => readStore(file).clients as CapClient[]

	it('--cad-upload with --expires stores the capability and the expiry for one board with write access', () => {
		const { file } = workspace()
		const output = run(file, ['create', 'cad-agent', 'board-a', 'read-write', '--cad-upload', '--expires', '7d']).toString()
		run(file, ['create', 'plain-agent', 'board-a', 'read-write'])
		const clients = stored(file)
		const cad = clients.find((client) => client.name === 'cad-agent')
		expect(cad?.capabilities).toEqual(['cad-upload'])
		expect(Date.parse(cad?.expiresAt ?? '') - Date.now()).toBeGreaterThan(6.9 * 86_400_000)
		expect(clients.find((client) => client.name === 'plain-agent')?.capabilities).toBeUndefined()
		expect(output).toContain('Capability cad-upload granted for this one board.')
	})

	it('refuses --cad-upload without --expires, and with an expiry beyond the maximum, leaving the store untouched', () => {
		const { file } = workspace()
		writeStore(file, [fixture('client-a')])
		const before = readFileSync(file, 'utf8')
		expect(() => run(file, ['create', 'cad-agent', 'board-a', 'read-write', '--cad-upload'])).toThrow(/--expires/)
		expect(() => run(file, ['create', 'cad-agent', 'board-a', 'read-write', '--cad-upload', '--expires', '366d'])).toThrow(/365 days/)
		expect(() => run(file, ['create', 'cad-agent', 'board-a', 'read-write', '--cad-upload', '--expires', '2999-01-01T00:00:00Z'])).toThrow(/365 days/)
		expect(readFileSync(file, 'utf8')).toBe(before)
	})

	it('accepts --expires up to exactly 365d', () => {
		const { file } = workspace()
		run(file, ['create', 'cad-agent', 'board-a', 'read-write', '--cad-upload', '--expires', '365d'])
		expect(stored(file)[0].capabilities).toEqual(['cad-upload'])
	})

	it('accepts an absolute --expires with milliseconds, as used to match another token\'s expiry to the instant', () => {
		const { file } = workspace()
		const target = new Date(Date.now() + 355 * 86_400_000 + 123).toISOString()
		expect(target).toMatch(/\.\d{3}Z$/)
		run(file, ['create', 'cad-agent', 'board-a', 'read-write', '--cad-upload', '--expires', target])
		expect(stored(file)[0]).toMatchObject({ capabilities: ['cad-upload'], expiresAt: target })
	})

	it('still refuses --cad-upload without write access or for more than one board, even with a good expiry', () => {
		const { file } = workspace()
		writeStore(file, [fixture('client-a')])
		const before = readFileSync(file, 'utf8')
		expect(() => run(file, ['create', 'cad-agent', 'board-a', 'read', '--cad-upload', '--expires', '7d'])).toThrow()
		expect(() => run(file, ['create', 'cad-agent', 'board-a,board-b', 'read-write', '--cad-upload', '--expires', '7d'])).toThrow()
		expect(readFileSync(file, 'utf8')).toBe(before)
	})

	it('shows the capability in list and list --long, on that row only, and leaves every other row exactly as it was', () => {
		const { file } = workspace()
		writeStore(file, [fixture('plain')])
		run(file, ['create', 'cad-agent', 'board-a', 'read-write', '--cad-upload', '--expires', '7d'])
		const plain = run(file, ['list']).toString().trim().split('\n')
		expect(plain).toEqual(['plain\tboard-a\tread,write', 'cad-agent\tboard-a\tread,write\tcapabilities=cad-upload'])
		const long = run(file, ['list', '--long']).toString().trim().split('\n')
		expect(long[0].split('\t')).toHaveLength(6)
		expect(long[0].startsWith('plain\tboard-a\tread,write\t')).toBe(true)
		expect(long[1].split('\t')).toHaveLength(7)
		expect(long[1].endsWith('\tcapabilities=cad-upload')).toBe(true)
	})

	it('refuses the flag on revoke and list', () => {
		const { file } = workspace()
		run(file, ['create', 'cad-agent', 'board-a', 'read-write', '--cad-upload', '--expires', '7d'])
		const before = readFileSync(file, 'utf8')
		expect(() => run(file, ['revoke', 'cad-agent', '--cad-upload'])).toThrow()
		expect(() => run(file, ['list', '--cad-upload'])).toThrow()
		expect(readFileSync(file, 'utf8')).toBe(before)
	})
})
