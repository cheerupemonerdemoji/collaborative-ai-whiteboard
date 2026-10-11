import { ApiError } from '../auth'

/**
 * The browser side of the owner-only agent management API (server/agent-access.ts). Everything here is plain
 * data and pure functions so it can be tested without a DOM; the components stay thin.
 *
 * Wording rule for this whole feature: an agent is identified to people by its display name. `ref` is an opaque
 * handle the server hands out and expects back; it is never shown. The fingerprint inside it and the stored hash
 * are never shown or described as credential information.
 */

export type ExpiryStatus = 'none' | 'active' | 'expired' | 'invalid'
export type Permission = 'read' | 'write' | 'history' | 'restore'
export type AccessLevel = 'read' | 'read-write' | 'read-history' | 'full' | 'write'

/** One agent as the server describes it to its board's owner. */
export interface Agent {
	/** Opaque. Pass it back to rotate or revoke; never display it. */
	ref: string
	name: string
	displayName?: string
	permissions: Permission[]
	rooms: string[]
	sharedWithOtherBoards: boolean
	createdAt?: string
	rotatedAt?: string
	expiresAt?: string
	status: ExpiryStatus
	createdByYou: boolean
}

export interface OwnedBoard {
	id: string
	name: string
}

/* ------------------------------------------------------------------ access levels -- */

export interface AccessLevelOption {
	value: AccessLevel
	label: string
	summary: string
	/** Exactly the permissions the server grants for this level. A test compares this to the server's own table. */
	permissions: readonly Permission[]
	/** Needs an explicit acknowledgement before it can be created. */
	dangerous?: boolean
}

export const ACCESS_LEVELS: readonly AccessLevelOption[] = [
	{ value: 'read', label: 'Read only', summary: 'Can read this whiteboard and its engineering records. Cannot change anything.', permissions: ['read'] },
	{ value: 'read-write', label: 'Read and edit', summary: 'Can read the whiteboard and make changes. Every change is recorded in History as an AI change.', permissions: ['read', 'write'] },
	{ value: 'read-history', label: 'Read and view history', summary: 'Can read the whiteboard and look back through its History and checkpoints. Cannot change anything.', permissions: ['read', 'history'] },
	{ value: 'full', label: 'Full access, including restore', summary: 'Can read, edit, view History, and restore the whole whiteboard to an earlier moment.', permissions: ['read', 'write', 'history', 'restore'], dangerous: true },
	{ value: 'write', label: 'Edit only', summary: 'Can make changes but cannot read the whiteboard back. Rarely what you want.', permissions: ['write'] },
]

export const PERMISSION_LABELS: Record<Permission, string> = {
	read: 'Read',
	write: 'Edit',
	history: 'History',
	restore: 'Restore',
}

export const RESTORE_WARNING =
	'Restore access is powerful. An agent with it can roll this whole whiteboard back to an earlier moment, which changes what everyone sees. ' +
	'Restores are recorded in History and can be undone by restoring again, but only grant this to an agent you fully trust.'

/* ----------------------------------------------------------------------- expiry -- */

export type ExpiryChoice = 'never' | '7d' | '30d' | '90d' | '365d' | 'custom'

export const EXPIRY_CHOICES: ReadonlyArray<{ value: ExpiryChoice; label: string }> = [
	{ value: '7d', label: '7 days' },
	{ value: '30d', label: '30 days' },
	{ value: '90d', label: '90 days' },
	{ value: '365d', label: '1 year' },
	{ value: 'custom', label: 'A date I choose' },
	{ value: 'never', label: 'No expiry' },
]

/** A new agent expires unless the owner opts out. The server would accept no expiry; the page does not default to it. */
export const DEFAULT_EXPIRY: ExpiryChoice = '90d'

const DAY_MS = 86_400_000

export type ExpiryResult = { ok: true; expiresAt?: string } | { ok: false; message: string }

/**
 * Turns the owner's choice into the `expiresAt` the API wants (UTC ISO 8601), or says why it cannot.
 * `customDate` is a `YYYY-MM-DD` value from a date input, taken as the END of that day in the owner's time zone.
 */
export function expiresAtFor(choice: ExpiryChoice, customDate: string, now: number = Date.now()): ExpiryResult {
	if (choice === 'never') return { ok: true }
	if (choice === 'custom') {
		const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(customDate)
		if (!match) return { ok: false, message: 'Choose the date the access should end.' }
		const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
		const endOfDay = new Date(year, month - 1, day, 23, 59, 59, 0)
		if (endOfDay.getFullYear() !== year || endOfDay.getMonth() !== month - 1 || endOfDay.getDate() !== day) {
			return { ok: false, message: 'That is not a real calendar date.' }
		}
		if (endOfDay.getTime() <= now) return { ok: false, message: 'Choose a date in the future.' }
		return { ok: true, expiresAt: endOfDay.toISOString() }
	}
	const days = Number(choice.slice(0, -1))
	return { ok: true, expiresAt: new Date(now + days * DAY_MS).toISOString() }
}

/* ------------------------------------------------------------------ create form -- */

export interface CreateForm {
	displayName: string
	access: AccessLevel
	expiry: ExpiryChoice
	customDate: string
	/** Ticked by the owner to confirm they understand what restore access allows. Only relevant for `full`. */
	restoreAcknowledged: boolean
}

export const INITIAL_CREATE_FORM: CreateForm = {
	displayName: '',
	access: 'read',
	expiry: DEFAULT_EXPIRY,
	customDate: '',
	restoreAcknowledged: false,
}

