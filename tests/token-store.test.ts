// Regression tests for the SHARED machine-token mutation path.
//
// These exercise server/token-store.mjs directly, not just the CLI, because the
// owner-only agent-access routes will call the same functions. Each guarantee
// below was mutation-tested: the corresponding safeguard was removed from
// server/token-store.mjs and at least one assertion here was confirmed to fail.
//
// The guarantees under test:
//   - the exclusive lock is taken, released, and never stolen;
//   - a byte-faithful 0600 backup precedes every destructive write;
//   - unknown top-level and per-client metadata survives read-modify-write;
//   - replacement is atomic, so a pre-rename failure leaves the store usable;
//   - refused mutations write nothing at all;
//   - token plaintext never reaches the store, a backup, or an error.

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { copyFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import * as store from '../server/token-store.mjs'
import {
	TokenStoreError,
	acquireMutationLock,
	createClient,
	listClients,
	mutateStore,
	readStore,
	resolveStorePath,
	revokeClient,
} from '../server/token-store.mjs'

const run = promisify(execFile)
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))

let directory: string
let file: string

/** Write the store verbatim so unknown-shape fixtures stay unknown-shaped. */
async function writeStore(contents: unknown): Promise<string> {
	const source = `${JSON.stringify(contents, null, 2)}\n`
	await writeFile(file, source, { mode: 0o600 })
	return source
}

async function entries(): Promise<string[]> {
	return (await readdir(directory)).sort()
}

async function backups(): Promise<string[]> {
	return (await entries()).filter((entry) => entry.endsWith('.bak'))
}

async function temporaries(): Promise<string[]> {
	return (await entries()).filter((entry) => entry.endsWith('.tmp'))
}

async function mode(path: string): Promise<number> {
	return (await stat(path)).mode & 0o777
}

const legacyHash = 'a'.repeat(64)

/** A store carrying metadata a strict writer of this version would discard. */
function storeWithMetadata() {
	return {
		schemaVersion: 7,
		somethingNobodyHasInventedYet: { deeply: ['nested'] },
		clients: [
			{
				name: 'legacy-client',
				tokenHash: legacyHash,
				rooms: ['board-one'],
				permissions: ['read'],
				createdAt: '2026-01-01T00:00:00.000Z',
				expiresAt: '2027-01-01T00:00:00.000Z',
				displayName: 'Legacy client',
				createdByUserId: 'user-42',
			},
		],
	}
}

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'token-store-'))
	file = join(directory, 'api-tokens.json')
	delete process.env.CANVAS_API_TOKENS_TEST_FAILPOINT
})

afterEach(async () => {
	delete process.env.CANVAS_API_TOKENS_TEST_FAILPOINT
	await rm(directory, { recursive: true, force: true })
})

describe('the shared mutation path holds an exclusive lock', () => {
	it('refuses to mutate while another operation holds the lock', async () => {
		const source = await writeStore(storeWithMetadata())
		await writeFile(`${file}.lock`, '99999\n', { mode: 0o600 })

		const failure = await createClient({ file, name: 'second-writer', rooms: ['board-one'], access: 'read' }).catch((error) => error)

		expect(failure).toBeInstanceOf(TokenStoreError)
		expect((failure as TokenStoreError).code).toBe('locked')
		expect(await readFile(file, 'utf8')).toBe(source)
		expect(await backups()).toHaveLength(0)
		expect(await temporaries()).toHaveLength(0)
	})

	it('leaves a lock it did not create in place', async () => {
		await writeStore(storeWithMetadata())
		await writeFile(`${file}.lock`, 'held-by-someone-else\n', { mode: 0o600 })

		await expect(revokeClient(file, 'legacy-client')).rejects.toThrow(/locked by another management operation/)

		expect(await readFile(`${file}.lock`, 'utf8')).toBe('held-by-someone-else\n')
	})

	it('releases the lock after a successful mutation', async () => {
		await writeStore(storeWithMetadata())

		await createClient({ file, name: 'first-writer', rooms: ['board-one'], access: 'read' })

		expect(await entries()).not.toContain('api-tokens.json.lock')
		await expect(createClient({ file, name: 'second-writer', rooms: ['board-one'], access: 'read' })).resolves.toBeDefined()
	})

	it('releases the lock after a refused mutation', async () => {
		await writeStore(storeWithMetadata())

		await expect(revokeClient(file, 'no-such-client')).rejects.toThrow(/not found/)

		expect(await entries()).not.toContain('api-tokens.json.lock')
		await expect(revokeClient(file, 'legacy-client')).resolves.toBeUndefined()
	})

	it('releases the lock after the write itself fails', async () => {
		await writeStore(storeWithMetadata())
		process.env.CANVAS_API_TOKENS_TEST_FAILPOINT = 'before-rename'

		await expect(revokeClient(file, 'legacy-client')).rejects.toThrow(/Injected failure/)

		expect(await entries()).not.toContain('api-tokens.json.lock')
	})

	it('serialises concurrent mutations rather than interleaving them', async () => {
		await writeStore(storeWithMetadata())

		const outcomes = await Promise.allSettled([
			createClient({ file, name: 'racer-one', rooms: ['board-one'], access: 'read' }),
			createClient({ file, name: 'racer-two', rooms: ['board-one'], access: 'read' }),
		])

		// Whatever the interleaving, the store must stay parseable and must
		// never lose the client that was already registered.
		const { data } = await readStore(file)
		const names = data.clients.map((client) => client.name)
		expect(names).toContain('legacy-client')
		const succeeded = outcomes.filter((outcome) => outcome.status === 'fulfilled').length
		expect(names).toHaveLength(1 + succeeded)
		expect(new Set(names).size).toBe(names.length)
	})

	it('hands back an idempotent release', async () => {
		await writeStore(storeWithMetadata())
		const release = await acquireMutationLock(file)

		await release()
		await expect(release()).resolves.toBeUndefined()

		await expect(acquireMutationLock(file)).resolves.toBeTypeOf('function')
	})
})

describe('every destructive write is preceded by a backup', () => {
	it('backs up the exact bytes it read before creating a client', async () => {
		const source = await writeStore(storeWithMetadata())

		await createClient({ file, name: 'new-client', rooms: ['board-one'], access: 'read' })

		const copies = await backups()
		expect(copies).toHaveLength(1)
		expect(await readFile(join(directory, copies[0]), 'utf8')).toBe(source)
	})

	it('backs up the exact bytes it read before revoking a client', async () => {
		const source = await writeStore(storeWithMetadata())

		await revokeClient(file, 'legacy-client')

		const copies = await backups()
		expect(copies).toHaveLength(1)
		expect(await readFile(join(directory, copies[0]), 'utf8')).toBe(source)
	})

	it('writes the backup before the store is replaced', async () => {
		const source = await writeStore(storeWithMetadata())
		process.env.CANVAS_API_TOKENS_TEST_FAILPOINT = 'before-rename'

		await expect(createClient({ file, name: 'new-client', rooms: ['board-one'], access: 'read' })).rejects.toThrow(/Injected failure/)

		// The backup exists even though the replacement never happened: the
		// recovery copy is on disk before anything can go wrong.
		const copies = await backups()
		expect(copies).toHaveLength(1)
		expect(await readFile(join(directory, copies[0]), 'utf8')).toBe(source)
		expect(await readFile(file, 'utf8')).toBe(source)
	})

	it('keeps backups readable only by the owner', async () => {
		await writeStore(storeWithMetadata())

		await createClient({ file, name: 'new-client', rooms: ['board-one'], access: 'read' })

		const copies = await backups()
		expect(await mode(join(directory, copies[0]))).toBe(0o600)
	})

	it('never overwrites an earlier backup', async () => {
		await writeStore(storeWithMetadata())

		await createClient({ file, name: 'client-one', rooms: ['board-one'], access: 'read' })
		await createClient({ file, name: 'client-two', rooms: ['board-one'], access: 'read' })
		await revokeClient(file, 'client-one')

		expect(await backups()).toHaveLength(3)
	})

	it('writes no backup when the mutation is refused', async () => {
		const source = await writeStore(storeWithMetadata())

		await expect(createClient({ file, name: 'legacy-client', rooms: ['board-one'], access: 'read' })).rejects.toThrow(/already exists/)
		await expect(revokeClient(file, 'never-registered')).rejects.toThrow(/not found/)

		expect(await backups()).toHaveLength(0)
		expect(await readFile(file, 'utf8')).toBe(source)
	})
})

