/**
 * Tests the acceptance fixture itself (production-safety guard, isolation, cleanup), then uses
 * it to run the local/automated half of the app-auth authorization matrix: anonymous, an
 * authenticated nonmember, viewer, editor, and owner against board reads, WebSocket connect,
 * assets, history/checkpoint/restore, semantic context/actions, and AI events.
 *
 * This does not touch whiteboard.example.com or any other real host - every request
 * here is `app.inject()` against an in-process Fastify instance backed by a throwaway OS-temp
 * directory. It closes the loop the recorded 2026-09-25/28 public runs left open (11 PASS / 0
 * FAIL / 8 BLOCKED, blocked only on account-dependent phases) by proving the same authorization
 * boundaries the moment four real identities exist, without needing production credentials. The
 * one remaining real public four-session run is still required before the migration is declared
 * complete - see docs/deployments/2026-09-28-acceptance-fixture.md.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
	assertSafeFixtureDataDirectory,
	createAcceptanceFixture,
	type AcceptanceFixture,
	type FixtureIdentity,
} from './helpers/acceptance-fixture'

const fixtures: AcceptanceFixture[] = []
async function fixture(options?: Parameters<typeof createAcceptanceFixture>[0]) {
	const built = await createAcceptanceFixture(options)
	fixtures.push(built)
	return built
}
afterEach(async () => { for (const built of fixtures.splice(0)) await built.cleanup() })

/* ============================================================== fixture self-tests -- */

describe('assertSafeFixtureDataDirectory', () => {
	it('accepts a real mkdtempSync directory under the OS temp root', () => {
		const directory = mkdtempSync(join(tmpdir(), 'canvas-acceptance-guard-test-'))
		try {
			expect(() => assertSafeFixtureDataDirectory(directory)).not.toThrow()
		} finally {
			rmSync(directory, { recursive: true, force: true })
		}
	})

	it('refuses the real production checkout path', () => {
		expect(() => assertSafeFixtureDataDirectory('/home/app/apps/collaborative-ai-canvas/data')).toThrow(/production/i)
	})

	it('refuses a Windows-style production-shaped path', () => {
		expect(() => assertSafeFixtureDataDirectory('C:\\srv\\apps\\collaborative-ai-canvas\\data')).toThrow(/production/i)
	})

	it('refuses any path outside the OS temp directory, even an otherwise innocuous one', () => {
		// A bare Windows-shaped literal like "C:\\Users\\..." only tests this on win32: on POSIX
		// it isn't absolute, so `resolve()` treats it as relative to whatever the test runner's
		// CWD happens to be - which is a real, tmpdir-nested CWD in a production cherry-pick
		// rehearsal, and would make this pass for the wrong reason. Building an absolute sibling
		// of the real OS temp root (guaranteed absolute and guaranteed distinct from it, on every
		// platform, regardless of CWD) tests the actual guard rather than an accident of where
		// the suite happens to run from.
		const siblingOfTemp = join(dirname(resolve(tmpdir())), 'definitely-not-the-os-temp-directory')
		expect(() => assertSafeFixtureDataDirectory(siblingOfTemp)).toThrow(/temp/i)
	})

	it('refuses the conventional relative production data directory', () => {
		// Same CWD-independence concern as above: resolve it explicitly against a realistic
		// production working directory rather than the bare relative string, whose resolution
		// (and thus this test's correctness) would otherwise depend on the CWD the suite happens
		// to run from.
		const asResolvedFromProduction = resolve('/home/app/apps/collaborative-ai-canvas', 'data')
		expect(() => assertSafeFixtureDataDirectory(asResolvedFromProduction)).toThrow(/temp/i)
	})
})

