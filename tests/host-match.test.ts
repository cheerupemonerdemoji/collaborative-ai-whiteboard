import { describe, expect, it } from 'vitest'
import { hostIsOrIsUnder } from '../scripts/host-match.mjs'

describe('hostIsOrIsUnder', () => {
	it('accepts the exact domain and properly delimited subdomains', () => {
		expect(hostIsOrIsUnder('example.com', 'example.com')).toBe(true)
		expect(hostIsOrIsUnder('www.example.com', 'example.com')).toBe(true)
		expect(hostIsOrIsUnder('a.b.example.com', 'example.com')).toBe(true)
		expect(hostIsOrIsUnder('EXAMPLE.com', 'example.COM')).toBe(true)
		expect(hostIsOrIsUnder('team.example.com.', 'example.com')).toBe(true)
	})

	it('rejects unrelated hosts that merely end with the same characters', () => {
		expect(hostIsOrIsUnder('notexample.com', 'example.com')).toBe(false)
		expect(hostIsOrIsUnder('evilexample.com', 'example.com')).toBe(false)
		expect(hostIsOrIsUnder('xexample.com', 'example.com')).toBe(false)
	})

	it('rejects hosts where the domain is only a prefix or an embedded label', () => {
		expect(hostIsOrIsUnder('example.com.evil.net', 'example.com')).toBe(false)
		expect(hostIsOrIsUnder('example.com-evil.net', 'example.com')).toBe(false)
		expect(hostIsOrIsUnder('example.community', 'example.com')).toBe(false)
	})

	it('rejects empty input', () => {
		expect(hostIsOrIsUnder('', 'example.com')).toBe(false)
		expect(hostIsOrIsUnder('example.com', '')).toBe(false)
	})

	it('agrees with URL parsing for userinfo and port tricks', () => {
		const host = (url: string) => new URL(url).hostname
		expect(hostIsOrIsUnder(host('https://team.example.com:8443/login'), 'example.com')).toBe(true)
		expect(hostIsOrIsUnder(host('https://example.com@evil.net/login'), 'example.com')).toBe(false)
		expect(hostIsOrIsUnder(host('https://evil.net/?next=https://example.com'), 'example.com')).toBe(false)
	})
})