describe('mutations preserve metadata this version does not understand', () => {
	it('keeps unknown top-level keys across a create', async () => {
		await writeStore(storeWithMetadata())

		await createClient({ file, name: 'new-client', rooms: ['board-one'], access: 'read' })

		const { data } = await readStore(file)
		expect(data.schemaVersion).toBe(7)
		expect(data.somethingNobodyHasInventedYet).toEqual({ deeply: ['nested'] })
	})

	it('keeps unknown top-level keys across a revoke', async () => {
		await writeStore(storeWithMetadata())

		await revokeClient(file, 'legacy-client')

		const { data } = await readStore(file)
		expect(data.clients).toHaveLength(0)
		expect(data.schemaVersion).toBe(7)
		expect(data.somethingNobodyHasInventedYet).toEqual({ deeply: ['nested'] })
	})

	it('keeps unknown per-client keys on untouched clients', async () => {
		await writeStore(storeWithMetadata())

		await createClient({ file, name: 'new-client', rooms: ['board-one'], access: 'read' })

		const { data } = await readStore(file)
		const legacy = data.clients.find((client) => client.name === 'legacy-client')
		expect(legacy).toMatchObject({
			createdAt: '2026-01-01T00:00:00.000Z',
			expiresAt: '2027-01-01T00:00:00.000Z',
			displayName: 'Legacy client',
			createdByUserId: 'user-42',
			tokenHash: legacyHash,
		})
	})

	it('keeps metadata on surviving clients when another is revoked', async () => {
		const store = storeWithMetadata()
		store.clients.push({
			name: 'doomed-client',
			tokenHash: 'b'.repeat(64),
			rooms: ['board-two'],
			permissions: ['read'],
			createdAt: '2026-02-02T00:00:00.000Z',
			expiresAt: '2027-02-02T00:00:00.000Z',
			displayName: 'Doomed',
			createdByUserId: 'user-7',
		})
		await writeStore(store)

		await revokeClient(file, 'doomed-client')

		const { data } = await readStore(file)
		expect(data.clients.map((client) => client.name)).toEqual(['legacy-client'])
		expect(data.clients[0].displayName).toBe('Legacy client')
		expect(data.clients[0].createdByUserId).toBe('user-42')
	})

	it('preserves the serialised shape operators and diffs expect', async () => {
		await writeStore({ clients: [] })

		await createClient({ file, name: 'new-client', rooms: ['board-one'], access: 'read' })

		const source = await readFile(file, 'utf8')
		expect(source.endsWith('}\n')).toBe(true)
		expect(source).toContain('\n  "clients": [')
	})
})

describe('the store is replaced atomically or not at all', () => {
	it('leaves the previous store byte-identical when the write fails', async () => {
		const source = await writeStore(storeWithMetadata())
		process.env.CANVAS_API_TOKENS_TEST_FAILPOINT = 'before-rename'

		await expect(createClient({ file, name: 'new-client', rooms: ['board-one'], access: 'read' })).rejects.toThrow(/Injected failure/)

		expect(await readFile(file, 'utf8')).toBe(source)
	})

	it('leaves the previous store usable, not merely present, after a failure', async () => {
		await writeStore(storeWithMetadata())
		process.env.CANVAS_API_TOKENS_TEST_FAILPOINT = 'before-rename'
		await expect(revokeClient(file, 'legacy-client')).rejects.toThrow(/Injected failure/)
		delete process.env.CANVAS_API_TOKENS_TEST_FAILPOINT

		expect(await listClients(file)).toEqual([{ name: 'legacy-client', rooms: ['board-one'], permissions: ['read'] }])
		await expect(revokeClient(file, 'legacy-client')).resolves.toBeUndefined()
	})

	it('removes the temp file on the failure path', async () => {
		await writeStore(storeWithMetadata())
		process.env.CANVAS_API_TOKENS_TEST_FAILPOINT = 'before-rename'

		await expect(createClient({ file, name: 'new-client', rooms: ['board-one'], access: 'read' })).rejects.toThrow(/Injected failure/)

		expect(await temporaries()).toHaveLength(0)
	})

	it('leaves no temp file behind on the success path', async () => {
		await writeStore(storeWithMetadata())

		await createClient({ file, name: 'new-client', rooms: ['board-one'], access: 'read' })
		await revokeClient(file, 'new-client')

		expect(await temporaries()).toHaveLength(0)
	})

	it('keeps the replaced store readable only by the owner', async () => {
		await writeStore(storeWithMetadata())

		await createClient({ file, name: 'new-client', rooms: ['board-one'], access: 'read' })

		expect(await mode(file)).toBe(0o600)
	})

	it('creates a first-ever store at 0600 inside a 0700 directory', async () => {
		const nested = join(directory, 'config', 'api-tokens.json')

		await createClient({ file: nested, name: 'first-client', rooms: ['board-one'], access: 'read' })

		expect(await mode(nested)).toBe(0o600)
		expect(await mode(join(directory, 'config'))).toBe(0o700)
		expect(await listClients(nested)).toHaveLength(1)
	})
})

