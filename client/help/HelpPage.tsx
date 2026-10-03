import { useContext, useEffect, useRef } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'
import { AuthContext } from '../auth'
import { findGuidePage, GUIDE_PAGES, guidePath, guideSource } from './guide'
import { Markdown } from './markdown'
import './help.css'

/** The "Help" entry shown in the application's navigation. */
export function HelpLink({ className = '' }: { className?: string }) {
	return <Link to="/help" className={`aw-help-link ${className}`.trim()}>Help</Link>
}

/**
 * The user guide. It is a public page: it contains only product documentation (bundled into the
 * client), makes no API calls of its own, and works whether or not the visitor is signed in.
 */
export function HelpPage() {
	const { slug, '*': unmatched } = useParams()
	const location = useLocation()
	const auth = useContext(AuthContext)
	const articleRef = useRef<HTMLElement>(null)
	const page = unmatched ? undefined : findGuidePage(slug)
	const index = page ? GUIDE_PAGES.indexOf(page) : -1
	const previous = index > 0 ? GUIDE_PAGES[index - 1] : undefined
	const next = index >= 0 && index < GUIDE_PAGES.length - 1 ? GUIDE_PAGES[index + 1] : undefined
	const source = page ? guideSource(page) : ''

	useEffect(() => {
		document.title = page ? `${page.slug ? `${page.label} · ` : ''}User Guide · Collaborative AI Canvas` : 'Page not found · User Guide'
	}, [page])

	useEffect(() => {
		if (location.hash) {
			const target = document.getElementById(decodeURIComponent(location.hash.slice(1)))
			if (target) { target.scrollIntoView(); return }
		}
		window.scrollTo(0, 0)
		articleRef.current?.querySelector<HTMLElement>('h1')?.setAttribute('tabindex', '-1')
		articleRef.current?.querySelector<HTMLElement>('h1')?.focus({ preventScroll: true })
	}, [slug, location.hash])

	const signedIn = Boolean(auth?.user)

	return <div className="aw-help">
		<header className="aw-help-header">
			<Link to="/help" className="aw-help-brand"><span className="aw-brand-mark" aria-hidden="true">✦</span>Collaborative AI Canvas <span className="aw-help-brand-sub">User Guide</span></Link>
			<nav aria-label="Application" className="aw-help-appnav">
				{signedIn ? <Link to="/boards">Your whiteboards</Link> : <Link to="/login">Sign in</Link>}
			</nav>
		</header>
		<div className="aw-help-body">
			<nav className="aw-help-toc" aria-label="User guide contents">
				<h2>User Guide</h2>
				<ol>
					{GUIDE_PAGES.map((entry) => <li key={entry.file}>
						<Link to={guidePath(entry)} aria-current={entry === page ? 'page' : undefined} className={entry === page ? 'active' : undefined}>{entry.label}</Link>
					</li>)}
				</ol>
			</nav>
			<main className="aw-help-main" id="help-content">
				{page ? <>
					<article className="aw-help-article" ref={articleRef}><Markdown source={source} /></article>
					<nav className="aw-help-pager" aria-label="Previous and next guide">
						{previous ? <Link to={guidePath(previous)} rel="prev"><small>Previous</small><span>← {previous.label}</span></Link> : <span />}
						{next ? <Link to={guidePath(next)} rel="next"><small>Next</small><span>{next.label} →</span></Link> : <span />}
					</nav>
				</> : <article className="aw-help-article" ref={articleRef}>
					<h1>Page not found</h1>
					<p>There is no such page in the user guide.</p>
					<p><Link to="/help">Go to the User Guide home page</Link></p>
				</article>}
			</main>
		</div>
	</div>
}
