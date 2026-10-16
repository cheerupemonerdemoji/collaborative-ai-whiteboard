import { describe, expect, it } from 'vitest'
import { SlidingWindowRateLimiter } from '../server/security'

describe('SlidingWindowRateLimiter', () => {
	it('allows up to the limit inside a window, then refuses until entries leave it', () => {
		const limiter = new SlidingWindowRateLimiter(2, 1_000)
		expect(limiter.allow('k', 0)).toBe(true)
		expect(limiter.allow('k', 100)).toBe(true)
		expect(limiter.allow('k', 200)).toBe(false)
		expect(limiter.allow('k', 1_001)).toBe(true) // the first has left the window
		expect(limiter.allow('other', 200)).toBe(true) // keys are independent
	})

	it('wouldAllow answers exactly what allow would, without recording anything', () => {
		const limiter = new SlidingWindowRateLimiter(2, 1_000)
		for (let index = 0; index < 10; index += 1) expect(limiter.wouldAllow('k', 0), 'peeking never spends').toBe(true)
		expect(limiter.allow('k', 0)).toBe(true)
		expect(limiter.wouldAllow('k', 500)).toBe(true)
		expect(limiter.allow('k', 500)).toBe(true)
		expect(limiter.wouldAllow('k', 600)).toBe(false)
		expect(limiter.allow('k', 600)).toBe(false)
		expect(limiter.wouldAllow('k', 1_001)).toBe(true) // only the entry at 0 has left the window
		expect(limiter.allow('k', 1_001)).toBe(true)
		expect(limiter.wouldAllow('k', 1_002)).toBe(false) // 500 and 1001 remain
		expect(limiter.allow('k', 1_002)).toBe(false)
	})

	it('does not let a peek on one key affect another', () => {
		const limiter = new SlidingWindowRateLimiter(1, 1_000)
		expect(limiter.wouldAllow('a', 0)).toBe(true)
		expect(limiter.allow('b', 0)).toBe(true)
		expect(limiter.wouldAllow('a', 0)).toBe(true)
		expect(limiter.wouldAllow('b', 0)).toBe(false)
	})
})