describe('malformed input and refused mutations leave the store usable', () => {
	it('refuses a store whose clients is not an array', async () => {
		const source = await writeStore({ clients: { 'legacy-client': {} } })

		const failure = await createClient({ file, name: 'new-client', rooms: ['board-one'], access: 'read' }).catch((error) => error)

		expect(failure).toBeInstanceOf(TokenStoreError)
		expect((failure as TokenStoreError).code).toBe('invalid-store')
		expect(await readFile(file, 'utf8')).toBe(source)
		expect(await backups()).toHaveLength(0)
		expect(await temporaries()).toHaveLength(0)
	})

	it('refuses a store that is not valid JSON', async () => {
		await writeFile(file, '{ this is not json', { mode: 0o600 })

		const failure = await revokeClient(file, 'legacy-client').catch((error) => error)

		expect(failure).toBeInstanceOf(TokenStoreError)
		expect((failure as TokenStoreError).code).toBe('invalid-store')
		expect(await readFile(file, 'utf8')).toBe('{ this is not json')
		expect(await backups()).toHaveLength(0)
	})

	it('refuses a JSON document that is not an object', async () => {
		for (const contents of ['null', '[]', '"a string"', '42']) {
			await writeFile(file, contents, { mode: 0o600 })
			const failure = await readStore(file).catch((error) => error)
			expect(failure, contents).toBeInstanceOf(TokenStoreError)
			expect((failure as TokenStoreError).code, contents).toBe('invalid-store')
		}
	})

	it('refuses a duplicate client name instead of replacing a live registration', async () => {
		const source = await writeStore(storeWithMetadata())

		const failure = await createClient({ file, name: 'legacy-client', rooms: ['board-nine'], access: 'full' }).catch((error) => error)

		expect(failure).toBeInstanceOf(TokenStoreError)
		expect((failure as TokenStoreError).code).toBe('duplicate-name')
		expect(await readFile(file, 'utf8')).toBe(source)
	})

	it('refuses an unknown name on revoke instead of writing a no-op', async () => {
		const source = await writeStore(storeWithMetadata())

		const failure = await revokeClient(file, 'never-registered').catch((error) => error)

		expect(failure).toBeInstanceOf(TokenStoreError)
		expect((failure as TokenStoreError).code).toBe('not-found')
		expect(await readFile(file, 'utf8')).toBe(source)
	})

	it('rejects invalid names, rooms and access modes before taking the lock', async () => {
		const source = await writeStore(storeWithMetadata())

		const cases: Array<[string, Parameters<typeof createClient>[0]]> = [
			['invalid-name', { file, name: 'bad name', rooms: ['board-one'], access: 'read' }],
			['invalid-name', { file, name: '', rooms: ['board-one'], access: 'read' }],
			['invalid-rooms', { file, name: 'ok-name', rooms: [], access: 'read' }],
			['invalid-rooms', { file, name: 'ok-name', rooms: ['board one'], access: 'read' }],
			['invalid-rooms', { file, name: 'ok-name', rooms: Array.from({ length: 51 }, (_, index) => `board-${index}`), access: 'read' }],
			['invalid-access', { file, name: 'ok-name', rooms: ['board-one'], access: 'sudo' }],
		]

		for (const [code, request] of cases) {
			const failure = await createClient(request).catch((error) => error)
			expect(failure, code).toBeInstanceOf(TokenStoreError)
			expect((failure as TokenStoreError).code).toBe(code)
		}

		expect(await readFile(file, 'utf8')).toBe(source)
		expect(await entries()).toEqual(['api-tokens.json'])
	})

	it('propagates a mutator rejection without writing anything', async () => {
		const source = await writeStore(storeWithMetadata())

		await expect(
			mutateStore(file, () => {
				throw new Error('mutator said no')
			}),
		).rejects.toThrow(/mutator said no/)

		expect(await readFile(file, 'utf8')).toBe(source)
		expect(await entries()).toEqual(['api-tokens.json'])
	})
})

describe('token plaintext never leaves the caller', () => {
	it('persists only the hash, in the store and in every backup', async () => {
		await writeStore(storeWithMetadata())

		const { token } = await createClient({ file, name: 'new-client', rooms: ['board-one'], access: 'full' })
		await revokeClient(file, 'legacy-client')

		const hash = createHash('sha256').update(token).digest('hex')
		for (const entry of await entries()) {
			const contents = await readFile(join(directory, entry), 'utf8')
			expect(contents, entry).not.toContain(token)
		}
		const { data } = await readStore(file)
		expect(data.clients.find((client) => client.name === 'new-client')?.tokenHash).toBe(hash)
	})

	it('keeps token material out of listings', async () => {
		await writeStore(storeWithMetadata())
		const { token } = await createClient({ file, name: 'new-client', rooms: ['board-one'], access: 'read' })

		const summaries = await listClients(file)

		expect(JSON.stringify(summaries)).not.toContain(token)
		expect(JSON.stringify(summaries)).not.toContain(legacyHash)
		for (const summary of summaries) expect(Object.keys(summary).sort()).toEqual(['name', 'permissions', 'rooms'])
	})

	it('keeps token material out of failure messages and stacks', async () => {
		await writeStore(storeWithMetadata())
		process.env.CANVAS_API_TOKENS_TEST_FAILPOINT = 'before-rename'

		const failure = await createClient({ file, name: 'new-client', rooms: ['board-one'], access: 'full' }).catch((error) => error)

		const rendered = `${(failure as Error).message}\n${(failure as Error).stack ?? ''}`
		// A base64url run this long can only be a bearer token.
		expect(rendered).not.toMatch(/[A-Za-z0-9_-]{32,}/)
	})

	it('issues a bearer the read path actually accepts', async () => {
		await writeStore(storeWithMetadata())
		const { token } = await createClient({ file, name: 'new-client', rooms: ['board-one'], access: 'read-write' })

		const previous = process.env.CANVAS_API_TOKENS_FILE
		process.env.CANVAS_API_TOKENS_FILE = file
		try {
			const { authorizeApiToken } = await import('../server/tokens.ts')
			expect(authorizeApiToken(`Bearer ${token}`, 'board-one', 'write')).toBe('new-client')
			expect(authorizeApiToken(`Bearer ${token}`, 'board-two', 'write')).toBeNull()
			expect(authorizeApiToken(`Bearer ${token}`, 'board-one', 'restore')).toBeNull()
		} finally {
			if (previous === undefined) delete process.env.CANVAS_API_TOKENS_FILE
			else process.env.CANVAS_API_TOKENS_FILE = previous
		}
	})

	it('revokes a bearer the read path previously accepted', async () => {
		await writeStore({ clients: [] })
		const { token } = await createClient({ file, name: 'new-client', rooms: ['board-one'], access: 'read' })

		const previous = process.env.CANVAS_API_TOKENS_FILE
		process.env.CANVAS_API_TOKENS_FILE = file
		try {
			const { authorizeApiToken } = await import('../server/tokens.ts')
			expect(authorizeApiToken(`Bearer ${token}`, 'board-one', 'read')).toBe('new-client')
			await revokeClient(file, 'new-client')
			expect(authorizeApiToken(`Bearer ${token}`, 'board-one', 'read')).toBeNull()
		} finally {
			if (previous === undefined) delete process.env.CANVAS_API_TOKENS_FILE
			else process.env.CANVAS_API_TOKENS_FILE = previous
		}
	})
})

