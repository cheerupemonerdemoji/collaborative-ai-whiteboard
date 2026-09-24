/**
 * Tests for the tldraw licence preflight.
 *
 * Every case injects an explicit instant. Nothing here reads the clock, so the
 * suite behaves identically on the expiry day, the day after, and in 2030.
 *
 * The keys below are fabricated. They carry a deliberate sentinel body so that
 * "the report never prints the key" can be asserted rather than assumed, and
 * the real licence is never needed, read or written by this file.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
	WARNING_THRESHOLDS,
	evaluateLicense,
	formatVerdict,
	preflight,
	readConfiguredKey,
	scanBuiltBundle,
	verifyBuild,
} from '../scripts/license-preflight'

const SECRET_BODY = 'SENTINEL-LICENCE-PAYLOAD-THAT-MUST-NEVER-BE-PRINTED'
const SECRET_SIGNATURE_TEXT = 'SENTINEL-LICENCE-SIGNATURE-THAT-MUST-NEVER-BE-PRINTED'
const SECRET_SIGNATURE = Buffer.from(SECRET_SIGNATURE_TEXT, 'utf8').toString('base64')

/** A structurally realistic key: `<prefix>/<base64 payload>.<signature>`. */
function fakeKey(expiry: string, body: string = SECRET_BODY, personalisedLabel?: string): string {
	const label = personalisedLabel ? `${personalisedLabel}-` : ''
	return `tldraw-${label}${expiry}/${Buffer.from(body, 'utf8').toString('base64')}.${SECRET_SIGNATURE}`
}

/** UTC midnight at the start of an ISO date. */
function utc(iso: string, time = '00:00:00.000'): number {
	return Date.parse(`${iso}T${time}Z`)
}

/** Fixed reference instant for the boundary table. */
const NOW = utc('2026-06-01')

/** An expiry date that leaves exactly `days` whole days on the clock at NOW. */
function expiryLeaving(days: number): string {
	return new Date(NOW + (days - 1) * 86_400_000).toISOString().slice(0, 10)
}

const temporaryDirectories: string[] = []
afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true })
	}
})

describe('licence status classification', () => {
	it('reports MISSING when nothing is configured', () => {
		for (const key of [undefined, null, '', '   ', '\n\t ']) {
			const verdict = evaluateLicense(key, NOW)
			expect(verdict.status).toBe('MISSING')
			expect(verdict.expiresOn).toBeNull()
			expect(verdict.daysRemaining).toBeNull()
			expect(verdict.daysSinceExpiry).toBeNull()
		}
	})

	it('reports VALID when the expiry is beyond every warning threshold', () => {
		const verdict = evaluateLicense(fakeKey(expiryLeaving(31)), NOW)
		expect(verdict.status).toBe('VALID')
		expect(verdict.daysRemaining).toBe(31)
		expect(verdict.threshold).toBeNull()
		expect(verdict.source).toBe('key-prefix')
	})

	it('reports VALID for a key years out', () => {
		const verdict = evaluateLicense(fakeKey('2031-12-31'), NOW)
		expect(verdict.status).toBe('VALID')
		expect(verdict.expiresOn).toBe('2031-12-31')
		expect(verdict.daysRemaining).toBeGreaterThan(1000)
	})

	it('reports VALID for a personalised hobby licence prefix', () => {
		const verdict = evaluateLicense(fakeKey('2031-12-31', SECRET_BODY, 'jane-doe'), NOW)
		expect(verdict.status).toBe('VALID')
		expect(verdict.expiresOn).toBe('2031-12-31')
		expect(verdict.source).toBe('key-prefix')
	})
})

