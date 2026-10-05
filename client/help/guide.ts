/**
 * The user guide's content and page order. The Markdown files in docs/user-guide/ are the single
 * source of truth: they are bundled into the client at build time (`?raw`), so the in-app Help
 * pages and the repository documentation can never drift apart.
 */
const sources = import.meta.glob('../../docs/user-guide/*.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>

export interface GuidePage {
	/** URL segment: /help/<slug>. The home page has an empty slug and lives at /help. */
	slug: string
	/** Source file name inside docs/user-guide/. */
	file: string
	/** Short label for the contents list. */
	label: string
}

export const GUIDE_PAGES: readonly GuidePage[] = [
	{ slug: '', file: 'README.md', label: 'Overview' },
	{ slug: 'quick-start', file: 'quick-start.md', label: 'Quick Start' },
	{ slug: 'canvas-basics', file: 'canvas-basics.md', label: 'Canvas Basics' },
	{ slug: 'semantic-inspector', file: 'semantic-inspector.md', label: 'Semantic Inspector' },
	{ slug: 'structured-evidence', file: 'structured-evidence.md', label: 'Structured Evidence' },
	{ slug: 'history-and-restore', file: 'history-and-restore.md', label: 'History & Restore' },
	{ slug: 'roles-and-sharing', file: 'roles-and-sharing.md', label: 'Roles & Sharing' },
	{ slug: 'engineering-workflow-example', file: 'engineering-workflow-example.md', label: 'Example: Engineering Workflow' },
	{ slug: 'agent-api', file: 'agent-api.md', label: 'Agent API' },
	{ slug: 'troubleshooting', file: 'troubleshooting.md', label: 'Troubleshooting & FAQ' },
]

export function guidePath(page: GuidePage): string {
	return page.slug ? `/help/${page.slug}` : '/help'
}

export function findGuidePage(slug: string | undefined): GuidePage | undefined {
	const wanted = slug ?? ''
	return GUIDE_PAGES.find((page) => page.slug === wanted)
}

export function guideSource(page: GuidePage): string {
	const entry = Object.entries(sources).find(([path]) => path.endsWith(`/${page.file}`))
	return entry ? entry[1] : ''
}

/** Maps a relative guide link such as `quick-start.md#step` to its in-app route, or null if it is not a guide page. */
export function resolveGuideLink(href: string): string | null {
	const match = /^([A-Za-z0-9._-]+\.md)(#[A-Za-z0-9_-]+)?$/.exec(href)
	if (!match) return null
	const page = GUIDE_PAGES.find((candidate) => candidate.file === match[1])
	if (!page) return null
	return `${guidePath(page)}${match[2] ?? ''}`
}