describe('the CLI wrapper still speaks the operator contract', () => {
	const cli = (args: string[]) => run(process.execPath, ['scripts/manage-api-tokens.mjs', ...args], { cwd: repositoryRoot, env: { ...process.env, CANVAS_API_TOKENS_FILE: file } })

	it('resolves the default store path when the override is absent', () => {
		expect(resolveStorePath({ CANVAS_API_TOKENS_FILE: '/explicit/path.json' } as NodeJS.ProcessEnv)).toBe('/explicit/path.json')
		expect(resolveStorePath({} as NodeJS.ProcessEnv)).toMatch(/[/\\]\.config[/\\]collaborative-ai-canvas[/\\]api-tokens\.json$/)
	})

	it('creates through the shared module and prints the one-time token', async () => {
		await writeStore(storeWithMetadata())

		const { stdout } = await cli(['create', 'cli-client', 'board-one,board-two', 'full'])

		const lines = stdout.trimEnd().split('\n')
		expect(lines[0]).toBe('Token for cli-client (copy it now; only its hash is stored):')
		expect(lines[1]).toMatch(/^[A-Za-z0-9_-]{32,128}$/)
		expect((await listClients(file)).map((client) => client.name)).toEqual(['legacy-client', 'cli-client'])
		expect(await backups()).toHaveLength(1)
	}, 30000)

	it('preserves unknown metadata when driven through the CLI', async () => {
		await writeStore(storeWithMetadata())

		await cli(['create', 'cli-client', 'board-one'])
		await cli(['revoke', 'cli-client'])

		const { data } = await readStore(file)
		expect(data.schemaVersion).toBe(7)
		expect(data.somethingNobodyHasInventedYet).toEqual({ deeply: ['nested'] })
		expect(data.clients[0]).toMatchObject({ displayName: 'Legacy client', expiresAt: '2027-01-01T00:00:00.000Z' })
	}, 30000)

	it('lists and revokes in the documented format', async () => {
		await writeStore(storeWithMetadata())

		const listed = await cli(['list'])
		expect(listed.stdout).toBe('legacy-client\tboard-one\tread\n')

		const revoked = await cli(['revoke', 'legacy-client'])
		expect(revoked.stdout).toBe('Revoked legacy-client\n')
	}, 30000)

	it('fails with the documented usage text and a non-zero exit', async () => {
		await writeStore(storeWithMetadata())

		const badCreate = await cli(['create', 'bad name', 'board-one']).catch((error) => error)
		expect(badCreate.code).not.toBe(0)
		expect(badCreate.stderr).toContain('Usage: create <client-name> <room[,room...]> [read|write|read-write|read-history|full]')

		const badCommand = await cli(['bogus']).catch((error) => error)
		expect(badCommand.code).not.toBe(0)
		expect(badCommand.stderr).toContain('Usage: node scripts/manage-api-tokens.mjs create|revoke|list ...')

		expect(await entries()).toEqual(['api-tokens.json'])
	}, 30000)
})