describe('warning thresholds', () => {
	it('lists thresholds tightest first so the most urgent one is selected', () => {
		expect([...WARNING_THRESHOLDS]).toEqual([...WARNING_THRESHOLDS].sort((a, b) => a - b))
	})

	// The boundary itself and the day either side of it, for each threshold.
	const cases: Array<{ days: number; status: string; threshold: number | null }> = [
		{ days: 32, status: 'VALID', threshold: null },
		{ days: 31, status: 'VALID', threshold: null },
		{ days: 30, status: 'EXPIRING_SOON', threshold: 30 },
		{ days: 29, status: 'EXPIRING_SOON', threshold: 30 },
		{ days: 15, status: 'EXPIRING_SOON', threshold: 30 },
		{ days: 14, status: 'EXPIRING_SOON', threshold: 14 },
		{ days: 13, status: 'EXPIRING_SOON', threshold: 14 },
		{ days: 8, status: 'EXPIRING_SOON', threshold: 14 },
		{ days: 7, status: 'EXPIRING_SOON', threshold: 7 },
		{ days: 6, status: 'EXPIRING_SOON', threshold: 7 },
		{ days: 2, status: 'EXPIRING_SOON', threshold: 7 },
		{ days: 1, status: 'EXPIRING_SOON', threshold: 1 },
	]

	for (const { days, status, threshold } of cases) {
		it(`classifies ${days} day(s) remaining as ${status}/${threshold}`, () => {
			const verdict = evaluateLicense(fakeKey(expiryLeaving(days)), NOW)
			expect(verdict.status).toBe(status)
			expect(verdict.daysRemaining).toBe(days)
			expect(verdict.threshold).toBe(threshold)
		})
	}
})

describe('the expiry boundary', () => {
	const EXPIRY = '2026-06-01'

	it('is still usable for the whole of the expiry date', () => {
		for (const time of ['00:00:00.000', '12:00:00.000', '23:59:59.999']) {
			const verdict = evaluateLicense(fakeKey(EXPIRY), utc(EXPIRY, time))
			expect(verdict.status).toBe('EXPIRING_SOON')
			expect(verdict.daysRemaining).toBe(1)
			expect(verdict.threshold).toBe(1)
			expect(verdict.daysSinceExpiry).toBeNull()
		}
	})

	it('lapses at the first instant of the following UTC day', () => {
		expect(evaluateLicense(fakeKey(EXPIRY), utc(EXPIRY, '23:59:59.999')).status).toBe('EXPIRING_SOON')
		expect(evaluateLicense(fakeKey(EXPIRY), utc('2026-06-02')).status).toBe('EXPIRED')
	})

	it('counts whole days since expiry once past', () => {
		expect(evaluateLicense(fakeKey(EXPIRY), utc('2026-06-02')).daysSinceExpiry).toBe(0)
		expect(evaluateLicense(fakeKey(EXPIRY), utc('2026-06-02', '23:59:59.999')).daysSinceExpiry).toBe(0)
		expect(evaluateLicense(fakeKey(EXPIRY), utc('2026-06-03')).daysSinceExpiry).toBe(1)
		expect(evaluateLicense(fakeKey(EXPIRY), utc('2026-07-01')).daysSinceExpiry).toBe(29)
	})

	it('reports EXPIRED long after the date without reporting days remaining', () => {
		const verdict = evaluateLicense(fakeKey('2024-01-01'), NOW)
		expect(verdict.status).toBe('EXPIRED')
		expect(verdict.expiresOn).toBe('2024-01-01')
		expect(verdict.daysRemaining).toBeNull()
		expect(verdict.daysSinceExpiry).toBeGreaterThan(800)
	})

	it('does not model any grace period after the printed date', () => {
		// tldraw has an undocumented internal grace period. Relying on it would
		// mean shipping a build that is already past its stated deadline.
		const justPast = evaluateLicense(fakeKey('2026-06-01'), utc('2026-06-15'))
		expect(justPast.status).toBe('EXPIRED')
	})

	it('rejects an expired personalised hobby licence', () => {
		const verdict = evaluateLicense(fakeKey('2026-05-31', SECRET_BODY, 'jane-doe'), NOW)
		expect(verdict.status).toBe('EXPIRED')
		expect(verdict.expiresOn).toBe('2026-05-31')
	})
})

