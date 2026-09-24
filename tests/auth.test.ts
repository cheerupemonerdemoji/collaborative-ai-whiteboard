import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { AuthError, AuthService, hashPassword, normalizeLogin, verifyPassword } from '../server/auth'

const cleanupDirectories: string[] = []

afterEach(() => {
	for (const directory of cleanupDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function createService(options: { now?: () => Date; sessionTtlMs?: number; invitationTtlMs?: number } = {}) {
	const directory = mkdtempSync(join(tmpdir(), 'canvas-auth-test-'))
	cleanupDirectories.push(directory)
	const databasePath = join(directory, 'auth.sqlite')
	const service = new AuthService({ databasePath, ...options })
	return { databasePath, service }
}

async function bootstrap(service: AuthService, login = 'Owner') {
	return service.bootstrapFirstUser({
		login,
		displayName: 'Board Owner',
		password: 'correct horse battery staple',
	})
}

function expectAuthCode(error: unknown, code: string): boolean {
	expect(error).toBeInstanceOf(AuthError)
	expect((error as AuthError).code).toBe(code)
	return true
}

describe('password credentials', () => {
	it('normalizes logins and verifies a bounded, salted scrypt hash', async () => {
		expect(normalizeLogin('  ALICE@example.com ')).toBe('alice@example.com')
		const encoded = await hashPassword('a secure passphrase')
		expect(encoded).toMatch(/^scrypt\$v1\$32768\$8\$1\$/)
		expect(encoded).not.toContain('a secure passphrase')
		await expect(verifyPassword('a secure passphrase', encoded)).resolves.toBe(true)
		await expect(verifyPassword('not the password', encoded)).resolves.toBe(false)
		await expect(verifyPassword('a secure passphrase', 'scrypt$v1$999999999$8$1$bad$bad')).resolves.toBe(false)
	})
})

describe('accounts and sessions', () => {
	it('bootstraps exactly one administrator and stores only the session-token hash', async () => {
		const { databasePath, service } = createService()
		const grant = await bootstrap(service)
		expect(grant.user).toMatchObject({ login: 'Owner', displayName: 'Board Owner', isAdmin: true })
		expect(grant.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
		expect(service.getCurrentSession(grant.token)?.user.id).toBe(grant.user.id)
		await expect(bootstrap(service, 'AnotherOwner')).rejects.toSatisfy((error: unknown) => expectAuthCode(error, 'bootstrap_complete'))

		const inspector = new Database(databasePath, { readonly: true })
		const stored = inspector.prepare('SELECT token_hash FROM sessions WHERE id = ?').get(grant.session.id) as { token_hash: string }
		expect(stored.token_hash).toBe(createHash('sha256').update(grant.token).digest('hex'))
		expect(stored.token_hash).not.toContain(grant.token)
		inspector.close()
		service.close()
	})

	it('requires a one-use invitation after bootstrap and grants a board-scoped role', async () => {
		const { service } = createService()
		const owner = await bootstrap(service)
		await expect(service.register({
			login: 'no-invite',
			displayName: 'No Invite',
			password: 'a sufficiently long password',
		})).rejects.toSatisfy((error: unknown) => expectAuthCode(error, 'invitation_required'))

		const board = service.createBoard(owner.user.id, 'Planning', 'planning')
		const invite = service.createInvitation(owner.user.id, {
			boardId: board.id,
			role: 'editor',
			invitedLogin: 'BOB',
		})
		const bob = await service.register({
			login: 'bob',
			displayName: 'Bob',
			password: 'another secure password',
			invitationToken: invite.token,
		})
		expect(service.getBoardRole(bob.user.id, board.id)).toBe('editor')
		await expect(service.register({
			login: 'charlie',
			displayName: 'Charlie',
			password: 'yet another secure password',
			invitationToken: invite.token,
		})).rejects.toSatisfy((error: unknown) => expectAuthCode(error, 'invalid_invitation'))
		service.close()
	})

	it('rejects expired invitations and prevents invitation role or board substitution', async () => {
		let now = new Date('2026-09-16T12:00:00.000Z')
		const { service } = createService({ now: () => now, invitationTtlMs: 5 * 60_000 })
		const owner = await bootstrap(service)
		const intended = service.createBoard(owner.user.id, 'Intended', 'intended')
		service.createBoard(owner.user.id, 'Other', 'other')
		const invite = service.createInvitation(owner.user.id, {
			boardId: intended.id,
			role: 'viewer',
			invitedLogin: 'guest',
		})

		now = new Date('2026-09-16T12:05:00.001Z')
		await expect(service.register({
			login: 'guest',
			displayName: 'Guest',
			password: 'another secure password',
			invitationToken: invite.token,
		})).rejects.toSatisfy((error: unknown) => expectAuthCode(error, 'invalid_invitation'))

		now = new Date('2026-09-16T12:00:00.000Z')
		const freshInvite = service.createInvitation(owner.user.id, {
			boardId: intended.id,
			role: 'viewer',
			invitedLogin: 'guest',
		})
		const guest = await service.register({
			login: 'guest',
			displayName: 'Guest',
			password: 'another secure password',
			invitationToken: freshInvite.token,
		})
		expect(service.getBoardRole(guest.user.id, intended.id)).toBe('viewer')
		expect(service.getBoardRole(guest.user.id, 'other')).toBeNull()
		service.close()
	})

	it('uses the same public failure for unknown, wrong-password, and disabled logins', async () => {
		const { service } = createService()
		const owner = await bootstrap(service)
		const invite = service.createInvitation(owner.user.id)
		const bob = await service.register({
			login: 'bob',
			displayName: 'Bob',
			password: 'another secure password',
			invitationToken: invite.token,
		})
		await expect(service.login({ login: 'missing', password: 'another secure password' }))
			.rejects.toSatisfy((error: unknown) => expectAuthCode(error, 'invalid_credentials'))
		await expect(service.login({ login: 'bob', password: 'incorrect secure password' }))
			.rejects.toSatisfy((error: unknown) => expectAuthCode(error, 'invalid_credentials'))
		service.setUserDisabled(owner.user.id, bob.user.id, true)
		await expect(service.login({ login: 'bob', password: 'another secure password' }))
			.rejects.toSatisfy((error: unknown) => expectAuthCode(error, 'invalid_credentials'))
		expect(service.getCurrentSession(bob.token)).toBeNull()
		service.close()
	})

	it('revokes logout sessions and rejects expired sessions', async () => {
		let now = new Date('2026-09-14T12:00:00.000Z')
		const { service } = createService({ now: () => now, sessionTtlMs: 5 * 60_000 })
		const owner = await bootstrap(service)
		expect(service.logout(owner.token)).toBe(true)
		expect(service.logout(owner.token)).toBe(false)
		expect(service.getCurrentSession(owner.token)).toBeNull()

		const login = await service.login({ login: 'owner', password: 'correct horse battery staple' })
		now = new Date('2026-09-14T12:05:00.001Z')
		expect(service.getCurrentSession(login.token)).toBeNull()
		service.close()
	})
})

describe('boards, members, and audit records', () => {
	it('enforces roles, soft deletion, restoration, and transactional legacy adoption', async () => {
		const { service } = createService()
		const owner = await bootstrap(service)
		const accountInvite = service.createInvitation(owner.user.id)
		const viewer = await service.register({
			login: 'viewer',
			displayName: 'Viewer',
			password: 'viewer secure password',
			invitationToken: accountInvite.token,
		})
		const board = service.createBoard(owner.user.id, 'Project', 'project')
		service.setBoardMemberRole(owner.user.id, board.id, viewer.user.id, 'viewer')
		expect(service.listBoards(viewer.user.id)).toEqual([expect.objectContaining({ id: 'project', role: 'viewer' })])
		expect(() => service.renameBoard(viewer.user.id, board.id, 'Not Allowed')).toThrow(AuthError)

		const deleted = service.deleteBoard(owner.user.id, board.id)
		expect(deleted.deletedAt).not.toBeNull()
		expect(service.listBoards(viewer.user.id)).toEqual([])
		expect(service.listBoards(viewer.user.id, true)).toHaveLength(1)
		expect(service.restoreBoard(owner.user.id, board.id).deletedAt).toBeNull()

		const adopted = service.adoptLegacyBoards(owner.user.id, [
			{ id: 'demo' },
			{ id: 'class-room', name: 'Class Room' },
			{ id: 'demo', name: 'Duplicate is folded' },
		])
		expect(adopted.map((item) => item.id).sort()).toEqual(['class-room', 'demo'])
		expect(service.adoptLegacyBoards(owner.user.id, [{ id: 'demo' }])).toEqual([])
		expect(service.getBoardRole(owner.user.id, 'demo')).toBe('owner')
		service.close()
	})

	it('keeps account events append-only at the database boundary', async () => {
		const { databasePath, service } = createService()
		const owner = await bootstrap(service)
		service.createBoard(owner.user.id, 'Audited board', 'audit-board')
		const events = service.listAuditEvents(owner.user.id)
		expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(['account.bootstrapped', 'board.created']))
		service.close()

		const inspector = new Database(databasePath)
		expect(() => inspector.prepare("UPDATE account_events SET type = 'changed'").run()).toThrow(/append-only/)
		expect(() => inspector.prepare('DELETE FROM account_events').run()).toThrow(/append-only/)
		inspector.close()
	})
})