describe('createAcceptanceFixture: isolation and cleanup', () => {
	it('ignores an ambient CANVAS_AUTH_DB_FILE pointing somewhere else entirely', async () => {
		const decoyDirectory = mkdtempSync(join(tmpdir(), 'canvas-acceptance-decoy-'))
		const decoyAuthDb = join(decoyDirectory, 'decoy-auth.sqlite')
		writeFileSync(decoyAuthDb, '')
		const previous = process.env.CANVAS_AUTH_DB_FILE
		process.env.CANVAS_AUTH_DB_FILE = decoyAuthDb
		try {
			const built = await fixture()
			expect(built.owner.userId).toBeTruthy()
			// If the fixture had honored the ambient env var instead of isolating it, the owner
			// registration above would have written through Fastify into the decoy file.
			expect(readFileSync(decoyAuthDb, 'utf8')).toBe('')
			// The env var is isolated (deleted) for the fixture's lifetime, not merely ignored once.
			expect(process.env.CANVAS_AUTH_DB_FILE).toBeUndefined()
			// cleanup() must restore whatever the ambient environment had before the fixture ran.
			fixtures.pop()
			await built.cleanup()
			expect(process.env.CANVAS_AUTH_DB_FILE).toBe(decoyAuthDb)
		} finally {
			if (previous === undefined) delete process.env.CANVAS_AUTH_DB_FILE
			else process.env.CANVAS_AUTH_DB_FILE = previous
			rmSync(decoyDirectory, { recursive: true, force: true })
		}
	})

	it('creates four distinct sessions, not one cookie mutated four times', async () => {
		const { owner, editor, viewer, nonmember } = await fixture()
		const cookies = [owner, editor, viewer, nonmember].map((identity) => identity.userId)
		expect(new Set(cookies).size).toBe(4)
		const [ownerMe, editorMe, viewerMe, nonmemberMe] = await Promise.all(
			[owner, editor, viewer, nonmember].map((identity) => identity.get('/api/auth/me'))
		)
		expect(ownerMe.json().user.id).toBe(owner.userId)
		expect(editorMe.json().user.id).toBe(editor.userId)
		expect(viewerMe.json().user.id).toBe(viewer.userId)
		expect(nonmemberMe.json().user.id).toBe(nonmember.userId)
	})

	it('assigns the four roles correctly, including leaving the nonmember with no membership', async () => {
		const { owner, editor, viewer, nonmember, boardId } = await fixture()
		const members = await owner.get(`/api/boards/${boardId}/members`)
		const roleByUserId = new Map(members.json().members.map((member: { userId: string; role: string }) => [member.userId, member.role]))
		expect(roleByUserId.get(owner.userId)).toBe('owner')
		expect(roleByUserId.get(editor.userId)).toBe('editor')
		expect(roleByUserId.get(viewer.userId)).toBe('viewer')
		expect(roleByUserId.has(nonmember.userId!)).toBe(false)
	})

	it('genuinely removes the data directory on cleanup, not just closing the app', async () => {
		const built = await fixture()
		const directory = built.directory
		expect(existsSync(directory)).toBe(true)
		fixtures.pop()
		await built.cleanup()
		expect(existsSync(directory)).toBe(false)
	})
})

/* ============================================================ authorization matrix -- */

interface Case { label: string; run: (identity: FixtureIdentity) => Promise<{ statusCode: number }>; expected: (role: string) => number }

async function assertMatrix(f: AcceptanceFixture, cases: Case[]) {
	const identities: Array<[string, FixtureIdentity]> = [
		['anonymous', f.anonymous],
		['nonmember', f.nonmember],
		['viewer', f.viewer],
		['editor', f.editor],
		['owner', f.owner],
	]
	for (const testCase of cases) {
		for (const [role, identity] of identities) {
			const response = await testCase.run(identity)
			expect(response.statusCode, `${testCase.label} as ${role}`).toBe(testCase.expected(role))
		}
	}
}

