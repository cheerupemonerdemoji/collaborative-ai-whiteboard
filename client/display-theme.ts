export type DisplayTheme = 'dark' | 'light'

export const DISPLAY_THEME_STORAGE_KEY = 'aw-display-theme'
export const DEFAULT_DISPLAY_THEME: DisplayTheme = 'dark'

type ThemeStorage = Pick<Storage, 'getItem' | 'setItem'>

export function parseDisplayTheme(value: string | null | undefined): DisplayTheme | null {
	return value === 'dark' || value === 'light' ? value : null
}

function browserStorage(): ThemeStorage | null {
	return typeof window === 'undefined' ? null : window.localStorage
}

export function loadDisplayTheme(storage: ThemeStorage | null = browserStorage()): DisplayTheme {
	try {
		return parseDisplayTheme(storage?.getItem(DISPLAY_THEME_STORAGE_KEY)) ?? DEFAULT_DISPLAY_THEME
	} catch {
		return DEFAULT_DISPLAY_THEME
	}
}

export function saveDisplayTheme(theme: DisplayTheme, storage: ThemeStorage | null = browserStorage()): void {
	try {
		storage?.setItem(DISPLAY_THEME_STORAGE_KEY, theme)
	} catch {
		// A blocked or full localStorage should never prevent someone from using the board.
	}
}
