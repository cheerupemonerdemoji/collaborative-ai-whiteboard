import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createAccessVerifier, normalizeTeamDomain } from '../server/access-jwt'

const TEAM = 'example-team.cloudflareaccess.com'
const AUD = 'a'.repeat(64)

function keyPair(kid: string) {
	const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
	const jwk = { ...(publicKey.export({ format: 'jwk' }) as Record<string, string>), kid, alg: 'RS256', use: 'sig' }
	return { privateKey, jwk }
}

function b64(value: unknown): string { return Buffer.from(JSON.stringify(value)).toString('base64url') }

function sign(privateKey: KeyObject, kid: string, claims: Record<string, unknown>, header: Record<string, unknown> = {}): string {
	const head = b64({ alg: 'RS256', kid, typ: 'JWT', ...header })
	const body = b64(claims)
	const signature = createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKey).toString('base64url')
	return `${head}.${body}.${signature}`
}

const NOW = 1_800_000_000_000
const goodClaims = (overrides: Record<string, unknown> = {}) => ({
	iss: `https://${TEAM}`, aud: [AUD], exp: NOW / 1000 + 600, iat: NOW / 1000 - 10, common_name: 'client-id-123.access', ...overrides,
})

function setup(fetchOverride?: () => Promise<{ keys: unknown[] }>) {
	const pair = keyPair('k1')
	let fetches = 0
	let clock = NOW
	const verifier = createAccessVerifier({
		teamDomain: TEAM,
		audience: AUD,
		now: () => clock,
		fetchJwks: async () => { fetches += 1; return (fetchOverride ? await fetchOverride() : { keys: [pair.jwk] }) as { keys: [] } },
	})
	return { pair, verifier, fetches: () => fetches, advance: (ms: number) => { clock += ms } }
}

describe('Cloudflare Access assertion verification', () => {
	it('accepts a correctly signed assertion for this team and audience and reports the service-token client id', async () => {
		const { pair, verifier } = setup()
		expect(await verifier.verify(sign(pair.privateKey, 'k1', goodClaims()))).toEqual({ ok: true, clientId: 'client-id-123.access' })
	})

	it('accepts a single-string audience claim', async () => {
		const { pair, verifier } = setup()
		expect((await verifier.verify(sign(pair.privateKey, 'k1', goodClaims({ aud: AUD })))).ok).toBe(true)
	})

	it.each([
		['missing', undefined],
		['empty', ''],
		['not a jwt', 'abc'],
		['four parts', 'a.b.c.d'],
		['oversized', 'x'.repeat(9_000)],
	])('refuses a %s assertion', async (_name, value) => {
		const { verifier } = setup()
		expect((await verifier.verify(value)).ok).toBe(false)
	})

	it('refuses the wrong audience, the wrong issuer, and an expired or not-yet-valid token', async () => {
		const { pair, verifier } = setup()
		const cases: [string, Record<string, unknown>][] = [
			['wrong audience', { aud: ['b'.repeat(64)] }],
			['wrong issuer', { iss: 'https://other-team.cloudflareaccess.com' }],
			['expired', { exp: NOW / 1000 - 120 }],
			['not yet valid', { nbf: NOW / 1000 + 3_600 }],
			['no expiry', { exp: undefined }],
		]
		for (const [name, overrides] of cases) {
			const verdict = await verifier.verify(sign(pair.privateKey, 'k1', goodClaims(overrides)))
			expect(verdict.ok, name).toBe(false)
		}
	})

	it('refuses a token signed with a different key, and algorithms other than RS256', async () => {
		const { pair, verifier } = setup()
		const attacker = keyPair('k1')
		expect((await verifier.verify(sign(attacker.privateKey, 'k1', goodClaims()))).ok).toBe(false)
		expect((await verifier.verify(sign(pair.privateKey, 'k1', goodClaims(), { alg: 'none' }))).ok).toBe(false)
		expect((await verifier.verify(sign(pair.privateKey, 'k1', goodClaims(), { alg: 'HS256' }))).ok).toBe(false)
		const [head, body] = sign(pair.privateKey, 'k1', goodClaims()).split('.')
		expect((await verifier.verify(`${head}.${body}.`)).ok).toBe(false)
	})

	it('refuses a tampered payload', async () => {
		const { pair, verifier } = setup()
		const [head, , signature] = sign(pair.privateKey, 'k1', goodClaims()).split('.')
		expect((await verifier.verify(`${head}.${b64(goodClaims({ aud: [AUD], common_name: 'someone-else' }))}.${signature}`)).ok).toBe(false)
	})

	it('fails closed when the signing keys cannot be fetched', async () => {
		const { pair, verifier } = setup(async () => { throw new Error('network down') })
		expect((await verifier.verify(sign(pair.privateKey, 'k1', goodClaims()))).ok).toBe(false)
	})

	it('caches keys, and cannot be turned into an outbound request stream by forged key ids', async () => {
		const { pair, verifier, fetches, advance } = setup()
		const good = sign(pair.privateKey, 'k1', goodClaims())
		expect((await verifier.verify(good)).ok).toBe(true)
		expect((await verifier.verify(good)).ok).toBe(true)
		expect(fetches()).toBe(1)
		for (let i = 0; i < 25; i++) expect((await verifier.verify(sign(pair.privateKey, `forged-${i}`, goodClaims()))).ok).toBe(false)
		expect(fetches()).toBe(1)
		advance(61_000)
		expect((await verifier.verify(sign(pair.privateKey, 'forged-again', goodClaims()))).ok).toBe(false)
		expect(fetches()).toBe(2)
	})

	it('keeps trusting a cached key through a key-endpoint outage only for a bounded grace period, then fails closed', async () => {
		const pair = keyPair('k1')
		let outage = false
		const { verifier, advance } = setup(async () => { if (outage) throw new Error('certs unreachable'); return { keys: [pair.jwk] } })
		const token = () => sign(pair.privateKey, 'k1', goodClaims({ exp: 1_900_000_000 }))
		expect((await verifier.verify(token())).ok).toBe(true)
		outage = true
		advance(2 * 60 * 60_000)
		expect((await verifier.verify(token())).ok).toBe(true)
		advance(23 * 60 * 60_000)
		expect((await verifier.verify(token())).ok).toBe(false)
		outage = false
		advance(61_000)
		expect((await verifier.verify(token())).ok).toBe(true)
	})

	it('picks up a rotated signing key after the refresh interval', async () => {
		const first = keyPair('k1')
		const second = keyPair('k2')
		let current = first
		const { verifier, advance } = setup(async () => ({ keys: [current.jwk] }))
		expect((await verifier.verify(sign(first.privateKey, 'k1', goodClaims()))).ok).toBe(true)
		current = second
		advance(61_000)
		expect((await verifier.verify(sign(second.privateKey, 'k2', goodClaims()))).ok).toBe(true)
	})

	it('validates its configuration', () => {
		expect(() => createAccessVerifier({ teamDomain: 'not a domain', audience: AUD })).toThrow()
		expect(() => createAccessVerifier({ teamDomain: TEAM, audience: '  ' })).toThrow()
		expect(normalizeTeamDomain('https://Example-Team.cloudflareaccess.com/')).toBe(TEAM)
		expect(normalizeTeamDomain('localhost')).toBeNull()
	})
})