describe('board read authorization', () => {
	it('board metadata, canvas, and semantic context: 401 anonymous, 404 nonmember, 200 for every member', async () => {
		const f = await fixture()
		await assertMatrix(f, [
			{ label: 'GET board metadata', run: (identity) => identity.get(`/api/boards/${f.boardId}`), expected: (role) => role === 'anonymous' ? 401 : role === 'nonmember' ? 404 : 200 },
			{ label: 'GET canvas', run: (identity) => identity.get(`/api/rooms/${f.boardId}/canvas`), expected: (role) => role === 'anonymous' ? 401 : role === 'nonmember' ? 404 : 200 },
			{ label: 'GET semantic context', run: (identity) => identity.get(`/api/rooms/${f.boardId}/semantic-context`), expected: (role) => role === 'anonymous' ? 401 : role === 'nonmember' ? 404 : 200 },
			{ label: 'GET history', run: (identity) => identity.get(`/api/boards/${f.boardId}/history`), expected: (role) => role === 'anonymous' ? 401 : role === 'nonmember' ? 404 : 200 },
			{ label: 'GET checkpoints', run: (identity) => identity.get(`/api/boards/${f.boardId}/checkpoints`), expected: (role) => role === 'anonymous' ? 401 : role === 'nonmember' ? 404 : 200 },
		])
	})

	it('asset read: 401 anonymous, 404 nonmember, 200 for every member', async () => {
		const f = await fixture()
		const upload = await f.owner.request(
			'POST',
			`/api/boards/${f.boardId}/uploads/fixture-photo.bin`,
			Buffer.from('fixture-bytes'),
			{ 'content-type': 'application/octet-stream' }
		)
		expect(upload.statusCode).toBe(200)
		await assertMatrix(f, [
			{ label: 'GET asset', run: (identity) => identity.get(`/api/boards/${f.boardId}/assets/fixture-photo.bin`), expected: (role) => role === 'anonymous' ? 401 : role === 'nonmember' ? 404 : 200 },
		])
	})
})

describe('mutation authorization', () => {
	it('canvas write and semantic entity creation: viewer denied (403), editor/owner allowed, nonmember 404, anonymous 401', async () => {
		const f = await fixture()
		await assertMatrix(f, [
			{
				label: 'POST canvas action',
				run: (identity) => identity.post(`/api/rooms/${f.boardId}/actions`, { actions: [{ tool: 'create_text', id: `shape:matrix-${identity.role}`, text: 'x', x: 0, y: 0 }] }),
				expected: (role) => role === 'anonymous' ? 401 : role === 'nonmember' ? 404 : role === 'viewer' ? 403 : 200,
			},
			{
				label: 'POST semantic entity creation',
				run: (identity) => identity.post(`/api/rooms/${f.boardId}/actions`, { actions: [{ tool: 'create_entity', id: `engineering_entity:matrix-${identity.role}`, entityType: 'component', title: 'Matrix component' }] }),
				expected: (role) => role === 'anonymous' ? 401 : role === 'nonmember' ? 404 : role === 'viewer' ? 403 : 200,
			},
			{
				label: 'POST AI lifecycle event',
				run: (identity) => identity.post(`/api/rooms/${f.boardId}/ai/events`, { eventType: 'ai.requested' }),
				expected: (role) => role === 'anonymous' ? 401 : role === 'nonmember' ? 404 : role === 'viewer' ? 403 : 200,
			},
		])
	})

	it("a viewer's rejected mutation is not just an HTTP status - the entity was never created", async () => {
		const f = await fixture()
		const attempt = await f.viewer.post(`/api/rooms/${f.boardId}/actions`, {
			actions: [{ tool: 'create_entity', id: 'engineering_entity:should-not-exist', entityType: 'component', title: 'Should not exist' }],
		})
		expect(attempt.statusCode).toBe(403)
		const context = await f.owner.get(`/api/rooms/${f.boardId}/semantic-context`)
		expect(context.json().entities).toEqual([])
	})

	it('checkpoint creation and restore: viewer denied (403), editor/owner allowed', async () => {
		const f = await fixture()
		await f.owner.post(`/api/rooms/${f.boardId}/actions`, { actions: [{ tool: 'create_text', id: 'shape:pre-checkpoint', text: 'before', x: 0, y: 0 }] })
		await assertMatrix(f, [
			{
				label: 'POST checkpoint',
				run: (identity) => identity.post(`/api/boards/${f.boardId}/checkpoints`, { label: `by-${identity.role}` }),
				expected: (role) => role === 'anonymous' ? 401 : role === 'nonmember' ? 404 : role === 'viewer' ? 403 : 200,
			},
		])
		const canvas = await f.owner.get(`/api/rooms/${f.boardId}/canvas`)
		const history = await f.owner.get(`/api/boards/${f.boardId}/history`)
		const createdEvent = history.json().events.find((event: { eventType: string }) => event.eventType === 'object.created')
		const restoreAttempt = await f.viewer.post(`/api/boards/${f.boardId}/restore`, { eventId: createdEvent.id, expectedClock: canvas.json().clock })
		expect(restoreAttempt.statusCode).toBe(403)
		const restoreAllowed = await f.editor.post(`/api/boards/${f.boardId}/restore`, { eventId: createdEvent.id, expectedClock: canvas.json().clock })
		expect(restoreAllowed.statusCode).toBe(200)
	})

	it('owner-only board administration: editor and viewer denied (403), owner allowed', async () => {
		const f = await fixture()
		const editorRename = await f.editor.patch(`/api/boards/${f.boardId}`, { name: 'Renamed by editor' })
		expect(editorRename.statusCode).toBe(403)
		const viewerRoleChange = await f.viewer.put(`/api/boards/${f.boardId}/members/${f.editor.userId}`, { role: 'viewer' })
		expect(viewerRoleChange.statusCode).toBe(403)
		const ownerRename = await f.owner.patch(`/api/boards/${f.boardId}`, { name: 'Renamed by owner' })
		expect(ownerRename.statusCode).toBe(200)
	})
})