describe('the shared module and the CLI need nothing but Node', () => {
	const read = (relative: string) => readFile(join(repositoryRoot, relative), 'utf8')
	const specifiers = (source: string) => [
		...source.matchAll(/^\s*import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm),
		...source.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g),
	].map((match) => match[1])

	it('has a CLI whose only import is the shared .mjs module, with no TypeScript loader', async () => {
		const source = await read('scripts/manage-api-tokens.mjs')

		expect(specifiers(source)).toEqual(['../server/token-store.mjs'])
		expect(source).not.toMatch(/tsx|\.tsx?['"]/)
	})

	it('has a shared module that imports only node: built-ins', async () => {
		const source = await read('server/token-store.mjs')

		const found = specifiers(source)
		expect(found.length).toBeGreaterThan(0)
		for (const specifier of found) expect(specifier, specifier).toMatch(/^node:/)
	})

	it('declares exactly the runtime exports the implementation has', async () => {
		const declarations = await read('server/token-store.d.mts')
		const declared = [...declarations.matchAll(/^export (?:declare )?(?:async )?(?:function|class|const) (\w+)/gm)].map((match) => match[1])

		expect(declared.sort()).toEqual(Object.keys(store).sort())
	})

	it('runs from an isolated copy of just the two files, on a bare node with no node_modules', async () => {
		const isolated = join(directory, 'isolated')
		await mkdir(join(isolated, 'scripts'), { recursive: true })
		await mkdir(join(isolated, 'server'), { recursive: true })
		await copyFile(join(repositoryRoot, 'scripts', 'manage-api-tokens.mjs'), join(isolated, 'scripts', 'manage-api-tokens.mjs'))
		await copyFile(join(repositoryRoot, 'server', 'token-store.mjs'), join(isolated, 'server', 'token-store.mjs'))
		const bare = (args: string[]) => run(process.execPath, ['scripts/manage-api-tokens.mjs', ...args], { cwd: isolated, env: { ...process.env, CANVAS_API_TOKENS_FILE: file, NODE_OPTIONS: '', NODE_PATH: '' } })

		const created = await bare(['create', 'isolated-client', 'board-one', 'read'])
		expect(created.stdout.split('\n')[0]).toBe('Token for isolated-client (copy it now; only its hash is stored):')
		expect((await bare(['list'])).stdout).toBe('isolated-client\tboard-one\tread\n')
		expect((await bare(['revoke', 'isolated-client'])).stdout).toBe('Revoked isolated-client\n')
		expect((await readdir(isolated)).sort()).toEqual(['scripts', 'server'])
	}, 30000)
})

const FIXED_NOW = new Date('2026-10-08T12:00:00.000Z')

describe('new clients carry metadata, and an expiry only when asked for one', () => {
	const create = (extra: Partial<Parameters<typeof createClient>[0]> = {}) =>
		createClient({ file, name: 'agent', rooms: ['board-one'], access: 'read', now: FIXED_NOW, ...extra })

	it('stamps createdAt on every new client and writes nothing else it was not given', async () => {
		await writeStore({ clients: [] })

		const result = await create()

		const { data } = await readStore(file)
		expect(data.clients[0].createdAt).toBe('2026-10-08T12:00:00.000Z')
		expect(result.createdAt).toBe('2026-10-08T12:00:00.000Z')
		expect(Object.keys(data.clients[0]).sort()).toEqual(['createdAt', 'name', 'permissions', 'rooms', 'tokenHash'])
		expect(result).not.toHaveProperty('expiresAt')
	})

	it('stores a future expiry in canonical form, from a string or a Date', async () => {
		await writeStore({ clients: [] })

		const fromString = await create({ name: 'from-string', expiresAt: '2026-11-07T12:00:00Z' })
		const fromDate = await create({ name: 'from-date', expiresAt: new Date('2026-11-08T12:00:00.500Z') })

		expect(fromString.expiresAt).toBe('2026-11-07T12:00:00.000Z')
		expect(fromDate.expiresAt).toBe('2026-11-08T12:00:00.500Z')
		const { data } = await readStore(file)
		expect(data.clients.map((client) => client.expiresAt)).toEqual(['2026-11-07T12:00:00.000Z', '2026-11-08T12:00:00.500Z'])
	})

	it('refuses an expiry that is not strictly in the future, and writes nothing', async () => {
		const source = await writeStore(storeWithMetadata())

		for (const expiresAt of ['2026-10-08T11:59:59Z', '2026-10-08T12:00:00Z', '2000-01-01T00:00:00Z']) {
			const failure = await create({ expiresAt }).catch((error) => error)
			expect(failure, expiresAt).toBeInstanceOf(TokenStoreError)
			expect((failure as TokenStoreError).code, expiresAt).toBe('invalid-expiry')
		}

		expect(await readFile(file, 'utf8')).toBe(source)
		expect(await entries()).toEqual(['api-tokens.json'])
	})

	it('refuses a malformed expiry instead of quietly creating a client that never expires', async () => {
		const source = await writeStore(storeWithMetadata())
		const malformed: unknown[] = [null, '', '2027', 'tomorrow', '2027-01-31', '2027-01-31T00:00:00', '2027-01-31T00:00:00+01:00', '2027-02-31T00:00:00Z', 1893456000000, new Date('not a date'), {}]

		for (const expiresAt of malformed) {
			const failure = await create({ expiresAt: expiresAt as string }).catch((error) => error)
			expect(failure, String(expiresAt)).toBeInstanceOf(TokenStoreError)
			expect((failure as TokenStoreError).code, String(expiresAt)).toBe('invalid-expiry')
		}

		expect(await readFile(file, 'utf8')).toBe(source)
		expect(await entries()).toEqual(['api-tokens.json'])
	})

	it('stores a trimmed display name and a creator id when given', async () => {
		await writeStore({ clients: [] })

		await create({ displayName: '  Claude - Chibi Robo  ', createdByUserId: 'user:00000000-0000-4000-8000-000000000001' })

		const { data } = await readStore(file)
		expect(data.clients[0]).toMatchObject({ displayName: 'Claude - Chibi Robo', createdByUserId: 'user:00000000-0000-4000-8000-000000000001' })
	})

	it('refuses an unusable display name or creator id, and writes nothing', async () => {
		const source = await writeStore(storeWithMetadata())
		const cases: Array<[string, Partial<Parameters<typeof createClient>[0]>]> = [
			['invalid-display-name', { displayName: '' }],
			['invalid-display-name', { displayName: '   ' }],
			['invalid-display-name', { displayName: 'x'.repeat(81) }],
			['invalid-display-name', { displayName: 'bell\u0007' }],
			['invalid-display-name', { displayName: 5 as unknown as string }],
			['invalid-creator', { createdByUserId: '' }],
			['invalid-creator', { createdByUserId: 'has space' }],
			['invalid-creator', { createdByUserId: 'x'.repeat(129) }],
			['invalid-creator', { createdByUserId: 7 as unknown as string }],
		]

		for (const [code, extra] of cases) {
			const failure = await create(extra).catch((error) => error)
			expect(failure, JSON.stringify(extra)).toBeInstanceOf(TokenStoreError)
			expect((failure as TokenStoreError).code, JSON.stringify(extra)).toBe(code)
		}

		expect(await readFile(file, 'utf8')).toBe(source)
		expect(await entries()).toEqual(['api-tokens.json'])
	})

	it('keeps the new metadata intact through later creates and revokes', async () => {
		await writeStore({ clients: [] })
		await create({ name: 'keeper', expiresAt: '2026-11-07T12:00:00Z', displayName: 'Keeper', createdByUserId: 'user-1' })

		await create({ name: 'passer-by' })
		await revokeClient(file, 'passer-by')

		const { data } = await readStore(file)
		expect(data.clients).toHaveLength(1)
		expect(data.clients[0]).toMatchObject({ name: 'keeper', createdAt: '2026-10-08T12:00:00.000Z', expiresAt: '2026-11-07T12:00:00.000Z', displayName: 'Keeper', createdByUserId: 'user-1' })
	})

	it('keeps token material out of everything the new fields touch', async () => {
		await writeStore({ clients: [] })

		const { token } = await create({ expiresAt: '2026-11-07T12:00:00Z', displayName: 'Keeper', createdByUserId: 'user-1' })

		for (const entry of await entries()) expect(await readFile(join(directory, entry), 'utf8'), entry).not.toContain(token)
	})
})

describe('evaluateExpiry is the single definition of "expired"', () => {
	const now = FIXED_NOW.getTime()

	it('treats an absent expiry as never expiring', () => {
		expect(store.evaluateExpiry(undefined, now)).toBe('none')
	})

	it('treats a strictly future expiry as active, down to the millisecond', () => {
		expect(store.evaluateExpiry('2026-10-08T12:00:00.001Z', now)).toBe('active')
		expect(store.evaluateExpiry('2099-01-01T00:00:00Z', now)).toBe('active')
	})

	it('treats the instant of expiry, and anything earlier, as expired', () => {
		expect(store.evaluateExpiry('2026-10-08T12:00:00.000Z', now)).toBe('expired')
		expect(store.evaluateExpiry('2026-10-08T11:59:59.999Z', now)).toBe('expired')
		expect(store.evaluateExpiry('2000-01-01T00:00:00Z', now)).toBe('expired')
	})

	it('treats anything it cannot read as invalid, which callers must refuse', () => {
		const unreadable: unknown[] = [null, '', 'soon', '2099', '2099-01-01', '2099-01-01T00:00:00', '2099-01-01T00:00:00+00:00', '2099-01-01 00:00:00Z', ' 2099-01-01T00:00:00Z', '2099-02-31T00:00:00Z', '2099-13-01T00:00:00Z', 4102444800000, false, {}, []]
		for (const value of unreadable) expect(store.evaluateExpiry(value, now), JSON.stringify(value)).toBe('invalid')
	})

	it('defaults to the real clock', () => {
		expect(store.evaluateExpiry('2000-01-01T00:00:00Z')).toBe('expired')
		expect(store.evaluateExpiry('2099-01-01T00:00:00Z')).toBe('active')
	})
})

describe('describeClients shows metadata and status without ever showing a hash', () => {
	it('reports each client with its live expiry status', async () => {
		await writeStore({
			clients: [
				{ name: 'legacy', tokenHash: legacyHash, rooms: ['a'], permissions: ['read'] },
				{ name: 'live', tokenHash: legacyHash, rooms: ['a'], permissions: ['read'], createdAt: '2026-10-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z', displayName: 'Live one', createdByUserId: 'user-9' },
				{ name: 'gone', tokenHash: legacyHash, rooms: ['a'], permissions: ['read'], expiresAt: '2000-01-01T00:00:00.000Z' },
				{ name: 'broken', tokenHash: legacyHash, rooms: ['a'], permissions: ['read'], expiresAt: 'garbage' },
			],
		})

		const clients = await store.describeClients(file, FIXED_NOW.getTime())

		expect(clients.map((client) => [client.name, client.status])).toEqual([['legacy', 'none'], ['live', 'active'], ['gone', 'expired'], ['broken', 'invalid']])
		expect(clients[1]).toMatchObject({ createdAt: '2026-10-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z', displayName: 'Live one', createdByUserId: 'user-9' })
		expect(clients[0]).not.toHaveProperty('createdAt')
		expect(clients[0]).not.toHaveProperty('expiresAt')
		expect(JSON.stringify(clients)).not.toContain(legacyHash)
		for (const client of clients) expect(client).not.toHaveProperty('tokenHash')
	})

	it('omits fields of the wrong type instead of passing them through', async () => {
		await writeStore({ clients: [{ name: 'odd', tokenHash: legacyHash, rooms: ['a'], permissions: ['read'], createdAt: 5, displayName: { x: 1 }, createdByUserId: ['u'], expiresAt: 7 }] })

		const [client] = await store.describeClients(file, FIXED_NOW.getTime())

		expect(Object.keys(client).sort()).toEqual(['fingerprint', 'name', 'permissions', 'rooms', 'status'])
		expect(client.status).toBe('invalid')
	})

	it('leaves listClients on its original three fields for clients that carry metadata', async () => {
		await writeStore(storeWithMetadata())

		for (const summary of await listClients(file)) expect(Object.keys(summary).sort()).toEqual(['name', 'permissions', 'rooms'])
	})
})

describe('the CLI takes an optional expiry and a longer listing, and nothing else changes', () => {
	const cli = (args: string[]) => run(process.execPath, ['scripts/manage-api-tokens.mjs', ...args], { cwd: repositoryRoot, env: { ...process.env, CANVAS_API_TOKENS_FILE: file } })
	const failure = (args: string[]) => cli(args).then(() => null, (error) => error as { code: number; stdout: string; stderr: string })
	const CREATE_USAGE = 'Usage: create <client-name> <room[,room...]> [read|write|read-write|read-history|full]'
	const FLAG_USAGE = `${CREATE_USAGE} [--expires <Nd|Nh|ISO-8601 UTC>]`

	it('creates without a flag exactly as before: two lines, no expiry, but a createdAt', async () => {
		await writeStore({ clients: [] })

		const { stdout } = await cli(['create', 'plain', 'board-one'])

		expect(stdout.trimEnd().split('\n')).toHaveLength(2)
		const { data } = await readStore(file)
		expect(data.clients[0]).not.toHaveProperty('expiresAt')
		expect(typeof data.clients[0].createdAt).toBe('string')
	}, 30000)

	it('stores a relative expiry from now and prints it as a third line', async () => {
		await writeStore({ clients: [] })
		const before = Date.now()

		const { stdout } = await cli(['create', 'soon', 'board-one', 'read', '--expires', '30d'])

		const lines = stdout.trimEnd().split('\n')
		expect(lines).toHaveLength(3)
		const { data } = await readStore(file)
		const stored = Date.parse(data.clients[0].expiresAt as string)
		expect(stored).toBeGreaterThanOrEqual(before + 30 * 86_400_000)
		expect(stored).toBeLessThanOrEqual(Date.now() + 30 * 86_400_000)
		expect(lines[2]).toBe(`Expires ${data.clients[0].expiresAt}`)
	}, 30000)

	it('understands hours, an absolute timestamp, the = form, and the flag before the positionals', async () => {
		await writeStore({ clients: [] })
		const before = Date.now()

		await cli(['create', 'hours', 'board-one', '--expires', '12h'])
		await cli(['create', 'absolute', 'board-one', 'read', '--expires', '2099-01-01T00:00:00Z'])
		await cli(['create', 'equals', 'board-one', 'read', '--expires=2099-06-01T00:00:00Z'])
		await cli(['create', '--expires', '2099-07-01T00:00:00Z', 'leading', 'board-one'])

		const { data } = await readStore(file)
		const byName = Object.fromEntries(data.clients.map((client) => [client.name, client.expiresAt as string]))
		expect(Date.parse(byName.hours)).toBeGreaterThanOrEqual(before + 12 * 3_600_000)
		expect(Date.parse(byName.hours)).toBeLessThanOrEqual(Date.now() + 12 * 3_600_000)
		expect(byName.absolute).toBe('2099-01-01T00:00:00.000Z')
		expect(byName.equals).toBe('2099-06-01T00:00:00.000Z')
		expect(byName.leading).toBe('2099-07-01T00:00:00.000Z')
	}, 60000)

	it('rejects a bad expiry with the usage that mentions the flag, and writes nothing', async () => {
		const source = await writeStore(storeWithMetadata())

		for (const args of [['--expires', 'soon'], ['--expires', '0d'], ['--expires', '30w'], ['--expires']]) {
			const result = await failure(['create', 'bad', 'board-one', ...args])
			expect(result, args.join(' ')).not.toBeNull()
			expect(result?.code).not.toBe(0)
			expect(result?.stderr, args.join(' ')).toContain(FLAG_USAGE)
		}
		const past = await failure(['create', 'bad', 'board-one', '--expires', '2020-01-01T00:00:00Z'])
		expect(past?.code).not.toBe(0)
		expect(past?.stderr).toContain('Expiry must be in the future')

		expect(await readFile(file, 'utf8')).toBe(source)
		expect(await entries()).toEqual(['api-tokens.json'])
	}, 60000)

	it('keeps the original usage text, with no mention of the flag, for the original failures', async () => {
		await writeStore(storeWithMetadata())

		const result = await failure(['create', 'bad name', 'board-one'])

		expect(result?.stderr).toContain(CREATE_USAGE)
		expect(result?.stderr).not.toContain('--expires')
	}, 30000)

	it('refuses the flags on commands they do not belong to', async () => {
		const source = await writeStore(storeWithMetadata())

		expect((await failure(['revoke', 'legacy-client', '--expires', '3d']))?.stderr).toContain('Usage: revoke <client-name>')
		expect((await failure(['revoke', 'legacy-client', '--long']))?.stderr).toContain('Usage: revoke <client-name>')
		expect((await failure(['list', '--expires', '3d']))?.stderr).toContain('Usage: list [--long]')
		expect((await failure(['create', 'x', 'board-one', '--long']))?.stderr).toContain(CREATE_USAGE)

		expect(await readFile(file, 'utf8')).toBe(source)
	}, 60000)

	it('lists exactly as before by default, and adds createdAt, expiresAt and status with --long', async () => {
		await writeStore({
			clients: [
				{ name: 'legacy', tokenHash: legacyHash, rooms: ['a'], permissions: ['read'] },
				{ name: 'live', tokenHash: legacyHash, rooms: ['a', 'b'], permissions: ['read', 'write'], createdAt: '2026-10-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z' },
				{ name: 'gone', tokenHash: legacyHash, rooms: ['a'], permissions: ['read'], createdAt: '2000-01-01T00:00:00.000Z', expiresAt: '2000-06-01T00:00:00.000Z' },
			],
		})

		expect((await cli(['list'])).stdout).toBe('legacy\ta\tread\nlive\ta,b\tread,write\ngone\ta\tread\n')
		expect((await cli(['list', '--long'])).stdout).toBe(
			'legacy\ta\tread\t-\t-\tnone\n' +
			'live\ta,b\tread,write\t2026-10-01T00:00:00.000Z\t2099-01-01T00:00:00.000Z\tactive\n' +
			'gone\ta\tread\t2000-01-01T00:00:00.000Z\t2000-06-01T00:00:00.000Z\texpired\n',
		)
	}, 60000)
})

describe('the store never grows past what the reader can parse', () => {
	const filler = (count: number) => Array.from({ length: count }, (_, index) => ({ name: `filler-${index}`, tokenHash: createHash('sha256').update(`filler-${index}`).digest('hex'), rooms: ['elsewhere'], permissions: ['read'] }))

	it('allows the client that fills the store exactly to its limit', async () => {
		await writeStore({ clients: filler(store.MAX_CLIENTS - 1) })

		await createClient({ file, name: 'last-one', rooms: ['board-one'], access: 'read' })

		expect((await readStore(file)).data.clients).toHaveLength(store.MAX_CLIENTS)
	})

	it('refuses the client that would cross the limit, and writes nothing', async () => {
		const source = await writeStore({ clients: filler(store.MAX_CLIENTS) })

		const failure = await createClient({ file, name: 'one-too-many', rooms: ['board-one'], access: 'read' }).catch((error) => error)

		expect(failure).toBeInstanceOf(TokenStoreError)
		expect((failure as TokenStoreError).code).toBe('store-full')
		expect(await readFile(file, 'utf8')).toBe(source)
		expect(await entries()).toEqual(['api-tokens.json'])
	})

	it('is the same limit the request-time reader enforces: a full store still authenticates, one over locks everyone out', async () => {
		const previous = process.env.CANVAS_API_TOKENS_FILE
		process.env.CANVAS_API_TOKENS_FILE = file
		try {
			const { authorizeApiToken } = await import('../server/tokens.ts')
			await writeStore({ clients: filler(store.MAX_CLIENTS - 1) })
			const { token } = await createClient({ file, name: 'real-one', rooms: ['board-one'], access: 'read' })
			expect(authorizeApiToken(`Bearer ${token}`, 'board-one', 'read')).toBe('real-one')

			// What the refusal above protects against: a store one client over the limit parses to nothing.
			const over = await readStore(file)
			over.data.clients.push({ name: 'smuggled', tokenHash: 'c'.repeat(64), rooms: ['x'], permissions: ['read'] })
			await writeStore(over.data)
			expect(authorizeApiToken(`Bearer ${token}`, 'board-one', 'read')).toBeNull()
		} finally {
			if (previous === undefined) delete process.env.CANVAS_API_TOKENS_FILE
			else process.env.CANVAS_API_TOKENS_FILE = previous
		}
	})

	it('tells the operator at the CLI, with a non-zero exit', async () => {
		const source = await writeStore({ clients: filler(store.MAX_CLIENTS) })

		const result = await run(process.execPath, ['scripts/manage-api-tokens.mjs', 'create', 'one-too-many', 'board-one'], { cwd: repositoryRoot, env: { ...process.env, CANVAS_API_TOKENS_FILE: file } }).then(() => null, (error) => error as { code: number; stderr: string })

		expect(result?.code).not.toBe(0)
		expect(result?.stderr).toContain('maximum of 100 clients')
		expect(await readFile(file, 'utf8')).toBe(source)
	}, 30000)
})

describe('a fingerprint pins one exact credential', () => {
	const sha = (value: string) => createHash('sha256').update(value).digest('hex')

	it('is 16 hex characters, stable, distinct per credential, and reveals nothing of the hash', () => {
		const first = store.clientFingerprint(sha('a'))

		expect(first).toMatch(/^[0-9a-f]{16}$/)
		expect(store.clientFingerprint(sha('a'))).toBe(first)
		expect(store.clientFingerprint(sha('b'))).not.toBe(first)
		expect(sha('a')).not.toContain(first)
		expect(sha('a').startsWith(first)).toBe(false)
	})

	it('is reported for a new client and for a described one, and matches the stored hash', async () => {
		await writeStore({ clients: [] })

		const { token, fingerprint } = await createClient({ file, name: 'pinned', rooms: ['board-one'], access: 'read' })

		expect(fingerprint).toBe(store.clientFingerprint(sha(token)))
		expect((await store.describeClients(file))[0].fingerprint).toBe(fingerprint)
	})
})

describe('revoking and rotating decide inside the lock, on the record they change', () => {
	const sha = (value: string) => createHash('sha256').update(value).digest('hex')
	const record = (name: string, extra: Record<string, unknown> = {}) => ({ name, tokenHash: sha(name), rooms: ['board-one'], permissions: ['read'], ...extra })
	const fingerprintOf = (name: string) => store.clientFingerprint(sha(name))

	it('runs the authorise callback while the lock is held, on the freshly read record', async () => {
		await writeStore({ clients: [record('target')] })
		const seen: { locked?: boolean; hash?: unknown } = {}

		await revokeClient(file, 'target', { authorise: (client) => { seen.locked = existsSync(`${file}.lock`); seen.hash = client.tokenHash } })

		expect(seen).toEqual({ locked: true, hash: sha('target') })
		expect(await entries()).not.toContain('api-tokens.json.lock')
	})

	it('runs the same check for rotate', async () => {
		await writeStore({ clients: [record('target')] })
		let locked = false

		await store.rotateClient({ file, name: 'target', authorise: () => { locked = existsSync(`${file}.lock`) } })

		expect(locked).toBe(true)
	})

	it('writes nothing, and releases the lock, when authorise refuses', async () => {
		const source = await writeStore({ clients: [record('target')] })

		for (const attempt of [
			() => revokeClient(file, 'target', { authorise: () => { throw new Error('not yours') } }),
			() => store.rotateClient({ file, name: 'target', authorise: () => { throw new Error('not yours') } }),
		]) {
			await expect(attempt()).rejects.toThrow(/not yours/)
		}

		expect(await readFile(file, 'utf8')).toBe(source)
		expect(await entries()).toEqual(['api-tokens.json'])
	})

	it('refuses an authorise callback that returns anything, so an async refusal cannot be lost', async () => {
		const source = await writeStore({ clients: [record('target')] })
		// An async callback that refuses returns a rejected promise. The module discards it, which is the hazard under
		// test; the handler below only stops the test runner from reporting that deliberate rejection as an unhandled one.
		const asynchronous = () => {
			const refusal = Promise.reject(new Error('refused, but nobody is awaiting this'))
			refusal.catch(() => {})
			return refusal
		}

		await expect(revokeClient(file, 'target', { authorise: asynchronous as never })).rejects.toThrow(/synchronous/)
		await expect(store.rotateClient({ file, name: 'target', authorise: asynchronous as never })).rejects.toThrow(/synchronous/)

		expect(await readFile(file, 'utf8')).toBe(source)
		expect(await entries()).toEqual(['api-tokens.json'])
	})

	it('cannot be aimed at a record that has been replaced under the same name', async () => {
		await writeStore({ clients: [record('reused')] })
		const stale = fingerprintOf('reused')
		await revokeClient(file, 'reused')
		await writeStore({ clients: [{ ...record('reused'), tokenHash: sha('the successor'), rooms: ['somewhere-else'] }] })
		const source = await readFile(file, 'utf8')

		for (const attempt of [
			() => revokeClient(file, 'reused', { fingerprint: stale }),
			() => store.rotateClient({ file, name: 'reused', fingerprint: stale }),
		]) {
			const failure = await attempt().catch((error) => error)
			expect(failure).toBeInstanceOf(TokenStoreError)
			expect((failure as TokenStoreError).code).toBe('stale-reference')
		}

		expect(await readFile(file, 'utf8')).toBe(source)
	})

	it('does not call authorise on a record the fingerprint ruled out', async () => {
		await writeStore({ clients: [record('reused')] })
		let called = false

		await revokeClient(file, 'reused', { fingerprint: '0000000000000000', authorise: () => { called = true } }).catch(() => {})

		expect(called).toBe(false)
	})

	it('removes only the pinned record when a hand-edited store holds two with one name, and both without a pin', async () => {
		const twin = { ...record('twin'), tokenHash: sha('the other twin') }
		await writeStore({ clients: [record('twin'), twin, record('bystander')] })

		await revokeClient(file, 'twin', { fingerprint: fingerprintOf('twin') })
		expect((await readStore(file)).data.clients.map((client) => client.tokenHash)).toEqual([sha('the other twin'), sha('bystander')])

		await writeStore({ clients: [record('twin'), twin, record('bystander')] })
		await revokeClient(file, 'twin')
		expect((await readStore(file)).data.clients.map((client) => client.name)).toEqual(['bystander'])
	})

	it('still reports an unknown name as not-found, pinned or not', async () => {
		await writeStore({ clients: [record('present')] })

		for (const attempt of [() => revokeClient(file, 'absent'), () => revokeClient(file, 'absent', { fingerprint: fingerprintOf('absent') }), () => store.rotateClient({ file, name: 'absent' })]) {
			const failure = await attempt().catch((error) => error)
			expect((failure as TokenStoreError).code).toBe('not-found')
		}
	})
})

describe('rotateClient replaces the credential and nothing else', () => {
	const sha = (value: string) => createHash('sha256').update(value).digest('hex')
	const NOW = new Date('2026-10-08T12:00:00.000Z')

	function populated() {
		return {
			schemaVersion: 7,
			somethingNobodyHasInventedYet: { deeply: ['nested'] },
			clients: [
				{
					name: 'target', tokenHash: sha('old secret'), rooms: ['board-one', 'board-two'], permissions: ['read', 'write'],
					createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z', displayName: 'The target', createdByUserId: 'user-42', somethingNew: { a: 1 },
				},
				{ name: 'bystander', tokenHash: sha('bystander'), rooms: ['board-one'], permissions: ['read'] },
			],
		}
	}

	it('swaps the hash, stamps rotatedAt, and keeps every other field of the record and of the store', async () => {
		await writeStore(populated())

		const result = await store.rotateClient({ file, name: 'target', now: NOW })

		const { data } = await readStore(file)
		expect(data.clients[0]).toEqual({ ...populated().clients[0], tokenHash: sha(result.token), rotatedAt: '2026-10-08T12:00:00.000Z' })
		expect(data.clients[1]).toEqual(populated().clients[1])
		expect(data.schemaVersion).toBe(7)
		expect(data.somethingNobodyHasInventedYet).toEqual({ deeply: ['nested'] })
		expect(result).toMatchObject({ name: 'target', rooms: ['board-one', 'board-two'], permissions: ['read', 'write'], createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z', rotatedAt: '2026-10-08T12:00:00.000Z' })
		expect(result.fingerprint).toBe(store.clientFingerprint(sha(result.token)))
		expect(result.fingerprint).not.toBe(store.clientFingerprint(sha('old secret')))
	})

	it('backs up the exact bytes it read, and never stores the token', async () => {
		const source = await writeStore(populated())

		const { token } = await store.rotateClient({ file, name: 'target' })

		const copies = await backups()
		expect(copies).toHaveLength(1)
		expect(await readFile(join(directory, copies[0]), 'utf8')).toBe(source)
		for (const entry of await entries()) expect(await readFile(join(directory, entry), 'utf8'), entry).not.toContain(token)
	})

	it('keeps the rotated store readable only by the owner', async () => {
		await writeStore(populated())

		await store.rotateClient({ file, name: 'target' })

		expect(await mode(file)).toBe(0o600)
	})

	it('kills the old token and accepts the new one, as seen by the request-time reader', async () => {
		const previous = process.env.CANVAS_API_TOKENS_FILE
		process.env.CANVAS_API_TOKENS_FILE = file
		try {
			const { authorizeApiToken } = await import('../server/tokens.ts')
			await writeStore({ clients: [] })
			const created = await createClient({ file, name: 'agent', rooms: ['board-one'], access: 'read' })
			expect(authorizeApiToken(`Bearer ${created.token}`, 'board-one', 'read')).toBe('agent')

			const rotated = await store.rotateClient({ file, name: 'agent' })

			expect(authorizeApiToken(`Bearer ${created.token}`, 'board-one', 'read')).toBeNull()
			expect(authorizeApiToken(`Bearer ${rotated.token}`, 'board-one', 'read')).toBe('agent')
		} finally {
			if (previous === undefined) delete process.env.CANVAS_API_TOKENS_FILE
			else process.env.CANVAS_API_TOKENS_FILE = previous
		}
	})

	it('replaces the expiry only when a new one is supplied', async () => {
		await writeStore(populated())

		await store.rotateClient({ file, name: 'target', expiresAt: '2098-06-01T00:00:00Z', now: NOW })

		expect((await readStore(file)).data.clients[0].expiresAt).toBe('2098-06-01T00:00:00.000Z')
	})

	it('refuses to rotate an expired or unreadable-expiry client without a new expiry, and writes nothing', async () => {
		for (const expiresAt of ['2000-01-01T00:00:00.000Z', 'garbage']) {
			const data = populated()
			data.clients[0].expiresAt = expiresAt
			const source = await writeStore(data)

			const failure = await store.rotateClient({ file, name: 'target', now: NOW }).catch((error) => error)

			expect((failure as TokenStoreError).code, expiresAt).toBe('invalid-expiry')
			expect(await readFile(file, 'utf8')).toBe(source)
			expect(await entries()).toEqual(['api-tokens.json'])
		}
	})

	it('revives an expired client when a new expiry is supplied, and refuses a new expiry in the past', async () => {
		const data = populated()
		data.clients[0].expiresAt = '2000-01-01T00:00:00.000Z'
		await writeStore(data)

		const refused = await store.rotateClient({ file, name: 'target', expiresAt: '2001-01-01T00:00:00Z', now: NOW }).catch((error) => error)
		expect((refused as TokenStoreError).code).toBe('invalid-expiry')

		const revived = await store.rotateClient({ file, name: 'target', expiresAt: '2098-06-01T00:00:00Z', now: NOW })
		expect(revived.expiresAt).toBe('2098-06-01T00:00:00.000Z')
		expect(store.evaluateExpiry((await readStore(file)).data.clients[0].expiresAt, NOW.getTime())).toBe('active')
	})

	it('rotates a client that never had any metadata, and does not invent a createdAt or an expiry', async () => {
		await writeStore({ clients: [{ name: 'bare', tokenHash: sha('bare'), rooms: ['board-one'], permissions: ['read'] }] })

		const result = await store.rotateClient({ file, name: 'bare', now: NOW })

		expect(result).not.toHaveProperty('createdAt')
		expect(result).not.toHaveProperty('expiresAt')
		const [client] = (await readStore(file)).data.clients
		expect(Object.keys(client).sort()).toEqual(['name', 'permissions', 'rooms', 'rotatedAt', 'tokenHash'])
	})

	it('refuses a name that appears twice rather than half-rotating it, and an invalid name', async () => {
		const source = await writeStore({ clients: [{ name: 'twin', tokenHash: sha('one'), rooms: ['a'], permissions: ['read'] }, { name: 'twin', tokenHash: sha('two'), rooms: ['a'], permissions: ['read'] }] })

		const duplicate = await store.rotateClient({ file, name: 'twin' }).catch((error) => error)
		const invalid = await store.rotateClient({ file, name: 'bad name' }).catch((error) => error)

		expect((duplicate as TokenStoreError).code).toBe('duplicate-name')
		expect((invalid as TokenStoreError).code).toBe('invalid-name')
		expect(await readFile(file, 'utf8')).toBe(source)
	})

	it('is refused while another operation holds the lock', async () => {
		const source = await writeStore(populated())
		await writeFile(`${file}.lock`, 'held-by-someone-else\n', { mode: 0o600 })

		const failure = await store.rotateClient({ file, name: 'target' }).catch((error) => error)

		expect((failure as TokenStoreError).code).toBe('locked')
		expect(await readFile(file, 'utf8')).toBe(source)
	})

	it('leaves the store on the old credential, and the failure free of the new token, when the write fails', async () => {
		await writeStore(populated())
		process.env.CANVAS_API_TOKENS_TEST_FAILPOINT = 'before-rename'

		const failure = await store.rotateClient({ file, name: 'target' }).catch((error) => error)

		expect((failure as Error).message).toBe('Injected failure before token-store rename')
		expect(await readFile(file, 'utf8')).toContain(sha('old secret'))
		expect(await temporaries()).toHaveLength(0)
	})
})
