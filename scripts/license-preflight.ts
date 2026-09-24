/**
 * tldraw licence preflight.
 *
 * The key is injected at build time: `client/pages/Room.tsx` reads
 * `import.meta.env.VITE_TLDRAW_LICENSE_KEY` and Vite inlines the literal into
 * the client bundle. Rotating the key therefore needs a rebuild, and an expired
 * key ships silently unless something checks before the build.
 *
 * Supported validation vs best-effort metadata
 * --------------------------------------------
 * tldraw 5.4.1 exposes no supported way to ask about licence state. Everything
 * in that area - LicenseManager, LicenseState, LicenseInfo,
 * useMaybeLicenseManager - is marked "Excluded from this release type" in
 * the editor package public .d.ts. The only public surface is the
 * `licenseKey?: string` prop. So:
 *
 *   - SUPPORTED VALIDATION: performed by tldraw at runtime, in the browser,
 *     against the signed payload. This file cannot and does not reproduce it.
 *   - BEST-EFFORT OPERATOR METADATA: what this file does. A tldraw key looks
 *     like `<prefix>/<data>.<signature>` (LicenseManager.extractLicenseKey
 *     splits on '.' then '/'), and the prefix of the issued key carries a
 *     human-readable `tldraw-YYYY-MM-DD` or
 *     `tldraw-<personalised-label>-YYYY-MM-DD` expiry. That is a label, not
 *     proof.
 *
 * The distinction matters for deployment: an EXPIRED verdict here means "the
 * label on the key says it is past its date", which is strong enough to stop an
 * accidental production build, and is overridable for emergency recovery. It is
 * never a claim about what tldraw own validator will decide.
 *
 * Deliberately not modelled: tldraw currently allows a 30-day grace period
 * after expiry (GRACE_PERIOD_DAYS in LicenseManager). That is an undocumented
 * internal constant which may change without notice, so this treats the printed
 * expiry date as the deadline and never counts on days past it.
 *
 * The key itself is never printed, logged or returned.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DAY = 86_400_000

/** Warning thresholds in days, tightest first. */
export const WARNING_THRESHOLDS = [1, 7, 14, 30] as const

export type LicenseStatus = 'MISSING' | 'VALID' | 'EXPIRING_SOON' | 'EXPIRED' | 'UNKNOWN'

export interface LicenseVerdict {
	status: LicenseStatus
	/** ISO date from the key prefix, or null when it could not be read. */
	expiresOn: string | null
	/**
	 * Whole days until the licence lapses, counting the current day: 1 for the
	 * whole of the expiry date itself. Null unless the status is VALID or
	 * EXPIRING_SOON.
	 */
	daysRemaining: number | null
	/** Whole days since it lapsed; 0 for the first day past. Null unless EXPIRED. */
	daysSinceExpiry: number | null
	/** The tightest warning threshold this verdict tripped, if any. */
	threshold: number | null
	/** How expiresOn was obtained. Never 'supported' - tldraw exposes no such API. */
	source: 'key-prefix' | 'none'
	/** The encoded payload also contained the same date. Corroboration, not proof. */
	corroborated: boolean
	detail: string
}

// Permanent hobby licences may include a lowercase, hyphen-separated owner
// label before the date. Requiring at least one letter keeps the old date-only
// form unambiguous and avoids treating an extra numeric segment as a label.
const PERSONALISED_LABEL = String.raw`[a-z0-9]*[a-z][a-z0-9]*(?:-[a-z0-9]+)*`
const PREFIX_DATE = new RegExp(
	String.raw`^tldraw-(?:${PERSONALISED_LABEL}-)?(\d{4})-(\d{2})-(\d{2})$`
)
const BASE64_TOKEN = /^[A-Za-z0-9+/]+={0,2}$/

function isBase64Token(value: string): boolean {
	return BASE64_TOKEN.test(value) && value.replace(/=+$/, '').length % 4 !== 1
}

/**
 * Date.UTC happily rolls nonsense over - month 13 becomes January of the next
 * year, 2025-02-30 becomes 2025-03-02 - so a parsed date is only trusted when
 * it round-trips to the exact components that were read off the key.
 */
function isRealDate(year: number, month: number, day: number): boolean {
	const probe = new Date(Date.UTC(year, month - 1, day))
	return (
		Number.isFinite(probe.getTime()) &&
		probe.getUTCFullYear() === year &&
		probe.getUTCMonth() === month - 1 &&
		probe.getUTCDate() === day
	)
}

/**
 * A licence is valid *through* its expiry date, so it lapses at the start of
 * the following UTC day. Everything here is UTC: the build machine local
 * timezone must not decide whether a deployment is blocked.
 */
function expiryInstant(year: number, month: number, day: number): number {
	return Date.UTC(year, month - 1, day) + DAY
}

