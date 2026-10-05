import { normalizeTeamDomain, type AccessVerifier } from './access-jwt'

/**
 * Hostname classes for the public machine API.
 *
 * - `machine`: the dedicated API hostname. Only the machine route set is served, human cookies are
 *   ignored, and the Cloudflare Access assertion is required.
 * - `human`: the public browser hostname. Machine bearer tokens are refused here, so there is no
 *   public path around the machine hostname's Access layer.
 * - `invalid`: no usable Host header while a hostname is configured. Refused (400).
 * - `private`: anything else (loopback, the tailnet name). Unchanged legacy behaviour, kept on
 *   purpose as the local/development/recovery path for machine clients.
 *
 * Classification uses only the `Host` header the origin actually received. The origin listens on
 * loopback only, so the sole remote path to it is the local tunnel process, which sets `Host` to the
 * public hostname Cloudflare routed. `X-Forwarded-Host` is never consulted.
 */
export type HostClass = 'machine' | 'human' | 'private' | 'invalid'

export interface HostPolicyConfig {
	publicHost?: string
	machineHost?: string
	/** Required for the machine host to serve anything unless `requireAccess` is explicitly false (tests only). */
	accessVerifier?: AccessVerifier | null
	requireAccess?: boolean
}

export interface HostPolicy {
	readonly publicHost: string | null
	readonly machineHost: string | null
	readonly accessVerifier: AccessVerifier | null
	readonly requireAccess: boolean
	classify(hostHeader: string | string[] | undefined): HostClass
}

/** Lower-cases and strips the port and a trailing dot. Returns null for anything that is not a plain DNS name or IP. */
export function normalizeHost(value: string | string[] | undefined): string | null {
	if (typeof value !== 'string') return null
	const trimmed = value.trim().toLowerCase()
	if (!trimmed || trimmed.includes(',') || /\s/.test(trimmed)) return null
	const withoutPort = trimmed.startsWith('[') ? trimmed.replace(/^(\[[0-9a-f:.]+\]).*$/, '$1') : trimmed.replace(/:\d{1,5}$/, '')
	const host = withoutPort.replace(/\.$/, '')
	return /^(\[[0-9a-f:.]+\]|[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*)$/.test(host) ? host : null
}

export function createHostPolicy(config: HostPolicyConfig): HostPolicy {
	const publicHost = config.publicHost ? normalizeHost(config.publicHost) : null
	const machineHost = config.machineHost ? normalizeHost(config.machineHost) : null
	if (config.publicHost && !publicHost) throw new Error('CANVAS_PUBLIC_HOST is not a valid hostname')
	if (config.machineHost && !machineHost) throw new Error('CANVAS_MACHINE_API_HOST is not a valid hostname')
	if (publicHost && machineHost && publicHost === machineHost) throw new Error('The public and machine API hostnames must differ')
	return {
		publicHost,
		machineHost,
		accessVerifier: config.accessVerifier ?? null,
		requireAccess: config.requireAccess ?? true,
		classify(hostHeader) {
			const host = normalizeHost(hostHeader)
			// Once any hostname is configured, a missing or unparseable Host is refused rather than
			// falling into the permissive `private` class.
			if (!host && (publicHost || machineHost)) return 'invalid'
			if (host && machineHost && host === machineHost) return 'machine'
			if (host && publicHost && host === publicHost) return 'human'
			return 'private'
		},
	}
}

export function hostPolicyFromEnv(env: NodeJS.ProcessEnv, verifier: (teamDomain: string, audience: string) => AccessVerifier): HostPolicyConfig {
	const teamDomain = env.CANVAS_ACCESS_TEAM_DOMAIN?.trim()
	const audience = env.CANVAS_ACCESS_AUD?.trim()
	if (teamDomain && !normalizeTeamDomain(teamDomain)) throw new Error('CANVAS_ACCESS_TEAM_DOMAIN is not a valid hostname')
	return {
		publicHost: env.CANVAS_PUBLIC_HOST?.trim() || undefined,
		machineHost: env.CANVAS_MACHINE_API_HOST?.trim() || undefined,
		accessVerifier: teamDomain && audience ? verifier(teamDomain, audience) : null,
	}
}

interface MachineRoute { method: 'GET' | 'POST'; pattern: RegExp }
const ID = '[A-Za-z0-9_-]{1,80}'

/**
 * The complete set of operations a machine client may call. Derived from the routes that already
 * accept a board-scoped bearer token; anything else (login, registration, invitations, boards,
 * members, uploads, assets, evidence-table writes, WebSockets, the browser shell) is not served on
 * the machine hostname at all.
 */
export const MACHINE_ROUTES: readonly MachineRoute[] = [
	{ method: 'GET', pattern: /^\/api\/health$/ },
	{ method: 'GET', pattern: new RegExp(`^/api/rooms/${ID}/canvas$`) },
	{ method: 'POST', pattern: new RegExp(`^/api/rooms/${ID}/actions$`) },
	{ method: 'GET', pattern: new RegExp(`^/api/rooms/${ID}/semantic-context$`) },
	{ method: 'POST', pattern: new RegExp(`^/api/rooms/${ID}/ai/events$`) },
	{ method: 'GET', pattern: new RegExp(`^/api/boards/${ID}/history$`) },
	{ method: 'GET', pattern: new RegExp(`^/api/boards/${ID}/history/\\d{1,15}/snapshot$`) },
	{ method: 'GET', pattern: new RegExp(`^/api/boards/${ID}/checkpoints$`) },
	{ method: 'POST', pattern: new RegExp(`^/api/boards/${ID}/checkpoints$`) },
	{ method: 'POST', pattern: new RegExp(`^/api/boards/${ID}/restore$`) },
]

export function isMachineRoute(method: string, url: string): boolean {
	const path = url.split('?')[0]
	return MACHINE_ROUTES.some((route) => route.method === method && route.pattern.test(path))
}
