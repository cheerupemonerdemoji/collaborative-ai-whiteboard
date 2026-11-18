import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// The board top bar is laid out by CSS that no unit test can render, so these check the source for the two rules that
// were found broken in a real browser: the shell column outgrowing the screen, and Help stranded on a row of its own.
const read = (...parts: string[]) => readFileSync(join(__dirname, '..', ...parts), 'utf8')

describe('board top bar layout', () => {
	it('pins the shell to one viewport-wide column, so a long room name cannot push the bar off a narrow screen', () => {
		const css = read('client', 'index.css')
		const shell = css.match(/^\.app-shell \{([^}]*)\}/m)
		expect(shell, '.app-shell rule').not.toBeNull()
		expect(shell![1]).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/)
		const roomName = css.match(/^\.room-name \{([^}]*)\}/m)
		expect(roomName, '.room-name rule').not.toBeNull()
		expect(roomName![1]).toMatch(/min-width:\s*0\b/)
		expect(roomName![1]).toMatch(/text-overflow:\s*ellipsis/)
	})

	it('keeps the display toggle, Help and the account menu in one group that wraps as a unit', () => {
		const room = read('client', 'pages', 'Room.tsx')
		const group = room.match(/<div className="aw-topbar-end">([\s\S]*?)<\/header>/)
		expect(group, 'the aw-topbar-end group').not.toBeNull()
		const body = group![1]
		expect(body).toContain('toggleDisplayTheme')
		expect(body).toContain('<HelpLink />')
		expect(body).toContain('className="aw-user-menu"')
		const css = read('client', 'index.css')
		expect(css).toMatch(/^\.topbar \.aw-topbar-end \{[^}]*margin-left:\s*auto/m)
	})
})
