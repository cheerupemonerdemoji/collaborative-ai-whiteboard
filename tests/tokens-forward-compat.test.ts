/**
 * The machine-token reader must tolerate metadata it does not understand.
 *
 * The People & Agents feature will add fields like createdAt and expiresAt to
 * the token store. Before any of that is written, the deployed reader has to
 * cope with it - otherwise the first new-format write, or any rollback past
 * it, silently 401s every agent at once because the schema parse throws and
 * the failure is swallowed.
 *
 * These tests pin both halves of that contract: unknown fields are ignored
 * rather than fatal, and the fields the reader genuinely depends on are still
 * validated exactly as strictly as before.
 */

import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { authorizeApiToken } from '../server/tokens'

const digest = (token: string) => createHash('sha256').update(token).digest('hex')
const previous = process.env.CANVAS_API_TOKENS_FILE
const directories: string[] = []

afterEach(() => {
	if (previous === undefined) delete process.env.CANVAS_API_TOKENS_FILE
	else process.env.CANVAS_API_TOKENS_FILE = previous
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/** Writes a store verbatim, so a test can put anything at all in it. */
function storeContaining(contents: unknown): void {
	const directory = mkdtempSync(join(tmpdir(), 'canvas-token-compat-'))
	directories.push(directory)
	const file = join(directory, 'api-tokens.json')
	writeFileSync(file, JSON.stringify(contents, null, 2), { mode: 0o600 })
	process.env.CANVAS_API_TOKENS_FILE = file
}

function legacyClient(token: string) {
	return { name: 'legacy-a', tokenHash: digest(token), rooms: ['board-a'], permissions: ['read'] }
}

describe('the token reader tolerates unknown metadata', () => {
	it('authorizes a legacy client that carries no metadata at all', () => {
		const token = randomBytes(32).toString('base64url')
		storeContaining({ clients: [legacyClient(token)] })
		expect(authorizeApiToken(`Bearer ${token}`, 'board-a', 'read')).toBe('legacy-a')
	})

	it('authorizes a client carrying fields this version has never heard of', () => {
		// Exactly the shape the forthcoming feature will write, plus one field
		// invented here to stand in for whatever a future version adds.
		const token = randomBytes(32).toString('base64url')
		storeContaining({
			clients: [{
				...legacyClient(token),
				createdAt: '2026-10-07T00:00:00.000Z',
				// Far enough ahead that this fixture cannot start failing once the reader enforces expiry.
				expiresAt: '2099-01-01T00:00:00.000Z',
				displayName: 'Claude - Chibi Robo',
				createdByUserId: 'user-1',
				somethingNobodyHasInventedYet: { nested: true },
			}],
		})
		expect(authorizeApiToken(`Bearer ${token}`, 'board-a', 'read')).toBe('legacy-a')
	})

	it('does not let one future-format client lock out every other client', () => {
		// The original failure mode: a single unknown key made the whole parse
		// throw, so an unrelated legacy client stopped authenticating too.
		const legacyToken = randomBytes(32).toString('base64url')
		const futureToken = randomBytes(32).toString('base64url')
		storeContaining({
			clients: [
				legacyClient(legacyToken),
				{ name: 'future-b', tokenHash: digest(futureToken), rooms: ['board-b'], permissions: ['read'], expiresAt: '2027-01-01T00:00:00.000Z' },
			],
		})
		expect(authorizeApiToken(`Bearer ${legacyToken}`, 'board-a', 'read')).toBe('legacy-a')
		expect(authorizeApiToken(`Bearer ${futureToken}`, 'board-b', 'read')).toBe('future-b')
	})

	it('tolerates an unknown field at the top level of the store', () => {
		const token = randomBytes(32).toString('base64url')
		storeContaining({ schemaVersion: 2, clients: [legacyClient(token)] })
		expect(authorizeApiToken(`Bearer ${token}`, 'board-a', 'read')).toBe('legacy-a')
	})
})

describe('tolerance is not laxity', () => {
	it('still refuses a malformed token hash', () => {
		const token = randomBytes(32).toString('base64url')
		storeContaining({ clients: [{ ...legacyClient(token), tokenHash: 'not-a-sha256' }] })
		expect(authorizeApiToken(`Bearer ${token}`, 'board-a', 'read')).toBeNull()
	})

	it('still refuses an unrecognised permission value', () => {
		const token = randomBytes(32).toString('base64url')
		storeContaining({ clients: [{ ...legacyClient(token), permissions: ['read', 'superuser'] }] })
		expect(authorizeApiToken(`Bearer ${token}`, 'board-a', 'read')).toBeNull()
	})

	it('still refuses a malformed room identifier', () => {
		const token = randomBytes(32).toString('base64url')
		storeContaining({ clients: [{ ...legacyClient(token), rooms: ['../escape'] }] })
		expect(authorizeApiToken(`Bearer ${token}`, '../escape', 'read')).toBeNull()
	})

	it('still enforces board scope and permission scope', () => {
		const token = randomBytes(32).toString('base64url')
		storeContaining({ clients: [{ ...legacyClient(token), expiresAt: '2027-01-01T00:00:00.000Z' }] })
		expect(authorizeApiToken(`Bearer ${token}`, 'board-b', 'read')).toBeNull()
		expect(authorizeApiToken(`Bearer ${token}`, 'board-a', 'write')).toBeNull()
		expect(authorizeApiToken(`Bearer ${token}`, 'board-a', 'read')).toBe('legacy-a')
	})

	it('still refuses a wrong token', () => {
		const token = randomBytes(32).toString('base64url')
		storeContaining({ clients: [legacyClient(token)] })
		expect(authorizeApiToken(`Bearer ${randomBytes(32).toString('base64url')}`, 'board-a', 'read')).toBeNull()
	})
})
