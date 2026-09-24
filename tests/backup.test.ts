import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import DatabaseConstructor from 'better-sqlite3'
import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { buildApp } from '../server/app'

const REPO = process.cwd()
const TOOL = join(REPO, 'scripts', 'backup-canvas-data.py')

const python = (() => {
	const probe = spawnSync('python3', ['--version'], { encoding: 'utf8' })
	return probe.status === 0 ? 'python3' : null
})()

const cleanup: string[] = []
const apps: FastifyInstance[] = []

afterEach(async () => {
	for (const app of apps.splice(0)) {
		try { await app.close() } catch { /* already closed */ }
	}
	for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function runTool(args: string[]) {
	return spawnSync(python!, [TOOL, ...args], {
		encoding: 'utf8',
		timeout: 120_000,
		// The tool reads CANVAS_AUTH_DB_FILE from the environment; a stray value
		// from another test would point it at the wrong database.
		env: { ...process.env, CANVAS_AUTH_DB_FILE: undefined } as NodeJS.ProcessEnv,
	})
}

async function createInstance() {
	const directory = mkdtempSync(join(tmpdir(), 'canvas-backup-test-'))
	cleanup.push(directory)
	const clientDirectory = join(directory, 'client')
	mkdirSync(clientDirectory, { recursive: true })
	writeFileSync(join(clientDirectory, 'index.html'), '<!doctype html><html><body>canvas</body></html>')
	const app = await buildApp({
		dataDirectory: directory,
		clientDirectory,
		logger: false,
		// The concurrent writer below deliberately exceeds the production budget.
		rateLimits: { write: { limit: 100_000, windowMs: 60_000 } },
	})
	apps.push(app)

	const registered = await app.inject({
		method: 'POST',
		url: '/api/auth/register',
		headers: { origin: 'http://127.0.0.1:8787' },
		payload: { login: 'backup-owner', displayName: 'Backup Owner', password: 'correct horse battery staple' },
	})
	expect(registered.statusCode).toBe(200)
	const cookie = `${registered.cookies[0].name}=${registered.cookies[0].value}`

	const board = await app.inject({
		method: 'POST', url: '/api/boards',
		headers: { cookie, origin: 'http://127.0.0.1:8787' },
		payload: { name: 'Backup Board', id: 'backup-board' },
	})
	expect(board.statusCode).toBe(200)
	return { directory, app, cookie }
}

function write(app: FastifyInstance, cookie: string, index: number) {
	return app.inject({
		method: 'POST',
		url: '/api/rooms/backup-board/actions',
		headers: { cookie, origin: 'http://127.0.0.1:8787' },
		payload: { actions: [{ tool: 'create_text', id: `shape:n${index}`, text: `note ${index}`, x: index, y: index }] },
	})
}

describe.skipIf(!python)('verified backup tooling', () => {
	it('captures a consistent, integrity-checked image while the board is being written', async () => {
		const { directory, app, cookie } = await createInstance()
		const backupDirectory = mkdtempSync(join(tmpdir(), 'canvas-backup-out-'))
		cleanup.push(backupDirectory)

		// Seed shapes, then keep writing for the whole duration of the backup so
		// the room database has an active WAL while its pages are being copied.
		for (let index = 0; index < 10; index++) expect((await write(app, cookie, index)).statusCode).toBe(200)

		let index = 10
		let writing = true
		const writer = (async () => {
			while (writing) {
				await write(app, cookie, index++)
			}
			return index
		})()

		const result = runTool([
			'run', '--data-dir', directory, '--backup-dir', backupDirectory, '--no-mirror', '--no-config',
		])
		writing = false
		const written = await writer

		expect(result.stderr).toBe('')
		expect(result.status).toBe(0)
		expect(written).toBeGreaterThan(10)

		const archives = readdirSync(backupDirectory).filter((name) => name.endsWith('.tar.gz'))
		expect(archives).toHaveLength(1)

		const verified = runTool(['verify', join(backupDirectory, archives[0])])
		expect(verified.status).toBe(0)
		expect(verified.stdout).toContain('verify: OK')
		expect(verified.stdout).toContain('archive sha256 OK')

		// The live database must survive being backed up: the service keeps serving
		// and the board keeps accepting writes afterwards.
		expect((await write(app, cookie, 100_000)).statusCode).toBe(200)
		const canvas = await app.inject({ method: 'GET', url: '/api/rooms/backup-board/canvas', headers: { cookie } })
		expect(canvas.statusCode).toBe(200)
		expect(canvas.json().objects.length).toBeGreaterThan(10)
	}, 180_000)

	it('restores a usable data directory and refuses a tampered archive', async () => {
		const { directory, app, cookie } = await createInstance()
		const backupDirectory = mkdtempSync(join(tmpdir(), 'canvas-backup-out-'))
		const restoreDirectory = mkdtempSync(join(tmpdir(), 'canvas-restore-'))
		cleanup.push(backupDirectory, restoreDirectory)

		for (let index = 0; index < 5; index++) expect((await write(app, cookie, index)).statusCode).toBe(200)

		expect(runTool(['run', '--data-dir', directory, '--backup-dir', backupDirectory, '--no-mirror', '--no-config']).status).toBe(0)
		const archive = join(backupDirectory, readdirSync(backupDirectory).find((name) => name.endsWith('.tar.gz'))!)

		rmSync(restoreDirectory, { recursive: true, force: true })
		const restored = runTool(['restore', archive, '--target', restoreDirectory])
		expect(restored.status).toBe(0)

		// A restored database is a single self-contained file: no stale -wal/-shm.
		const restoredFiles = readdirSync(join(restoreDirectory, 'rooms'))
		expect(restoredFiles).toContain('backup-board.sqlite')
		expect(restoredFiles.filter((name) => name.endsWith('-wal') || name.endsWith('-shm'))).toHaveLength(0)

		const restoredRoom = new DatabaseConstructor(join(restoreDirectory, 'rooms', 'backup-board.sqlite'), { readonly: true })
		try {
			expect(restoredRoom.pragma('integrity_check', { simple: true })).toBe('ok')
			// tldraw's SQLite sync storage keeps records in `documents`; `objects`
			// exists in the schema but is unused at this version.
			const documents = restoredRoom.prepare('SELECT count(*) AS total FROM documents').get() as { total: number }
			expect(documents.total).toBeGreaterThan(0)
			const events = restoredRoom.prepare('SELECT count(*) AS total FROM history_events').get() as { total: number }
			expect(events.total).toBeGreaterThan(0)
		} finally {
			restoredRoom.close()
		}

		const restoredAuth = new DatabaseConstructor(join(restoreDirectory, 'auth.sqlite'), { readonly: true })
		try {
			const users = restoredAuth.prepare('SELECT count(*) AS total FROM users').get() as { total: number }
			expect(users.total).toBe(1)
		} finally {
			restoredAuth.close()
		}

		// --force onto a directory that already holds a live data set must be an
		// explicit act: overwriting files a running service has open corrupts it.
		const guarded = runTool(['restore', archive, '--target', restoreDirectory, '--force'])
		expect(guarded.status).not.toBe(0)
		expect(guarded.stderr).toContain('--service-stopped')

		// The sidecar covers the whole archive; the manifest only covers its contents.
		const sidecar = `${archive}.sha256`
		renameSync(sidecar, `${sidecar}.bak`)
		const emptyTarget = mkdtempSync(join(tmpdir(), 'canvas-restore-bare-'))
		cleanup.push(emptyTarget)
		rmSync(emptyTarget, { recursive: true, force: true })
		const unverified = runTool(['restore', archive, '--target', emptyTarget])
		expect(unverified.status).not.toBe(0)
		expect(unverified.stderr).toContain('sidecar')
		expect(runTool(['restore', archive, '--target', emptyTarget, '--allow-unverified']).status).toBe(0)
		renameSync(`${sidecar}.bak`, sidecar)

		// A corrupted archive must fail verification rather than be trusted.
		writeFileSync(archive, Buffer.concat([Buffer.from('tampered'), Buffer.from('\0')]))
		const tampered = runTool(['verify', archive])
		expect(tampered.status).not.toBe(0)
	}, 180_000)
})
