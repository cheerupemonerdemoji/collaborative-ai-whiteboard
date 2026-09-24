import { type FormEvent, useState } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { apiRequest, ApiError, AuthStatusScreen, useAuth } from '../auth'

type Mode = 'login' | 'register'

function returnPath(state: unknown) {
	if (!state || typeof state !== 'object' || !('from' in state)) return '/boards'
	const from = (state as { from?: unknown }).from
	if (!from || typeof from !== 'object') return '/boards'
	const pathname = 'pathname' in from && typeof from.pathname === 'string' ? from.pathname : '/boards'
	const search = 'search' in from && typeof from.search === 'string' ? from.search : ''
	return pathname.startsWith('/') && !pathname.startsWith('//') ? `${pathname}${search}` : '/boards'
}

export function Login() {
	const auth = useAuth()
	const navigate = useNavigate()
	const location = useLocation()
	const [initialInvitation] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get('invite') ?? new URLSearchParams(window.location.search).get('invite') ?? '')
	const [mode, setMode] = useState<Mode>(initialInvitation ? 'register' : 'login')
	const [login, setLogin] = useState('')
	const [displayName, setDisplayName] = useState('')
	const [password, setPassword] = useState('')
	const [invitationToken, setInvitationToken] = useState(initialInvitation)
	const [error, setError] = useState<string | null>(null)
	const [submitting, setSubmitting] = useState(false)

	if (auth.isLoading) return <AuthStatusScreen message="Checking your account…" />
	if (auth.user && initialInvitation) return <main className="aw-auth-screen"><section className="aw-status-card">
		<h1>Join this whiteboard</h1><p>Accept the invitation as {auth.user.displayName}.</p>
		{error ? <p role="alert">{error}</p> : null}
		<button disabled={submitting} onClick={() => {
			setSubmitting(true)
			void apiRequest<{ invitation: { boardId?: string } }>('/api/invitations/consume', { method: 'POST', body: JSON.stringify({ token: initialInvitation }) })
				.then((result) => navigate(result.invitation.boardId ? `/room/${result.invitation.boardId}` : '/boards', { replace: true }))
				.catch((caught) => setError(caught instanceof Error ? caught.message : 'Could not accept invitation'))
				.finally(() => setSubmitting(false))
		}}>Accept invitation</button>
		<button onClick={() => navigate('/boards', { replace: true })}>Cancel</button>
	</section></main>
	if (auth.user) return <Navigate to={returnPath(location.state)} replace />

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		setError(null)
		setSubmitting(true)
		try {
			if (mode === 'login') {
				await auth.login({ login: login.trim(), password })
				if (initialInvitation) {
					await apiRequest('/api/invitations/consume', { method: 'POST', body: JSON.stringify({ token: initialInvitation }) })
				}
			}
			else await auth.register({
				login: login.trim(),
				displayName: displayName.trim(),
				password,
				...(invitationToken.trim() ? { invitationToken: invitationToken.trim() } : {}),
			})
			navigate(returnPath(location.state), { replace: true })
		} catch (caught) {
			if (mode === 'login' && caught instanceof ApiError && caught.status === 401) {
				setError('That login or password was not accepted.')
			} else {
				setError(caught instanceof Error ? caught.message : 'Something went wrong. Please try again.')
			}
		} finally {
			setSubmitting(false)
		}
	}

	function changeMode(nextMode: Mode) {
		setMode(nextMode)
		setError(null)
		setPassword('')
	}

	return <main className="aw-auth-screen">
		<section className="aw-auth-card" aria-labelledby="account-heading">
			<div className="aw-auth-brand"><span className="aw-brand-mark" aria-hidden="true">✦</span> Collaborative AI Canvas</div>
			<h1 id="account-heading">{mode === 'login' ? 'Welcome back' : 'Create your account'}</h1>
			<p className="aw-muted">
				{mode === 'login'
					? 'Sign in to open your whiteboards and collaborate.'
					: 'The first person can create the owner account. Later accounts may need an invitation.'}
			</p>
			<div className="aw-segmented" aria-label="Account action">
				<button type="button" className={mode === 'login' ? 'active' : ''} onClick={() => changeMode('login')}>Sign in</button>
				<button type="button" className={mode === 'register' ? 'active' : ''} onClick={() => changeMode('register')}>Create account</button>
			</div>
			<form className="aw-form" onSubmit={(event) => void submit(event)}>
				{mode === 'register' ? <label>
					<span>Display name</span>
					<input autoComplete="name" required maxLength={80} value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Ada" />
				</label> : null}
				<label>
					<span>Username or email</span>
					<input autoComplete="username" required maxLength={254} value={login} onChange={(event) => setLogin(event.target.value)} placeholder="ada" autoFocus />
				</label>
				<label>
					<span>Password</span>
					<input
						type="password"
						autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
						required
						minLength={mode === 'register' ? 10 : undefined}
						value={password}
						onChange={(event) => setPassword(event.target.value)}
					/>
					{mode === 'register' ? <small>Use at least 10 characters.</small> : null}
				</label>
				{mode === 'register' ? <label>
					<span>Invitation code <em>optional for the first account</em></span>
					<input autoComplete="off" value={invitationToken} onChange={(event) => setInvitationToken(event.target.value)} />
				</label> : null}
				{error ? <div className="aw-error" role="alert">{error}</div> : null}
				<button className="aw-primary-button aw-wide" disabled={submitting}>
					{submitting ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
				</button>
			</form>
		</section>
	</main>
}