describe('WebSocket authorization', () => {
	it('the real connect handshake: anonymous and nonmember are closed with policy code 1008; owner, editor, and viewer open', async () => {
		const f = await fixture()
		const [anonymous, nonmember, viewer, editor, owner] = await Promise.all([
			f.anonymous.connectBoardSocket(),
			f.nonmember.connectBoardSocket(),
			f.viewer.connectBoardSocket(),
			f.editor.connectBoardSocket(),
			f.owner.connectBoardSocket(),
		])
		expect(anonymous.state, 'anonymous').toBe('closed')
		if (anonymous.state === 'closed') expect(anonymous.code).toBe(1008)
		expect(nonmember.state, 'nonmember').toBe('closed')
		if (nonmember.state === 'closed') expect(nonmember.code).toBe(1008)
		expect(viewer.state, 'viewer').toBe('open')
		expect(editor.state, 'editor').toBe('open')
		expect(owner.state, 'owner').toBe('open')
	})

	it('the HTTP upgrade completing is not evidence of authorization: an unauthorized socket still closes after connecting', async () => {
		// Regression guard for the finding recorded in the 2026-09-25 acceptance evidence: a
		// naive check for "did the WebSocket open" would have reported an unauthorized socket as
		// successful, because the close arrives just after the upgrade rather than during it.
		const f = await fixture()
		const outcome = await f.nonmember.connectBoardSocket()
		expect(outcome.state).toBe('closed')
	})
})

describe('invitation lifecycle (real registration/invitation path, not the fixture shortcut)', () => {
	it('two fixtures are genuinely isolated: a token minted in one is unknown to the other', async () => {
		const f = await fixture()
		const invite = await f.owner.post('/api/invitations', {})
		const token = invite.json().token as string
		const second = await createAcceptanceFixture()
		fixtures.push(second)
		const registered = await second.anonymous.post('/api/auth/register', { login: 'cross-fixture-applicant', displayName: 'Cross fixture applicant', password: 'irrelevant-test-password', invitationToken: token })
		expect(registered.statusCode).toBe(400)
	})

	it('registration without a valid invitation is rejected once open registration is off', async () => {
		const f = await fixture()
		const response = await f.anonymous.post('/api/auth/register', { login: 'uninvited', displayName: 'Uninvited', password: 'irrelevant-test-password' })
		expect(response.statusCode).toBe(403)
	})

	it('reusing an already-consumed account invitation token fails', async () => {
		const f = await fixture()
		const invite = await f.owner.post('/api/invitations', {})
		const token = invite.json().token as string
		const first = await f.anonymous.post('/api/auth/register', { login: 'first-use', displayName: 'First use', password: 'irrelevant-test-password', invitationToken: token })
		expect(first.statusCode).toBe(200)
		const second = await f.anonymous.post('/api/auth/register', { login: 'second-use', displayName: 'Second use', password: 'irrelevant-test-password', invitationToken: token })
		expect(second.statusCode).toBe(400)
	})
})