function corroborate(key: string, isoDate: string): boolean {
	// The signed payload is private and its shape is not documented. Finding the
	// same date inside it raises confidence a little; failing to find it proves
	// nothing, so this never downgrades a verdict.
	const [data] = key.split('.')
	const encoded = data?.split('/')[1]
	if (!encoded) return false
	try {
		return Buffer.from(encoded, 'base64').toString('utf8').includes(isoDate)
	} catch {
		return false
	}
}

function unreadable(detail: string): LicenseVerdict {
	return {
		status: 'UNKNOWN',
		expiresOn: null,
		daysRemaining: null,
		daysSinceExpiry: null,
		threshold: null,
		source: 'none',
		corroborated: false,
		detail,
	}
}

export function evaluateLicense(key: string | undefined | null, now: number): LicenseVerdict {
	const trimmed = (key ?? '').trim()
	if (!trimmed) {
		return {
			status: 'MISSING',
			expiresOn: null,
			daysRemaining: null,
			daysSinceExpiry: null,
			threshold: null,
			source: 'none',
			corroborated: false,
			detail: 'No licence key is configured.',
		}
	}

	const slash = trimmed.indexOf('/')
	const dot = trimmed.lastIndexOf('.')
	if (slash <= 0 || dot <= slash + 1 || dot === trimmed.length - 1 || trimmed.indexOf('.', slash) !== dot) {
		return unreadable('A licence key is configured, but its payload or signature is malformed.')
	}

	const prefix = trimmed.slice(0, slash)
	const payload = trimmed.slice(slash + 1, dot)
	const signature = trimmed.slice(dot + 1)
	if (!isBase64Token(payload) || !isBase64Token(signature)) {
		return unreadable('A licence key is configured, but its payload or signature is malformed.')
	}

	const match = PREFIX_DATE.exec(prefix)
	if (!match) {
		return unreadable('A licence key is configured, but its prefix carries no readable expiry date.')
	}

	const year = Number(match[1])
	const month = Number(match[2])
	const day = Number(match[3])
	if (!isRealDate(year, month, day)) {
		return unreadable('A licence key is configured, but its expiry date is not a real calendar date.')
	}

	const expiresOn = `${match[1]}-${match[2]}-${match[3]}`
	const lapsesAt = expiryInstant(year, month, day)
	const corroborated = corroborate(trimmed, expiresOn)

	if (now >= lapsesAt) {
		return {
			status: 'EXPIRED',
			expiresOn,
			daysRemaining: null,
			daysSinceExpiry: Math.floor((now - lapsesAt) / DAY),
			threshold: null,
			source: 'key-prefix',
			corroborated,
			detail: `The configured licence is labelled as having expired on ${expiresOn}.`,
		}
	}

	const daysRemaining = Math.ceil((lapsesAt - now) / DAY)
	// Tightest tripped threshold wins, so 10 days out reports 14 and not 30.
	const threshold = WARNING_THRESHOLDS.find((limit) => daysRemaining <= limit) ?? null

	return {
		status: threshold === null ? 'VALID' : 'EXPIRING_SOON',
		expiresOn,
		daysRemaining,
		daysSinceExpiry: null,
		threshold,
		source: 'key-prefix',
		corroborated,
		detail: `The configured licence expires on ${expiresOn}.`,
	}
}

/** Human-facing report. Contains the status and the date, never the key. */
export function formatVerdict(verdict: LicenseVerdict): string {
	const lines = [`tldraw license: ${verdict.status === 'MISSING' ? 'not configured' : 'configured'}`]
	if (verdict.expiresOn) lines.push(`expiration: ${verdict.expiresOn}`)
	lines.push(`status: ${verdict.status}`)
	if (verdict.daysRemaining !== null) lines.push(`days remaining: ${verdict.daysRemaining}`)
	if (verdict.daysSinceExpiry !== null) lines.push(`days since expiry: ${verdict.daysSinceExpiry}`)
	if (verdict.expiresOn) {
		lines.push('expiry source: key prefix (best-effort operator metadata, not tldraw validation)')
		if (!verdict.corroborated) lines.push('note: the encoded payload did not repeat this date')
	}
	return lines.join('\n')
}