describe('unreadable or malformed metadata', () => {
	const malformed = [
		['no tldraw prefix at all', 'not-a-licence-key'],
		['prefix without a date', `tldraw/${Buffer.from(SECRET_BODY).toString('base64')}.sig`],
		['month 13', fakeKey('2026-13-01')],
		['month 00', fakeKey('2026-00-10')],
		['day 00', fakeKey('2026-01-00')],
		['day 32', fakeKey('2026-01-32')],
		['30th of February', fakeKey('2026-02-30')],
		['31st of a 30-day month', fakeKey('2026-04-31')],
		['29 February in a common year', fakeKey('2027-02-29')],
		['unpadded month and day', fakeKey('2026-9-3')],
		['a date-shaped but non-numeric prefix', 'tldraw-20xx-09-30/body.sig'],
		['personalised label with an empty segment', fakeKey('2031-12-31').replace('tldraw-', 'tldraw-jane--doe-')],
		['personalised label with uppercase characters', fakeKey('2031-12-31', SECRET_BODY, 'Jane-Doe')],
		['personalised label with punctuation', fakeKey('2031-12-31', SECRET_BODY, 'jane_doe')],
		['missing signature', fakeKey('2031-12-31', SECRET_BODY, 'jane-doe').replace(/\.[^.]+$/, '')],
		['invalid payload encoding', `tldraw-jane-doe-2031-12-31/not*base64.${SECRET_SIGNATURE}`],
		['invalid signature encoding', `${fakeKey('2031-12-31', SECRET_BODY, 'jane-doe')}*`],
	] as const

	for (const [label, key] of malformed) {
		it(`reports UNKNOWN for ${label}`, () => {
			const verdict = evaluateLicense(key, NOW)
			expect(verdict.status).toBe('UNKNOWN')
			expect(verdict.expiresOn).toBeNull()
			expect(verdict.daysRemaining).toBeNull()
			expect(verdict.daysSinceExpiry).toBeNull()
			expect(verdict.source).toBe('none')
		})
	}

	it('accepts a genuine leap day', () => {
		const verdict = evaluateLicense(fakeKey('2028-02-29'), NOW)
		expect(verdict.status).toBe('VALID')
		expect(verdict.expiresOn).toBe('2028-02-29')
	})

	it('accepts an expiry on the last day of a year', () => {
		const verdict = evaluateLicense(fakeKey('2026-12-31'), utc('2026-12-31', '23:00:00.000'))
		expect(verdict.status).toBe('EXPIRING_SOON')
		expect(evaluateLicense(fakeKey('2026-12-31'), utc('2027-01-01')).status).toBe('EXPIRED')
	})
})

describe('corroboration against the encoded payload', () => {
	it('is set when the payload repeats the prefix date', () => {
		const key = fakeKey('2026-09-30', `{"expiryDate":"2026-09-30","who":"${SECRET_BODY}"}`)
		expect(evaluateLicense(key, NOW).corroborated).toBe(true)
	})

	it('is unset when it does not, without changing the verdict', () => {
		const verdict = evaluateLicense(fakeKey('2026-09-30'), NOW)
		expect(verdict.corroborated).toBe(false)
		expect(verdict.status).toBe('VALID')
		expect(formatVerdict(verdict)).toContain('the encoded payload did not repeat this date')
	})
})

describe('preflight blocking behaviour', () => {
	const production = { now: NOW, production: true, allowExpired: false }
	const development = { now: NOW, production: false, allowExpired: false }

	it('blocks a production build with no key', () => {
		const outcome = preflight({ ...production, key: undefined })
		expect(outcome.exitCode).toBe(1)
		expect(outcome.blocking).toBe(true)
		expect(outcome.report).toContain('BLOCKED')
	})

	it('does not block a development build with no key', () => {
		const outcome = preflight({ ...development, key: undefined })
		expect(outcome.exitCode).toBe(0)
		expect(outcome.blocking).toBe(false)
	})

	it('blocks a production build with an expired key', () => {
		const outcome = preflight({ ...production, key: fakeKey('2026-05-31') })
		expect(outcome.exitCode).toBe(1)
		expect(outcome.blocking).toBe(true)
		expect(outcome.report).toContain('BLOCKED')
		expect(outcome.report).toContain('docs/operations/tldraw-license.md')
	})

	it('allows an expired key through only with the explicit override', () => {
		const outcome = preflight({ ...production, key: fakeKey('2026-05-31'), allowExpired: true })
		expect(outcome.exitCode).toBe(0)
		expect(outcome.blocking).toBe(false)
		expect(outcome.report).toContain('OVERRIDDEN')
	})

	it('warns but never blocks on an expiring key', () => {
		const outcome = preflight({ ...production, key: fakeKey(expiryLeaving(7)) })
		expect(outcome.exitCode).toBe(0)
		expect(outcome.blocking).toBe(false)
		expect(outcome.report).toContain('WARNING')
		expect(outcome.report).toContain('7 day(s)')
	})

	it('warns but never blocks on unreadable metadata', () => {
		// A key whose label cannot be parsed may still be perfectly valid. Refusing
		// to deploy on that basis would be a self-inflicted outage.
		const outcome = preflight({ ...production, key: 'not-a-licence-key' })
		expect(outcome.exitCode).toBe(0)
		expect(outcome.blocking).toBe(false)
		expect(outcome.report).toContain('WARNING')
	})

	it('passes a healthy production build silently', () => {
		const outcome = preflight({ ...production, key: fakeKey('2031-12-31') })
		expect(outcome.exitCode).toBe(0)
		expect(outcome.blocking).toBe(false)
		expect(outcome.report).not.toContain('WARNING')
		expect(outcome.report).not.toContain('BLOCKED')
	})
})

