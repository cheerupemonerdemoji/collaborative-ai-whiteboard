import { chmodSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import Database from 'better-sqlite3'

export type BoardRole = 'owner' | 'editor' | 'viewer'

export interface UserRecord {
	id: string
	login: string
	loginNormalized: string
	displayName: string
	passwordHash: string
	settingsJson: string
	isAdmin: boolean
	createdAt: string
	updatedAt: string
	lastLoginAt: string | null
	disabledAt: string | null
}

export interface SessionRecord {
	id: string
	tokenHash: string
	userId: string
	createdAt: string
	expiresAt: string
	lastSeenAt: string
	revokedAt: string | null
}

export interface BoardRecord {
	id: string
	name: string
	ownerUserId: string
	createdAt: string
	updatedAt: string
	deletedAt: string | null
}

export interface BoardWithRoleRecord extends BoardRecord {
	role: BoardRole
}

export interface BoardMemberRecord {
	boardId: string
	userId: string
	role: BoardRole
	createdAt: string
	updatedAt: string
}

export interface InvitationRecord {
	id: string
	tokenHash: string
	createdByUserId: string
	boardId: string | null
	role: Exclude<BoardRole, 'owner'> | null
	invitedLoginNormalized: string | null
	createdAt: string
	expiresAt: string
	consumedAt: string | null
	consumedByUserId: string | null
	revokedAt: string | null
}

export interface AccountEventRecord {
	id: number
	eventId: string
	type: string
	actorUserId: string | null
	subjectUserId: string | null
	boardId: string | null
	metadataJson: string
	createdAt: string
}

interface UserRow {
	id: string
	login: string
	login_normalized: string
	display_name: string
	password_hash: string
	settings_json: string
	is_admin: number
	created_at: string
	updated_at: string
	last_login_at: string | null
	disabled_at: string | null
}

interface SessionRow {
	id: string
	token_hash: string
	user_id: string
	created_at: string
	expires_at: string
	last_seen_at: string
	revoked_at: string | null
}

interface BoardRow {
	id: string
	name: string
	owner_user_id: string
	created_at: string
	updated_at: string
	deleted_at: string | null
}

interface BoardWithRoleRow extends BoardRow {
	role: BoardRole
}

interface BoardMemberRow {
	board_id: string
	user_id: string
	role: BoardRole
	created_at: string
	updated_at: string
}

interface InvitationRow {
	id: string
	token_hash: string
	created_by_user_id: string
	board_id: string | null
	role: Exclude<BoardRole, 'owner'> | null
	invited_login_normalized: string | null
	created_at: string
	expires_at: string
	consumed_at: string | null
	consumed_by_user_id: string | null
	revoked_at: string | null
}

interface AccountEventRow {
	id: number
	event_id: string
	type: string
	actor_user_id: string | null
	subject_user_id: string | null
	board_id: string | null
	metadata_json: string
	created_at: string
}

interface Migration {
	version: number
	name: string
	up: (database: Database.Database) => void
}

const migrations: readonly Migration[] = [
	{
		version: 1,
		name: 'accounts_sessions_boards_and_invitations',
		up(database) {
			database.exec(`
				CREATE TABLE users (
					id TEXT PRIMARY KEY,
					login TEXT NOT NULL,
					login_normalized TEXT NOT NULL UNIQUE,
					display_name TEXT NOT NULL,
					password_hash TEXT NOT NULL,
					settings_json TEXT NOT NULL DEFAULT '{}',
					is_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1)),
					created_at TEXT NOT NULL,
					updated_at TEXT NOT NULL,
					last_login_at TEXT,
					disabled_at TEXT,
					CHECK (json_valid(settings_json))
				);

				CREATE TABLE sessions (
					id TEXT PRIMARY KEY,
					token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
					user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
					created_at TEXT NOT NULL,
					expires_at TEXT NOT NULL,
					last_seen_at TEXT NOT NULL,
					revoked_at TEXT
				);
				CREATE INDEX sessions_user_id_idx ON sessions(user_id);
				CREATE INDEX sessions_expiry_idx ON sessions(expires_at) WHERE revoked_at IS NULL;

				CREATE TABLE boards (
					id TEXT PRIMARY KEY,
					name TEXT NOT NULL,
					owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
					created_at TEXT NOT NULL,
					updated_at TEXT NOT NULL,
					deleted_at TEXT
				);
				CREATE INDEX boards_owner_idx ON boards(owner_user_id);

				CREATE TABLE board_members (
					board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
					user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
					role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
					created_at TEXT NOT NULL,
					updated_at TEXT NOT NULL,
					PRIMARY KEY (board_id, user_id)
				);
				CREATE INDEX board_members_user_idx ON board_members(user_id);

				CREATE TABLE invitations (
					id TEXT PRIMARY KEY,
					token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
					created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
					board_id TEXT REFERENCES boards(id) ON DELETE CASCADE,
					role TEXT CHECK (role IN ('editor', 'viewer')),
					invited_login_normalized TEXT,
					created_at TEXT NOT NULL,
					expires_at TEXT NOT NULL,
					consumed_at TEXT,
					consumed_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
					revoked_at TEXT,
					CHECK ((board_id IS NULL AND role IS NULL) OR (board_id IS NOT NULL AND role IS NOT NULL))
				);
				CREATE INDEX invitations_expiry_idx ON invitations(expires_at)
					WHERE consumed_at IS NULL AND revoked_at IS NULL;

				CREATE TABLE account_events (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					event_id TEXT NOT NULL UNIQUE,
					type TEXT NOT NULL,
					actor_user_id TEXT,
					subject_user_id TEXT,
					board_id TEXT,
					metadata_json TEXT NOT NULL DEFAULT '{}',
					created_at TEXT NOT NULL,
					CHECK (json_valid(metadata_json))
				);
				CREATE INDEX account_events_created_idx ON account_events(created_at, id);
				CREATE INDEX account_events_user_idx ON account_events(subject_user_id, created_at);
				CREATE INDEX account_events_board_idx ON account_events(board_id, created_at);

				CREATE TRIGGER account_events_prevent_update
				BEFORE UPDATE ON account_events
				BEGIN
					SELECT RAISE(ABORT, 'account events are append-only');
				END;
				CREATE TRIGGER account_events_prevent_delete
				BEFORE DELETE ON account_events
				BEGIN
					SELECT RAISE(ABORT, 'account events are append-only');
				END;
			`)
		},
	},
	{
		version: 2,
		name: 'board_asset_access',
		up(database) {
			database.exec(`
				CREATE TABLE board_assets (
					upload_id TEXT NOT NULL,
					board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE RESTRICT,
					PRIMARY KEY (upload_id, board_id)
				);
				CREATE INDEX board_assets_board_idx ON board_assets(board_id);
			`)
		},
	},
]

function mapUser(row: UserRow): UserRecord {
	return {
		id: row.id,
		login: row.login,
		loginNormalized: row.login_normalized,
		displayName: row.display_name,
		passwordHash: row.password_hash,
		settingsJson: row.settings_json,
		isAdmin: row.is_admin === 1,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		lastLoginAt: row.last_login_at,
		disabledAt: row.disabled_at,
	}
}

function mapSession(row: SessionRow): SessionRecord {
	return {
		id: row.id,
		tokenHash: row.token_hash,
		userId: row.user_id,
		createdAt: row.created_at,
		expiresAt: row.expires_at,
		lastSeenAt: row.last_seen_at,
		revokedAt: row.revoked_at,
	}
}

function mapBoard(row: BoardRow): BoardRecord {
	return {
		id: row.id,
		name: row.name,
		ownerUserId: row.owner_user_id,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		deletedAt: row.deleted_at,
	}
}

function mapBoardWithRole(row: BoardWithRoleRow): BoardWithRoleRecord {
	return { ...mapBoard(row), role: row.role }
}

function mapMember(row: BoardMemberRow): BoardMemberRecord {
	return {
		boardId: row.board_id,
		userId: row.user_id,
		role: row.role,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	}
}

function mapInvitation(row: InvitationRow): InvitationRecord {
	return {
		id: row.id,
		tokenHash: row.token_hash,
		createdByUserId: row.created_by_user_id,
		boardId: row.board_id,
		role: row.role,
		invitedLoginNormalized: row.invited_login_normalized,
		createdAt: row.created_at,
		expiresAt: row.expires_at,
		consumedAt: row.consumed_at,
		consumedByUserId: row.consumed_by_user_id,
		revokedAt: row.revoked_at,
	}
}

function mapEvent(row: AccountEventRow): AccountEventRecord {
	return {
		id: row.id,
		eventId: row.event_id,
		type: row.type,
		actorUserId: row.actor_user_id,
		subjectUserId: row.subject_user_id,
		boardId: row.board_id,
		metadataJson: row.metadata_json,
		createdAt: row.created_at,
	}
}

export function resolveAuthDatabasePath(): string {
	return process.env.CANVAS_AUTH_DB_FILE ?? join(process.env.CANVAS_DATA_DIR ?? './data', 'auth.sqlite')
}

export class AuthDatabase {
	private readonly database: Database.Database

	constructor(filePath = resolveAuthDatabasePath()) {
		if (filePath !== ':memory:') mkdirSync(dirname(filePath), { recursive: true })
		this.database = new Database(filePath)
		if (filePath !== ':memory:') {
			try { chmodSync(filePath, 0o600) } catch { /* Windows ACLs remain authoritative. */ }
		}
		this.database.pragma('foreign_keys = ON')
		this.database.pragma('busy_timeout = 5000')
		if (filePath !== ':memory:') this.database.pragma('journal_mode = WAL')
		this.migrate()
	}

	private migrate(): void {
		this.database.exec(`
			CREATE TABLE IF NOT EXISTS auth_schema_migrations (
				version INTEGER PRIMARY KEY,
				name TEXT NOT NULL,
				applied_at TEXT NOT NULL
			)
		`)
		const latest = this.database.prepare('SELECT MAX(version) AS version FROM auth_schema_migrations').get() as { version: number | null }
		const newestKnownVersion = migrations.at(-1)?.version ?? 0
		if ((latest.version ?? 0) > newestKnownVersion) {
			throw new Error(`Auth database schema version ${latest.version} is newer than this application supports`)
		}
		for (const migration of migrations) {
			const applied = this.database.prepare('SELECT 1 FROM auth_schema_migrations WHERE version = ?').get(migration.version)
			if (applied) continue
			this.database.transaction(() => {
				migration.up(this.database)
				this.database.prepare(
					'INSERT INTO auth_schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
				).run(migration.version, migration.name, new Date().toISOString())
			})()
		}
	}

	close(): void {
		this.database.close()
	}

	transaction<T>(operation: () => T): T {
		return this.database.transaction(operation)()
	}

	countUsers(): number {
		return (this.database.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count
	}

	getUserById(id: string): UserRecord | null {
		const row = this.database.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined
		return row ? mapUser(row) : null
	}

	getUserByNormalizedLogin(loginNormalized: string): UserRecord | null {
		const row = this.database.prepare('SELECT * FROM users WHERE login_normalized = ?').get(loginNormalized) as UserRow | undefined
		return row ? mapUser(row) : null
	}

	insertUser(user: UserRecord): void {
		this.database.prepare(`
			INSERT INTO users (
				id, login, login_normalized, display_name, password_hash, settings_json,
				is_admin, created_at, updated_at, last_login_at, disabled_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
			user.id,
			user.login,
			user.loginNormalized,
			user.displayName,
			user.passwordHash,
			user.settingsJson,
			user.isAdmin ? 1 : 0,
			user.createdAt,
			user.updatedAt,
			user.lastLoginAt,
			user.disabledAt,
		)
	}

	setLastLogin(userId: string, at: string): void {
		this.database.prepare('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?').run(at, at, userId)
	}

	setUserSettings(userId: string, settingsJson: string, at: string): boolean {
		return this.database.prepare('UPDATE users SET settings_json = ?, updated_at = ? WHERE id = ? AND disabled_at IS NULL')
			.run(settingsJson, at, userId).changes === 1
	}

	setUserDisabled(userId: string, disabledAt: string | null, updatedAt: string): boolean {
		return this.database.prepare('UPDATE users SET disabled_at = ?, updated_at = ? WHERE id = ?')
			.run(disabledAt, updatedAt, userId).changes === 1
	}

	insertSession(session: SessionRecord): void {
		this.database.prepare(`
			INSERT INTO sessions (id, token_hash, user_id, created_at, expires_at, last_seen_at, revoked_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)
		`).run(
			session.id,
			session.tokenHash,
			session.userId,
			session.createdAt,
			session.expiresAt,
			session.lastSeenAt,
			session.revokedAt,
		)
	}

	getSessionByTokenHash(tokenHash: string): SessionRecord | null {
		const row = this.database.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(tokenHash) as SessionRow | undefined
		return row ? mapSession(row) : null
	}

	touchSession(id: string, at: string): void {
		this.database.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ? AND revoked_at IS NULL').run(at, id)
	}

	revokeSessionByTokenHash(tokenHash: string, at: string): SessionRecord | null {
		const session = this.getSessionByTokenHash(tokenHash)
		if (!session || session.revokedAt) return null
		const result = this.database.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(at, session.id)
		return result.changes === 1 ? { ...session, revokedAt: at } : null
	}

	revokeSessionsForUser(userId: string, at: string): number {
		return this.database.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
			.run(at, userId).changes
	}

	deleteExpiredSessions(before: string): number {
		return this.database.prepare('DELETE FROM sessions WHERE expires_at <= ? OR revoked_at IS NOT NULL').run(before).changes
	}

	getBoardById(id: string): BoardRecord | null {
		const row = this.database.prepare('SELECT * FROM boards WHERE id = ?').get(id) as BoardRow | undefined
		return row ? mapBoard(row) : null
	}

	insertBoard(board: BoardRecord): void {
		this.database.prepare(`
			INSERT INTO boards (id, name, owner_user_id, created_at, updated_at, deleted_at)
			VALUES (?, ?, ?, ?, ?, ?)
		`).run(board.id, board.name, board.ownerUserId, board.createdAt, board.updatedAt, board.deletedAt)
	}

	listBoardsForUser(userId: string, includeDeleted: boolean): BoardWithRoleRecord[] {
		const rows = this.database.prepare(`
			SELECT b.*, m.role
			FROM boards b
			JOIN board_members m ON m.board_id = b.id
			WHERE m.user_id = ? AND (? = 1 OR b.deleted_at IS NULL)
			ORDER BY b.updated_at DESC, b.id ASC
		`).all(userId, includeDeleted ? 1 : 0) as BoardWithRoleRow[]
		return rows.map(mapBoardWithRole)
	}

	renameBoard(id: string, name: string, at: string): boolean {
		return this.database.prepare('UPDATE boards SET name = ?, updated_at = ? WHERE id = ?')
			.run(name, at, id).changes === 1
	}

	setBoardDeleted(id: string, deletedAt: string | null, updatedAt: string): boolean {
		return this.database.prepare('UPDATE boards SET deleted_at = ?, updated_at = ? WHERE id = ?')
			.run(deletedAt, updatedAt, id).changes === 1
	}

	getBoardMember(boardId: string, userId: string): BoardMemberRecord | null {
		const row = this.database.prepare('SELECT * FROM board_members WHERE board_id = ? AND user_id = ?')
			.get(boardId, userId) as BoardMemberRow | undefined
		return row ? mapMember(row) : null
	}

	listBoardMembers(boardId: string): BoardMemberRecord[] {
		const rows = this.database.prepare(`
			SELECT * FROM board_members WHERE board_id = ?
			ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END, created_at, user_id
		`).all(boardId) as BoardMemberRow[]
		return rows.map(mapMember)
	}

	upsertBoardMember(member: BoardMemberRecord): void {
		this.database.prepare(`
			INSERT INTO board_members (board_id, user_id, role, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?)
			ON CONFLICT (board_id, user_id) DO UPDATE SET role = excluded.role, updated_at = excluded.updated_at
		`).run(member.boardId, member.userId, member.role, member.createdAt, member.updatedAt)
	}

	removeBoardMember(boardId: string, userId: string): boolean {
		return this.database.prepare('DELETE FROM board_members WHERE board_id = ? AND user_id = ?')
			.run(boardId, userId).changes === 1
	}

	insertInvitation(invitation: InvitationRecord): void {
		this.database.prepare(`
			INSERT INTO invitations (
				id, token_hash, created_by_user_id, board_id, role, invited_login_normalized,
				created_at, expires_at, consumed_at, consumed_by_user_id, revoked_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
			invitation.id,
			invitation.tokenHash,
			invitation.createdByUserId,
			invitation.boardId,
			invitation.role,
			invitation.invitedLoginNormalized,
			invitation.createdAt,
			invitation.expiresAt,
			invitation.consumedAt,
			invitation.consumedByUserId,
			invitation.revokedAt,
		)
	}

	getInvitationByTokenHash(tokenHash: string): InvitationRecord | null {
		const row = this.database.prepare('SELECT * FROM invitations WHERE token_hash = ?').get(tokenHash) as InvitationRow | undefined
		return row ? mapInvitation(row) : null
	}

	consumeInvitation(id: string, userId: string, at: string): boolean {
		return this.database.prepare(`
			UPDATE invitations SET consumed_at = ?, consumed_by_user_id = ?
			WHERE id = ? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ?
		`).run(at, userId, id, at).changes === 1
	}

	revokeInvitation(id: string, at: string): boolean {
		return this.database.prepare(`
			UPDATE invitations SET revoked_at = ?
			WHERE id = ? AND consumed_at IS NULL AND revoked_at IS NULL
		`).run(at, id).changes === 1
	}

	insertAccountEvent(event: Omit<AccountEventRecord, 'id'>): void {
		this.database.prepare(`
			INSERT INTO account_events (
				event_id, type, actor_user_id, subject_user_id, board_id, metadata_json, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?)
		`).run(
			event.eventId,
			event.type,
			event.actorUserId,
			event.subjectUserId,
			event.boardId,
			event.metadataJson,
			event.createdAt,
		)
	}

	listAccountEvents(options: { userId?: string; boardId?: string; limit?: number } = {}): AccountEventRecord[] {
		const limit = Math.min(Math.max(options.limit ?? 100, 1), 500)
		let rows: AccountEventRow[]
		if (options.boardId) {
			rows = this.database.prepare('SELECT * FROM account_events WHERE board_id = ? ORDER BY id DESC LIMIT ?')
				.all(options.boardId, limit) as AccountEventRow[]
		} else if (options.userId) {
			rows = this.database.prepare(`
				SELECT * FROM account_events
				WHERE actor_user_id = ? OR subject_user_id = ?
				ORDER BY id DESC LIMIT ?
			`).all(options.userId, options.userId, limit) as AccountEventRow[]
		} else {
			rows = this.database.prepare('SELECT * FROM account_events ORDER BY id DESC LIMIT ?').all(limit) as AccountEventRow[]
		}
		return rows.map(mapEvent)
	}

	listBoardEventsSince(boardId: string, after: number): AccountEventRecord[] {
		return (this.database.prepare('SELECT * FROM account_events WHERE board_id = ? AND id > ? ORDER BY id ASC LIMIT 500')
			.all(boardId, after) as AccountEventRow[]).map(mapEvent)
	}

	registerBoardAsset(boardId: string, uploadId: string): void {
		this.database.prepare('INSERT OR IGNORE INTO board_assets(upload_id, board_id) VALUES (?, ?)').run(uploadId, boardId)
	}

	canReadAsset(userId: string, uploadId: string): boolean {
		return Boolean(this.database.prepare(`
			SELECT 1 FROM board_assets a
			JOIN board_members m ON m.board_id = a.board_id
			JOIN boards b ON b.id = a.board_id
			WHERE a.upload_id = ? AND m.user_id = ? AND b.deleted_at IS NULL LIMIT 1
		`).get(uploadId, userId))
	}
}
