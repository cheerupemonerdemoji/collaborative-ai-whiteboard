import { layoutFingerprint, MEASURED_SHAPE_TYPES, type MeasurementReport } from '../../shared/layout'

/**
 * Reports what this browser measured for text and notes, so the server's layout reads and layout actions can use real
 * sizes instead of estimates. Nothing here is required: with no reporter running (a viewer, a failed request, a browser
 * that never opens the board) the server simply keeps estimating and says so.
 *
 * The reporter never edits the board. It sends sizes only, each bound to a fingerprint of the content that was measured,
 * and the server accepts one only while the shape still has that content.
 */

export interface MeasurableShape {
	id: string
	type: string
	props: Record<string, unknown>
}

export interface ReporterDeps {
	/** Every shape currently in the document. */
	shapes(): MeasurableShape[]
	/** The rendered size of one shape, or null when it cannot be measured now. */
	measure(shape: MeasurableShape): { w: number; h: number } | null
	/** Resolves once the fonts the measurements depend on have loaded. */
	ready(): Promise<unknown>
	send(report: MeasurementReport): Promise<unknown>
	/** Schedules a flush; replaced in tests. Returns a cancel function. */
	schedule?(run: () => void, delayMs: number): () => void
	debounceMs?: number
}

/** The server accepts at most this many measurements in one report. */
export const MAX_REPORT_SIZE = 500
const DEFAULT_DEBOUNCE_MS = 1_500
/** After a failed request, wait this long before trying the same measurements again. */
const RETRY_BACKOFF_MS = 15_000

export interface MeasurementReporter {
	/** Notes that the document changed; a flush follows after the debounce. */
	touch(): void
	/** Measures and sends now, in batches. Resolves when finished. */
	flush(): Promise<void>
	stop(): void
}

export function createMeasurementReporter(deps: ReporterDeps): MeasurementReporter {
	const schedule = deps.schedule ?? ((run, delay) => { const handle = setTimeout(run, delay); return () => clearTimeout(handle) })
	const debounce = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS
	/** What the server already has, by shape id: fingerprint and size. A change in either is sent again. */
	const reported = new Map<string, string>()
	let cancel: (() => void) | null = null
	let stopped = false
	let running: Promise<void> | null = null
	let again = false

	function pending() {
		const measurements: MeasurementReport['measurements'] = []
		const present = new Set<string>()
		for (const shape of deps.shapes()) {
			if (!MEASURED_SHAPE_TYPES.has(shape.type)) continue
			present.add(shape.id)
			const size = deps.measure(shape)
			if (!size || !Number.isFinite(size.w) || !Number.isFinite(size.h) || size.w < 1 || size.h < 1 || size.w > 50_000 || size.h > 50_000) continue
			const fp = layoutFingerprint(shape)
			const w = Math.round(size.w * 100) / 100, h = Math.round(size.h * 100) / 100
			if (reported.get(shape.id) === `${fp}:${w}:${h}`) continue
			measurements.push({ id: shape.id, w, h, fp })
		}
		for (const id of [...reported.keys()]) if (!present.has(id)) reported.delete(id)
		return measurements
	}

	async function run() {
		await deps.ready()
		if (stopped) return
		const measurements = pending()
		for (let start = 0; start < measurements.length && !stopped; start += MAX_REPORT_SIZE) {
			const batch = measurements.slice(start, start + MAX_REPORT_SIZE)
			try {
				await deps.send({ measurements: batch })
				for (const item of batch) reported.set(item.id, `${item.fp}:${item.w}:${item.h}`)
			} catch {
				// Optional by design: try again later rather than surfacing anything to the person drawing.
				if (!stopped) { cancel?.(); cancel = schedule(() => { cancel = null; void flush() }, RETRY_BACKOFF_MS) }
				return
			}
		}
	}

	function flush(): Promise<void> {
		if (running) { again = true; return running }
		running = run().finally(() => {
			running = null
			if (again && !stopped) { again = false; void flush() }
		})
		return running
	}

	return {
		touch() {
			if (stopped) return
			cancel?.()
			cancel = schedule(() => { cancel = null; void flush() }, debounce)
		},
		flush,
		stop() { stopped = true; cancel?.(); cancel = null },
	}
}
