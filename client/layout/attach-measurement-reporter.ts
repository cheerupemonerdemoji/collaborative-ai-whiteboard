import type { Editor } from 'tldraw'
import { apiRequest } from '../auth'
import { createMeasurementReporter, type MeasurableShape } from './measurement-reporter'

/**
 * Starts reporting this editor's text and note sizes to the server for as long as the editor is mounted. Only call it
 * for people who may edit the board; the server refuses everyone else. Returns the function that stops it.
 */
export function attachMeasurementReporter(editor: Editor, boardId: string): () => void {
	const reporter = createMeasurementReporter({
		shapes: () => editor.store.allRecords().filter((record) => record.typeName === 'shape') as unknown as MeasurableShape[],
		measure: (shape) => {
			try {
				const bounds = editor.getShapeGeometry(shape.id as never).bounds
				return { w: bounds.w, h: bounds.h }
			} catch {
				return null
			}
		},
		// Sizes taken before the fonts load are wrong, and a wrong measurement is worse than an estimate.
		ready: async () => {
			try { await editor.fonts.loadRequiredFontsForCurrentPage() } catch { /* measure with whatever loaded */ }
			await document.fonts.ready
		},
		send: (report) => apiRequest(`/api/boards/${encodeURIComponent(boardId)}/layout-measurements`, { method: 'POST', body: JSON.stringify(report) }),
	})
	const stopListening = editor.store.listen(() => reporter.touch(), { source: 'all', scope: 'document' })
	reporter.touch()
	return () => { stopListening(); reporter.stop() }
}
