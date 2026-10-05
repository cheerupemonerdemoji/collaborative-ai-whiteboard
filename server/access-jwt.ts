import { createPublicKey, verify, type KeyObject } from 'node:crypto'

/**
 * Origin-side verification of the Cloudflare Access assertion.
 *
 * Cloudflare Access is the first authorization layer for the machine hostname. It authenticates a
 * service token at the edge and forwards the request with a signed `Cf-Access-Jwt-Assertion`
 * header. Verifying that signature here means the machine API stays closed even if the Access
 * application is misconfigured or removed: a request that did not pass Access carries no valid
 * assertion and is refused before it reaches any route. Every failure path fails closed.
 */

export type AccessVerdict = { ok: true; clientId: string | null } | { ok: false; reason: string }

export interface AccessVerifier {
	verify(assertion: string | undefined): Promise<AccessVerdict>
}

interface Jwk { kid?: string; kty?: string; n?: string; e?: string; alg?: string }
export type JwksFetcher = () => Promise<{ keys: Jwk[] }>

export interface AccessVerifierOptions {
	/** Team domain, e.g. `example.cloudflareaccess.com` (no scheme). */
	teamDomain: string
	/** Application Audience (AUD) tag of the Access application protecting the machine hostname. */
	audience: string
	fetchJwks?: JwksFetcher
	now?: () => number
}

const CLOCK_SKEW_SECONDS = 30
const KEY_TTL_MS = 60 * 60_000
const MIN_REFRESH_INTERVAL_MS = 60_000
/** How long a cached signing key may keep being used after its TTL if Cloudflare's key endpoint is unreachable. */
const MAX_STALE_GRACE_MS = 24 * 60 * 60_000
const MAX_ASSERTION_LENGTH = 8_192

function base64urlJson(segment: string): unknown {
	return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'))
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function normalizeTeamDomain(value: string): string | null {
	const host = value.trim().toLowerCase().replace(/^https:\/\//, '').replace(/\/+$/, '')
	return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host) ? host : null
}

export function createAccessVerifier(options: AccessVerifierOptions): AccessVerifier {
	const teamDomain = normalizeTeamDomain(options.teamDomain)
	if (!teamDomain) throw new Error('Invalid Cloudflare Access team domain')
	if (!options.audience.trim()) throw new Error('Cloudflare Access audience tag is required')
	const issuer = `https://${teamDomain}`
	const now = options.now ?? Date.now
	const fetchJwks: JwksFetcher = options.fetchJwks ?? (async () => {
		const response = await fetch(`${issuer}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(5_000), redirect: 'error' })
		if (!response.ok) throw new Error(`certs request failed (${response.status})`)
		return await response.json() as { keys: Jwk[] }
	})

	let keys = new Map<string, KeyObject>()
	let loadedAt = 0
	let lastAttemptAt = 0

	async function refresh(): Promise<void> {
		lastAttemptAt = now()
		const jwks = await fetchJwks()
		const next = new Map<string, KeyObject>()
		for (const jwk of jwks.keys ?? []) {
			if (jwk.kty !== 'RSA' || !jwk.kid) continue
			try { next.set(jwk.kid, createPublicKey({ key: jwk as never, format: 'jwk' })) } catch { /* skip unusable key */ }
		}
		if (next.size === 0) throw new Error('no usable signing keys')
		keys = next
		loadedAt = now()
	}

	async function keyFor(kid: string): Promise<KeyObject | null> {
		const age = now() - loadedAt
		const known = keys.get(kid)
		if (known && age < KEY_TTL_MS) return known
		// Unknown kid or stale cache: refresh, but never more than once a minute (an attacker must
		// not be able to turn forged kids into a stream of outbound requests).
		if (now() - lastAttemptAt >= MIN_REFRESH_INTERVAL_MS) {
			try { await refresh() } catch { /* fall through to the bounded grace below */ }
		}
		const current = keys.get(kid)
		if (!current) return null
		// A cached key is trusted past its TTL only while Cloudflare's key endpoint is unreachable,
		// and only for a bounded grace period; after that the verifier fails closed.
		return now() - loadedAt < KEY_TTL_MS + MAX_STALE_GRACE_MS ? current : null
	}

	return {
		async verify(assertion) {
			try {
				if (!assertion || assertion.length > MAX_ASSERTION_LENGTH) return { ok: false, reason: 'missing assertion' }
				const parts = assertion.split('.')
				if (parts.length !== 3) return { ok: false, reason: 'malformed assertion' }
				const header = base64urlJson(parts[0])
				if (!isRecord(header) || header.alg !== 'RS256' || typeof header.kid !== 'string') return { ok: false, reason: 'unsupported algorithm' }
				const key = await keyFor(header.kid)
				if (!key) return { ok: false, reason: 'unknown signing key' }
				const signed = Buffer.from(`${parts[0]}.${parts[1]}`)
				if (!verify('RSA-SHA256', signed, key, Buffer.from(parts[2], 'base64url'))) return { ok: false, reason: 'bad signature' }
				const claims = base64urlJson(parts[1])
				if (!isRecord(claims)) return { ok: false, reason: 'malformed claims' }
				if (claims.iss !== issuer) return { ok: false, reason: 'wrong issuer' }
				const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
				if (!audience.includes(options.audience)) return { ok: false, reason: 'wrong audience' }
				const seconds = Math.floor(now() / 1000)
				if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_SECONDS < seconds) return { ok: false, reason: 'expired' }
				if (typeof claims.nbf === 'number' && claims.nbf - CLOCK_SKEW_SECONDS > seconds) return { ok: false, reason: 'not yet valid' }
				return { ok: true, clientId: typeof claims.common_name === 'string' ? claims.common_name : null }
			} catch {
				return { ok: false, reason: 'invalid assertion' }
			}
		},
	}
}