/** Reads the key without ever returning it to a caller that might print it. */
export function readConfiguredKey(repoRoot: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
	const fromEnv = env.VITE_TLDRAW_LICENSE_KEY
	if (fromEnv && fromEnv.trim()) return fromEnv.trim()
	// Vite's own precedence, highest first, verified against vite.loadEnv():
	// .env.production.local > .env.production > .env.local > .env, with real
	// environment variables beating all four. Checking a different order here
	// would mean vetting one key while Vite inlines another.
	for (const name of ['.env.production.local', '.env.production', '.env.local', '.env']) {
		const file = join(repoRoot, name)
		if (!existsSync(file)) continue
		for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
			if (line.trimStart().startsWith('#')) continue
			const separator = line.indexOf('=')
			if (separator < 0) continue
			if (line.slice(0, separator).trim() !== 'VITE_TLDRAW_LICENSE_KEY') continue
			const value = line.slice(separator + 1).trim().replace(/^["']|["']$/g, '')
			if (value) return value
		}
	}
	return undefined
}

export interface PreflightOutcome {
	verdict: LicenseVerdict
	report: string
	exitCode: number
	blocking: boolean
}

export function preflight(options: {
	key: string | undefined
	now: number
	production: boolean
	allowExpired: boolean
}): PreflightOutcome {
	const verdict = evaluateLicense(options.key, options.now)
	const lines = [formatVerdict(verdict)]
	let exitCode = 0
	let blocking = false

	if (verdict.status === 'MISSING') {
		if (options.production) {
			lines.push('', 'BLOCKED: a production build needs VITE_TLDRAW_LICENSE_KEY.')
			lines.push('Without it the canvas refuses to render and shows the licence setup screen.')
			exitCode = 1
			blocking = true
		} else {
			lines.push('', 'Development build: continuing without a licence key.')
		}
	} else if (verdict.status === 'EXPIRED') {
		if (options.production && !options.allowExpired) {
			lines.push('', 'BLOCKED: refusing to build production with a licence past its date.')
			lines.push('Rotate the key, or set TLDRAW_LICENSE_ALLOW_EXPIRED=1 for emergency recovery.')
			lines.push('Rotation: docs/operations/tldraw-license.md')
			exitCode = 1
			blocking = true
		} else if (options.production) {
			lines.push('', 'OVERRIDDEN: TLDRAW_LICENSE_ALLOW_EXPIRED=1 is set. Building with an expired licence.')
			lines.push('Rotation: docs/operations/tldraw-license.md')
		} else {
			lines.push('', 'Development build: continuing with an expired licence.')
		}
	} else if (verdict.status === 'EXPIRING_SOON') {
		lines.push('', `WARNING: licence expires in ${verdict.daysRemaining} day(s) - rotate it before it lapses.`)
		lines.push('Rotation: docs/operations/tldraw-license.md')
	} else if (verdict.status === 'UNKNOWN') {
		lines.push('', 'WARNING: expiry could not be read from the key, so it cannot be checked here.')
		lines.push('tldraw validates the licence itself in the browser; watch the console after deploying.')
	}

	return { verdict, report: lines.join('\n'), exitCode, blocking }
}

/* -------------------------------------------------------------------------
 * Verifying what was actually built
 *
 * The preflight above checks the key that is *configured*. That is not the
 * same question as "what does the bundle we are about to serve contain",
 * because Vite inlines the key at build time: a stale `dist/` keeps serving
 * yesterday's key no matter what `.env` says today. After a rotation the only
 * honest confirmation is to look at the built asset itself.
 *
 * Only the date is ever read out of the bundle. The key is not extracted,
 * returned or printed.
 * ---------------------------------------------------------------------- */

const BUNDLE_DATE = new RegExp(
	String.raw`tldraw-(?:${PERSONALISED_LABEL}-)?(\d{4})-(\d{2})-(\d{2})/`,
	'g'
)

export interface BundleScan {
	/** Distinct expiry dates found in the built assets, sorted. */
	expiryDates: string[]
	/** JavaScript files inspected. Zero means the directory was not a build. */
	filesScanned: number
	/** Total occurrences, across all files. */
	occurrences: number
}

function javascriptFiles(directory: string, found: string[] = []): string[] {
	let entries: string[]
	try {
		entries = readdirSync(directory)
	} catch {
		return found
	}
	for (const entry of entries) {
		const full = join(directory, entry)
		let stats: ReturnType<typeof statSync>
		try {
			stats = statSync(full)
		} catch {
			continue
		}
		if (stats.isDirectory()) javascriptFiles(full, found)
		else if (entry.endsWith('.js') || entry.endsWith('.mjs')) found.push(full)
	}
	return found
}

/** Reads expiry dates - and nothing else - out of a built client directory. */
export function scanBuiltBundle(clientDirectory: string): BundleScan {
	const dates = new Set<string>()
	let occurrences = 0
	const files = javascriptFiles(clientDirectory)
	for (const file of files) {
		let contents: string
		try {
			contents = readFileSync(file, 'utf8')
		} catch {
			continue
		}
		BUNDLE_DATE.lastIndex = 0
		for (const match of contents.matchAll(BUNDLE_DATE)) {
			occurrences++
			dates.add(`${match[1]}-${match[2]}-${match[3]}`)
		}
	}
	return { expiryDates: [...dates].sort(), filesScanned: files.length, occurrences }
}

export interface BuildVerification {
	report: string
	exitCode: number
}

/**
 * Compares the built bundle against the configured key.
 *
 * Deliberately conservative about what counts as a failure. "No date found"
 * is reported but never fails, because a key whose label this file cannot
 * parse is still a perfectly valid key and refusing a deployment over it
 * would be a self-inflicted outage. Only two things fail: a date in the
 * bundle that is definitely past, and a bundle that definitely disagrees with
 * the configured key - the signature of a rotation where the rebuild was
 * forgotten.
 */
export function verifyBuild(options: {
	scan: BundleScan
	configuredExpiry: string | null
	now: number
}): BuildVerification {
	const { scan, configuredExpiry, now } = options
	const lines: string[] = [`built assets scanned: ${scan.filesScanned}`]
	let exitCode = 0

	if (scan.filesScanned === 0) {
		lines.push('status: NO_BUILD')
		lines.push('No JavaScript was found. Build before verifying.')
		return { report: lines.join('\n'), exitCode: 1 }
	}

	if (scan.expiryDates.length === 0) {
		lines.push('status: UNKNOWN')
		lines.push('No tldraw licence date is present in the built assets.')
		lines.push('Either no key was configured at build time, or its label is not readable here.')
		lines.push('tldraw validates the licence itself in the browser; check the console after deploying.')
		return { report: lines.join('\n'), exitCode: 0 }
	}

	if (scan.expiryDates.length > 1) {
		lines.push(`built licence expiry: ${scan.expiryDates.join(', ')}`)
		lines.push('status: CONFLICT')
		lines.push('The built assets carry more than one licence date. The build directory is mixed.')
		return { report: lines.join('\n'), exitCode: 1 }
	}

	const builtExpiry = scan.expiryDates[0]
	lines.push(`built licence expiry: ${builtExpiry}`)

	// Structurally valid base64 placeholders; only the already-scanned expiry is
	// evaluated here, and no real licence material is retained or reported.
	const built = evaluateLicense(`tldraw-${builtExpiry}/eA.eQ`, now)
	lines.push(`status: ${built.status}`)
	if (built.daysRemaining !== null) lines.push(`days remaining: ${built.daysRemaining}`)
	if (built.daysSinceExpiry !== null) lines.push(`days since expiry: ${built.daysSinceExpiry}`)

	if (configuredExpiry && configuredExpiry !== builtExpiry) {
		lines.push('')
		lines.push(`STALE BUILD: the configured key expires ${configuredExpiry}, the built assets carry ${builtExpiry}.`)
		lines.push('Rebuild so the rotated key reaches the browser, then verify again.')
		lines.push('Rotation: docs/operations/tldraw-license.md')
		exitCode = 1
	} else if (built.status === 'EXPIRED') {
		lines.push('')
		lines.push('EXPIRED BUILD: the assets being served carry a licence past its date.')
		lines.push('Rotation: docs/operations/tldraw-license.md')
		exitCode = 1
	} else if (built.status === 'EXPIRING_SOON') {
		lines.push('')
		lines.push(`WARNING: the built licence expires in ${built.daysRemaining} day(s).`)
		lines.push('Rotation: docs/operations/tldraw-license.md')
	} else if (configuredExpiry === builtExpiry) {
		lines.push('')
		lines.push('The built assets match the configured key.')
	}

	return { report: lines.join('\n'), exitCode }
}

const invokedDirectly =
	process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
	const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
	const verifyIndex = process.argv.indexOf('--verify-build')

	if (verifyIndex >= 0) {
		const clientDirectory = resolve(
			repoRoot,
			process.argv[verifyIndex + 1] ?? process.env.CANVAS_CLIENT_DIR ?? 'dist/client'
		)
		const configured = evaluateLicense(readConfiguredKey(repoRoot), Date.now())
		const verification = verifyBuild({
			scan: scanBuiltBundle(clientDirectory),
			configuredExpiry: configured.expiresOn,
			now: Date.now(),
		})
		console.log(`verifying: ${clientDirectory}`)
		if (configured.expiresOn) console.log(`configured licence expiry: ${configured.expiresOn}`)
		console.log(verification.report)
		process.exit(verification.exitCode)
	}

	const production = process.argv.includes('--production') || process.env.NODE_ENV === 'production'
	const outcome = preflight({
		key: readConfiguredKey(repoRoot),
		now: Date.now(),
		production,
		allowExpired: process.env.TLDRAW_LICENSE_ALLOW_EXPIRED === '1',
	})
	console.log(outcome.report)
	process.exit(outcome.exitCode)
}