export function isDangerous(access: AccessLevel): boolean {
	return ACCESS_LEVELS.find((level) => level.value === access)?.dangerous === true
}

/**
 * Choosing an access level always clears the restore acknowledgement, including re-choosing the same one. A tick
 * given for one choice must never carry over to a different choice, or survive a change of mind.
 */
export function chooseAccess(form: CreateForm, access: AccessLevel): CreateForm {
	return { ...form, access, restoreAcknowledged: false }
}

export type Validation = { ok: true; input: { displayName: string; access: AccessLevel; expiresAt?: string } } | { ok: false; message: string }

/** The single place that decides whether the create form may be submitted, and with what. */
export function validateCreate(form: CreateForm, now: number = Date.now()): Validation {
	const displayName = form.displayName.trim()
	if (displayName.length < 1) return { ok: false, message: 'Give the agent a name you will recognise.' }
	if (displayName.length > 80) return { ok: false, message: 'Keep the name to 80 characters or fewer.' }
	if (/[\u0000-\u001f\u007f]/.test(displayName)) return { ok: false, message: 'The name cannot contain control characters.' }
	if (isDangerous(form.access) && !form.restoreAcknowledged) {
		return { ok: false, message: 'Confirm that you understand what restore access allows.' }
	}
	const expiry = expiresAtFor(form.expiry, form.customDate, now)
	if (!expiry.ok) return expiry
	return { ok: true, input: { displayName, access: form.access, ...(expiry.expiresAt === undefined ? {} : { expiresAt: expiry.expiresAt }) } }
}

/* ------------------------------------------------------------------------ rotate -- */

/** An expired agent, or one whose expiry cannot be read, cannot be rotated without choosing a new expiry. */
export function rotationNeedsExpiry(agent: Pick<Agent, 'status'>): boolean {
	return agent.status === 'expired' || agent.status === 'invalid'
}

export type RotateExpiryChoice = 'keep' | Exclude<ExpiryChoice, 'never'>

/** Rotation can keep the current expiry or replace it; it cannot remove one. Returns `expiresAt: undefined` to keep. */
export function rotateExpiry(choice: RotateExpiryChoice, customDate: string, now: number = Date.now()): ExpiryResult {
	if (choice === 'keep') return { ok: true }
	return expiresAtFor(choice, customDate, now)
}

/* ------------------------------------------------------------------ presentation -- */

export function formatDate(value: string | undefined): string {
	if (!value) return ''
	const date = new Date(value)
	return Number.isNaN(date.valueOf()) ? '' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date)
}

/** The human-facing identity. A display name always wins; agents made before names existed fall back to what they were called. */
export function agentTitle(agent: Pick<Agent, 'displayName' | 'name'>): string {
	return agent.displayName?.trim() ? agent.displayName : agent.name
}

export interface StatusView {
	tone: 'neutral' | 'ok' | 'warn' | 'bad'
	label: string
}

export function describeStatus(agent: Pick<Agent, 'status' | 'expiresAt'>, now: number = Date.now()): StatusView {
	switch (agent.status) {
		case 'none':
			return { tone: 'neutral', label: 'No expiry' }
		case 'active': {
			const soon = agent.expiresAt !== undefined && Date.parse(agent.expiresAt) - now < 7 * DAY_MS
			return { tone: soon ? 'warn' : 'ok', label: `Expires ${formatDate(agent.expiresAt)}`.trim() }
		}
		case 'expired':
			return { tone: 'bad', label: `Expired ${formatDate(agent.expiresAt)}`.trim() }
		default:
			return { tone: 'bad', label: 'Expiry unreadable: rotate to set a new one' }
	}
}

/** Plain-language errors. The server's own message is used where it is already written for people. */
export function friendlyError(error: unknown, fallback: string): string {
	if (!(error instanceof ApiError)) return error instanceof Error && error.message ? error.message : fallback
	switch (error.status) {
		case 401:
			return 'Your session has ended. Sign in again to continue.'
		case 429:
			return 'Too many requests. Wait a few minutes and try again.'
		case 404:
			return 'That whiteboard or agent no longer exists. The list has been refreshed.'
		case 403:
		case 409:
		case 422:
		case 503:
			return error.message || fallback
		default:
			return fallback
	}
}

/* ------------------------------------------------------------- one-time token -- */

/**
 * The only place a bearer token is ever held in the browser, and only while the dialog that shows it is open. It
 * lives in component memory, never in localStorage, sessionStorage, the URL, a cookie, history state or a log.
 */
export interface RevealedToken {
	kind: 'created' | 'rotated'
	agentTitle: string
	boardName: string
	token: string
}

export type TokenState = RevealedToken | null

export type TokenAction =
	| { type: 'reveal'; revealed: RevealedToken }
	/** The owner closed the dialog. */
	| { type: 'dismiss' }
	/** The page is being hidden or put into the back/forward cache: do not leave a live token behind a frozen page. */
	| { type: 'pagehide' }

/**
 * Runs `handler` when the page is hidden or frozen, and returns the function that stops listening. Kept separate
 * from the component so the wiring itself can be tested: a reducer that handles `pagehide` is no protection if
 * nothing ever delivers the event to it.
 */
export function onPageHide(target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>, handler: () => void): () => void {
	target.addEventListener('pagehide', handler)
	return () => target.removeEventListener('pagehide', handler)
}

export function tokenReducer(state: TokenState, action: TokenAction): TokenState {
	switch (action.type) {
		case 'reveal':
			return action.revealed
		case 'dismiss':
		case 'pagehide':
			return null
		default:
			return state
	}
}
