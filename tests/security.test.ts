import { describe, expect, it } from 'vitest'
import { clientAddress, requestIsSecure } from '../server/security'

function request(remoteAddress: string, headers: Record<string, string> = {}, protocol = 'http') {
	return { protocol, ip: remoteAddress, headers, raw: { socket: { remoteAddress } } }
}

describe('local reverse proxy trust', () => {
	it('accepts forwarded HTTPS and edge client addresses only from loopback', () => {
		const tunneled = request('127.0.0.1', {
			'x-forwarded-proto': 'https',
			'cf-connecting-ip': '203.0.113.12',
			'x-forwarded-for': '198.51.100.4, 127.0.0.1',
		})
		expect(requestIsSecure(tunneled)).toBe(true)
		expect(clientAddress(tunneled)).toBe('203.0.113.12')

		const untrusted = request('192.0.2.8', {
			'x-forwarded-proto': 'https',
			'cf-connecting-ip': '203.0.113.12',
		})
		expect(requestIsSecure(untrusted)).toBe(false)
		expect(clientAddress(untrusted)).toBe('192.0.2.8')
	})

	it('uses the first forwarded address for a trusted non-Cloudflare local proxy', () => {
		expect(clientAddress(request('::1', { 'x-forwarded-for': '192.0.2.20, ::1' }))).toBe('192.0.2.20')
	})
})
