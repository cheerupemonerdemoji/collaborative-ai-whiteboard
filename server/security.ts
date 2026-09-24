import { timingSafeEqual } from 'node:crypto'

export const SESSION_COOKIE = 'canvas_session'

export function readCookie(header: string | undefined, name = SESSION_COOKIE): string | null {
	for (const item of (header ?? '').split(';')) {
		const separator = item.indexOf('=')
		if (separator < 0 || item.slice(0, separator).trim() !== name) continue
		try { return decodeURIComponent(item.slice(separator + 1).trim()) }
		catch { return null }
	}
	return null
}

export function sessionCookie(token: string, secure: boolean, maxAgeSeconds: number): string {
	return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`
}

export function expiredSessionCookie(secure: boolean): string {
	return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`
}

export function allowedOrigins(raw: string | undefined): Set<string> {
	const defaults = ['http://127.0.0.1:8787', 'http://localhost:8787']
	return new Set((raw ? raw.split(',') : defaults).map((origin) => origin.trim().replace(/\/$/, '')).filter(Boolean))
}

export function originAllowed(origin: string | undefined, allowed: ReadonlySet<string>): boolean {
	if (!origin) return false
	return allowed.has(origin.replace(/\/$/, ''))
}

interface ProxiedRequest {
	protocol: string
	ip: string
	headers: Record<string, string | string[] | undefined>
	raw: { socket: { remoteAddress?: string } }
}

export function isLoopbackAddress(address: string | undefined): boolean {
	return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** Trust forwarded transport information only from a proxy on this host. */
export function requestIsSecure(request: ProxiedRequest): boolean {
	if (request.protocol === 'https') return true
	if (!isLoopbackAddress(request.raw.socket.remoteAddress)) return false
	const forwarded = request.headers['x-forwarded-proto']
	return typeof forwarded === 'string' && forwarded.split(',')[0]?.trim().toLowerCase() === 'https'
}

/** Resolve the edge client address without trusting forwarded headers from remote peers. */
export function clientAddress(request: ProxiedRequest): string {
	const peer = request.raw.socket.remoteAddress ?? request.ip
	if (!isLoopbackAddress(peer)) return peer
	const cloudflare = request.headers['cf-connecting-ip']
	if (typeof cloudflare === 'string' && cloudflare.trim()) return cloudflare.trim()
	const forwarded = request.headers['x-forwarded-for']
	if (typeof forwarded === 'string') {
		const first = forwarded.split(',')[0]?.trim()
		if (first) return first
	}
	return peer
}

export function constantTimeTextEqual(left: string, right: string): boolean {
	const a = Buffer.from(left)
	const b = Buffer.from(right)
	return a.length === b.length && timingSafeEqual(a, b)
}

export class SlidingWindowRateLimiter {
	private readonly attempts = new Map<string, number[]>()
	constructor(private readonly limit: number, private readonly windowMs: number) {}

	allow(key: string, now = Date.now()): boolean {
		const cutoff = now - this.windowMs
		const recent = (this.attempts.get(key) ?? []).filter((time) => time > cutoff)
		if (recent.length >= this.limit) {
			this.attempts.set(key, recent)
			return false
		}
		recent.push(now)
		this.attempts.set(key, recent)
		if (this.attempts.size > 5_000) this.prune(now)
		return true
	}

	private prune(now: number) {
		const cutoff = now - this.windowMs
		for (const [key, values] of this.attempts) {
			if (!values.some((time) => time > cutoff)) this.attempts.delete(key)
		}
	}
}
