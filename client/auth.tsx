import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
} from 'react'
import { Navigate, Outlet, useLocation } from 'react-router-dom'
import './account-history.css'

export interface AuthUser {
	id: string
	login: string
	displayName: string
	settings?: Record<string, unknown>
	isAdmin?: boolean
	createdAt: number | string
	updatedAt: number | string
	lastLoginAt: number | string | null
	disabledAt?: number | string | null
}

export interface AuthSession {
	id: string
	createdAt: number | string
	expiresAt: number | string
	lastSeenAt: number | string
}

export interface LoginInput {
	login: string
	password: string
}

export interface RegistrationInput extends LoginInput {
	displayName: string
	invitationToken?: string
}

interface AuthResponse {
	user: AuthUser
	session: AuthSession
}

interface AuthContextValue {
	user: AuthUser | null
	session: AuthSession | null
	isLoading: boolean
	startupError: string | null
	login(input: LoginInput): Promise<void>
	register(input: RegistrationInput): Promise<void>
	logout(): Promise<void>
	refresh(): Promise<void>
}

export class ApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly details?: unknown
	) {
		super(message)
		this.name = 'ApiError'
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorMessage(body: unknown, fallback: string) {
	if (!isRecord(body)) return fallback
	for (const key of ['message', 'error']) {
		if (typeof body[key] === 'string' && body[key].trim()) return body[key]
	}
	return fallback
}

/** Same-origin JSON helper. Authentication is carried only by the HttpOnly session cookie. */
export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
	const headers = new Headers(init.headers)
	headers.set('Accept', 'application/json')
	if (init.body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
	const response = await fetch(path, { ...init, headers, credentials: 'same-origin' })
	let body: unknown
	if (response.status !== 204) {
		const contentType = response.headers.get('content-type') ?? ''
		body = contentType.includes('application/json') ? await response.json() : await response.text()
	}
	if (!response.ok) {
		throw new ApiError(errorMessage(body, `Request failed (${response.status})`), response.status, body)
	}
	return body as T
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
	const [user, setUser] = useState<AuthUser | null>(null)
	const [session, setSession] = useState<AuthSession | null>(null)
	const [isLoading, setIsLoading] = useState(true)
	const [startupError, setStartupError] = useState<string | null>(null)

	const refresh = useCallback(async () => {
		setIsLoading(true)
		setStartupError(null)
		try {
			const result = await apiRequest<AuthResponse>('/api/auth/me')
			setUser(result.user)
			setSession(result.session)
		} catch (error) {
			setUser(null)
			setSession(null)
			if (!(error instanceof ApiError && error.status === 401)) {
				setStartupError(error instanceof Error ? error.message : 'Could not check your account.')
			}
		} finally {
			setIsLoading(false)
		}
	}, [])

	useEffect(() => {
		void refresh()
	}, [refresh])

	const login = useCallback(async (input: LoginInput) => {
		const result = await apiRequest<AuthResponse>('/api/auth/login', {
			method: 'POST',
			body: JSON.stringify(input),
		})
		setUser(result.user)
		setSession(result.session)
		setStartupError(null)
	}, [])

	const register = useCallback(async (input: RegistrationInput) => {
		const result = await apiRequest<AuthResponse>('/api/auth/register', {
			method: 'POST',
			body: JSON.stringify(input),
		})
		setUser(result.user)
		setSession(result.session)
		setStartupError(null)
	}, [])

	const logout = useCallback(async () => {
		try {
			await apiRequest<void>('/api/auth/logout', { method: 'POST' })
		} finally {
			setUser(null)
			setSession(null)
		}
	}, [])

	const value = useMemo<AuthContextValue>(
		() => ({ user, session, isLoading, startupError, login, register, logout, refresh }),
		[user, session, isLoading, startupError, login, register, logout, refresh]
	)

	return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
	const value = useContext(AuthContext)
	if (!value) throw new Error('useAuth must be used inside AuthProvider')
	return value
}

/** Route guard for a parent route. It renders nested routes through an Outlet. */
export function RequireAuth() {
	const auth = useAuth()
	const location = useLocation()
	if (auth.isLoading) return <AuthStatusScreen message="Checking your account…" />
	if (auth.startupError) {
		return <AuthStatusScreen message={auth.startupError} actionLabel="Try again" onAction={() => void auth.refresh()} />
	}
	if (!auth.user) return <Navigate to="/login" replace state={{ from: location }} />
	return <Outlet />
}

export function AuthStatusScreen({
	message,
	actionLabel,
	onAction,
}: {
	message: string
	actionLabel?: string
	onAction?: () => void
}) {
	return <main className="aw-auth-screen">
		<section className="aw-status-card" role="status">
			<div className="aw-brand-mark" aria-hidden="true">✦</div>
			<p>{message}</p>
			{actionLabel && onAction ? <button className="aw-primary-button" onClick={onAction}>{actionLabel}</button> : null}
		</section>
	</main>
}
