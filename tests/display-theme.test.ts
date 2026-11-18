import { describe, expect, it } from 'vitest'
import {
	DEFAULT_DISPLAY_THEME,
	DISPLAY_THEME_STORAGE_KEY,
	loadDisplayTheme,
	parseDisplayTheme,
	saveDisplayTheme,
} from '../client/display-theme'

function memoryStorage(initial?: string) {
	let value = initial ?? null
	return {
		getItem: (key: string) => key === DISPLAY_THEME_STORAGE_KEY ? value : null,
		setItem: (key: string, next: string) => { if (key === DISPLAY_THEME_STORAGE_KEY) value = next },
		value: () => value,
	}
}

describe('whiteboard display theme', () => {
	it('defaults to dark when no valid preference exists', () => {
		expect(DEFAULT_DISPLAY_THEME).toBe('dark')
		expect(loadDisplayTheme(memoryStorage())).toBe('dark')
		expect(loadDisplayTheme(memoryStorage('system'))).toBe('dark')
	})

	it('recognizes only the supported display values', () => {
		expect(parseDisplayTheme('dark')).toBe('dark')
		expect(parseDisplayTheme('light')).toBe('light')
		expect(parseDisplayTheme('')).toBeNull()
		expect(parseDisplayTheme('system')).toBeNull()
	})

	it('persists a browser-local light or dark preference', () => {
		const storage = memoryStorage()
		saveDisplayTheme('light', storage)
		expect(storage.value()).toBe('light')
		expect(loadDisplayTheme(storage)).toBe('light')
		saveDisplayTheme('dark', storage)
		expect(loadDisplayTheme(storage)).toBe('dark')
	})

	it('keeps the dark default when browser storage is unavailable', () => {
		const blockedStorage = {
			getItem: () => { throw new Error('blocked') },
			setItem: () => { throw new Error('blocked') },
		}
		expect(loadDisplayTheme(blockedStorage)).toBe('dark')
		expect(() => saveDisplayTheme('light', blockedStorage)).not.toThrow()
	})
})