describe('the key never appears in any output', () => {
	const encodedBody = Buffer.from(SECRET_BODY, 'utf8').toString('base64')

	const keys = [
		fakeKey('2031-12-31'),
		fakeKey(expiryLeaving(30)),
		fakeKey(expiryLeaving(1)),
		fakeKey('2026-05-31'),
		fakeKey('2020-01-01'),
		fakeKey('2026-02-30'),
		`tldraw-not-a-date/${encodedBody}.${SECRET_SIGNATURE}`,
		fakeKey('2031-12-31', SECRET_BODY, 'jane-doe'),
	]

	it('keeps the key, its payload and its signature out of every report', () => {
		for (const key of keys) {
			for (const isProduction of [true, false]) {
				for (const allowExpired of [true, false]) {
					const outcome = preflight({ key, now: NOW, production: isProduction, allowExpired })
					const surfaces = [outcome.report, formatVerdict(outcome.verdict), outcome.verdict.detail]
					for (const surface of surfaces) {
						expect(surface).not.toContain(key)
						expect(surface).not.toContain(SECRET_BODY)
						expect(surface).not.toContain(SECRET_SIGNATURE)
						expect(surface).not.toContain(SECRET_SIGNATURE_TEXT)
						expect(surface).not.toContain(encodedBody)
					}
				}
			}
		}
	})

	it('does not carry the key on the verdict object itself', () => {
		const verdict = evaluateLicense(fakeKey('2031-12-31'), NOW)
		const serialised = JSON.stringify(verdict)
		expect(serialised).not.toContain(SECRET_BODY)
		expect(serialised).not.toContain(SECRET_SIGNATURE)
		expect(serialised).not.toContain(encodedBody)
	})

	it('still says enough to act on', () => {
		const outcome = preflight({ key: fakeKey('2026-05-31'), now: NOW, production: true, allowExpired: false })
		expect(outcome.report).toContain('2026-05-31')
		expect(outcome.report).toContain('EXPIRED')
	})
})

describe('reading the configured key', () => {
	function repo(files: Record<string, string>): string {
		const directory = mkdtempSync(join(tmpdir(), 'licence-preflight-'))
		temporaryDirectories.push(directory)
		for (const [name, contents] of Object.entries(files)) {
			writeFileSync(join(directory, name), contents)
		}
		return directory
	}

	it('prefers the environment over any file', () => {
		const directory = repo({ '.env': 'VITE_TLDRAW_LICENSE_KEY=from-file' })
		expect(readConfiguredKey(directory, { VITE_TLDRAW_LICENSE_KEY: 'from-env' })).toBe('from-env')
	})

	// Measured against vite.loadEnv('production', ...), not assumed. Checking a
	// different file from the one Vite inlines would mean vetting one key while
	// shipping another - in both directions: blocking a good build, or passing an
	// expired one.
	it('follows Vite own env-file precedence', () => {
		const ladder = [
			['.env', 'lowest'],
			['.env.local', 'third'],
			['.env.production', 'second'],
			['.env.production.local', 'highest'],
		] as const

		const files: Record<string, string> = {}
		for (const [name, value] of ladder) {
			files[name] = `VITE_TLDRAW_LICENSE_KEY=${value}`
		}
		expect(readConfiguredKey(repo(files), {})).toBe('highest')

		// Remove the winner at each step; the next file down must take over.
		const expected = ['highest', 'second', 'third', 'lowest']
		for (let removed = 0; removed < ladder.length; removed++) {
			const remaining: Record<string, string> = {}
			for (const [name, value] of ladder.slice(0, ladder.length - removed)) {
				remaining[name] = `VITE_TLDRAW_LICENSE_KEY=${value}`
			}
			expect(readConfiguredKey(repo(remaining), {})).toBe(expected[removed])
		}
	})

	it('does not let .env.local mask .env.production', () => {
		// The ordering bug this guards against: .env.local is checked before
		// .env.production, so the preflight vets a key Vite will never use.
		const directory = repo({
			'.env.local': 'VITE_TLDRAW_LICENSE_KEY=not-the-one-vite-uses',
			'.env.production': 'VITE_TLDRAW_LICENSE_KEY=the-one-vite-uses',
		})
		expect(readConfiguredKey(directory, {})).toBe('the-one-vite-uses')
	})

	it('strips surrounding quotes and ignores comments and other keys', () => {
		const directory = repo({
			'.env': [
				'# VITE_TLDRAW_LICENSE_KEY=commented-out',
				'VITE_TLDRAW_LICENSE_KEY_OLD=wrong-key',
				'OTHER=value',
				'VITE_TLDRAW_LICENSE_KEY="quoted-value"',
			].join('\n'),
		})
		expect(readConfiguredKey(directory, {})).toBe('quoted-value')
	})

	it('returns undefined when nothing is configured', () => {
		expect(readConfiguredKey(repo({}), {})).toBeUndefined()
		expect(readConfiguredKey(repo({ '.env': 'OTHER=value\n' }), {})).toBeUndefined()
		expect(readConfiguredKey(repo({ '.env': 'VITE_TLDRAW_LICENSE_KEY=\n' }), {})).toBeUndefined()
	})

	it('treats a blank environment value as unset', () => {
		expect(readConfiguredKey(repo({}), { VITE_TLDRAW_LICENSE_KEY: '   ' })).toBeUndefined()
	})
})

describe('verifying the built bundle', () => {
	/** Writes a fake `dist/client` whose asset embeds `key` the way Vite would. */
	function builtClient(assets: Record<string, string>): string {
		const directory = mkdtempSync(join(tmpdir(), 'licence-bundle-'))
		temporaryDirectories.push(directory)
		mkdirSync(join(directory, 'assets'), { recursive: true })
		writeFileSync(join(directory, 'index.html'), '<!doctype html><html><body></body></html>')
		for (const [name, contents] of Object.entries(assets)) {
			writeFileSync(join(directory, 'assets', name), contents)
		}
		return directory
	}

	/** Roughly what Vite emits: the key inlined as a string literal. */
	function inlined(expiry: string, personalisedLabel?: string): string {
		return `const e="${fakeKey(expiry, SECRET_BODY, personalisedLabel)}";export{e as licenseKey};\n`
	}

	it('finds the expiry inlined in a built asset', () => {
		const scan = scanBuiltBundle(builtClient({ 'index-abc.js': inlined('2026-09-30') }))
		expect(scan.expiryDates).toEqual(['2026-09-30'])
		expect(scan.filesScanned).toBe(1)
		expect(scan.occurrences).toBe(1)
	})

	it('finds the expiry inlined from a personalised hobby licence', () => {
		const scan = scanBuiltBundle(
			builtClient({ 'index-abc.js': inlined('2031-12-31', 'jane-doe') })
		)
		expect(scan.expiryDates).toEqual(['2031-12-31'])
		expect(scan.filesScanned).toBe(1)
		expect(scan.occurrences).toBe(1)
	})

	it('scans nested directories and ignores non-JavaScript assets', () => {
		const directory = builtClient({ 'index-abc.js': inlined('2026-09-30'), 'style.css': 'body{}' })
		mkdirSync(join(directory, 'assets', 'chunks'), { recursive: true })
		writeFileSync(join(directory, 'assets', 'chunks', 'vendor.mjs'), inlined('2026-09-30'))
		writeFileSync(join(directory, 'assets', 'notes.txt'), fakeKey('2020-01-01'))
		const scan = scanBuiltBundle(directory)
		expect(scan.filesScanned).toBe(2)
		expect(scan.expiryDates).toEqual(['2026-09-30'])
	})

	it('fails when there is nothing built to inspect', () => {
		const result = verifyBuild({
			scan: scanBuiltBundle(join(tmpdir(), 'licence-bundle-does-not-exist')),
			configuredExpiry: '2026-09-30',
			now: NOW,
		})
		expect(result.exitCode).toBe(1)
		expect(result.report).toContain('NO_BUILD')
	})

	it('passes, without failing, a build carrying no readable licence date', () => {
		const scan = scanBuiltBundle(builtClient({ 'index-abc.js': 'const e=void 0;export{e};\n' }))
		expect(scan.expiryDates).toEqual([])
		const result = verifyBuild({ scan, configuredExpiry: null, now: NOW })
		expect(result.exitCode).toBe(0)
		expect(result.report).toContain('UNKNOWN')
	})

	it('confirms a build that matches the configured key', () => {
		const scan = scanBuiltBundle(builtClient({ 'index-abc.js': inlined('2031-12-31') }))
		const result = verifyBuild({ scan, configuredExpiry: '2031-12-31', now: NOW })
		expect(result.exitCode).toBe(0)
		expect(result.report).toContain('The built assets match the configured key')
	})

	it('catches a rotation where the rebuild was forgotten', () => {
		// The commonest rotation failure: .env updated, dist/ left alone.
		const scan = scanBuiltBundle(builtClient({ 'index-abc.js': inlined('2026-09-30') }))
		const result = verifyBuild({ scan, configuredExpiry: '2031-12-31', now: NOW })
		expect(result.exitCode).toBe(1)
		expect(result.report).toContain('STALE BUILD')
		expect(result.report).toContain('2026-09-30')
		expect(result.report).toContain('2031-12-31')
	})

	it('fails a build whose licence is already past its date', () => {
		const scan = scanBuiltBundle(builtClient({ 'index-abc.js': inlined('2026-05-31') }))
		const result = verifyBuild({ scan, configuredExpiry: '2026-05-31', now: NOW })
		expect(result.exitCode).toBe(1)
		expect(result.report).toContain('EXPIRED BUILD')
	})

	it('warns without failing when the built licence is merely close', () => {
		const scan = scanBuiltBundle(builtClient({ 'index-abc.js': inlined(expiryLeaving(7)) }))
		const result = verifyBuild({ scan, configuredExpiry: expiryLeaving(7), now: NOW })
		expect(result.exitCode).toBe(0)
		expect(result.report).toContain('WARNING')
		expect(result.report).toContain('7 day(s)')
	})

	it('fails a build directory holding two different licences', () => {
		const scan = scanBuiltBundle(
			builtClient({ 'index-abc.js': inlined('2026-09-30'), 'index-def.js': inlined('2031-12-31') })
		)
		expect(scan.expiryDates).toEqual(['2026-09-30', '2031-12-31'])
		const result = verifyBuild({ scan, configuredExpiry: '2031-12-31', now: NOW })
		expect(result.exitCode).toBe(1)
		expect(result.report).toContain('CONFLICT')
	})

	it('reads the date out of the bundle without carrying the key with it', () => {
		const directory = builtClient({ 'index-abc.js': inlined('2026-05-31') })
		const scan = scanBuiltBundle(directory)
		const result = verifyBuild({ scan, configuredExpiry: '2031-12-31', now: NOW })
		const encodedBody = Buffer.from(SECRET_BODY, 'utf8').toString('base64')
		for (const surface of [JSON.stringify(scan), result.report]) {
			expect(surface).not.toContain(SECRET_BODY)
			expect(surface).not.toContain(SECRET_SIGNATURE)
			expect(surface).not.toContain(encodedBody)
		}
	})
})

describe('the build scripts are actually guarded', () => {
	// The safeguard is only worth anything if every path that inlines the key
	// runs it. These assert the wiring itself, so adding an unguarded build
	// script fails the suite rather than quietly reopening the hole.
	const scripts: Record<string, string> = JSON.parse(
		readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')
	).scripts

	const buildScripts = Object.entries(scripts).filter(([, body]) => body.includes('vite build'))

	it('finds every script that inlines the licence into a bundle', () => {
		expect(buildScripts.length).toBeGreaterThan(0)
	})

	for (const [name, body] of buildScripts) {
		it(`${name} runs the licence check before building`, () => {
			expect(body).toContain('license:check:production')
			expect(body.indexOf('license:check:production')).toBeLessThan(body.indexOf('vite build'))
		})
	}

	it('the self-host build proves afterwards that the key reached the bundle', () => {
		const body = scripts['build:selfhost']
		expect(body).toContain('license:verify-build')
		expect(body.indexOf('vite build')).toBeLessThan(body.indexOf('license:verify-build'))
	})
})
