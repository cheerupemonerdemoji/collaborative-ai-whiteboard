/**
 * The browser-side measurement reporter, with the editor replaced by plain functions: what it measures, what it sends, what
 * it never sends again, and that a failure is silent and retried rather than spamming the server or the person drawing.
 */

import { describe, expect, it } from 'vitest'
import { layoutFingerprint, type MeasurementReport } from '../shared/layout'
import { createMeasurementReporter, MAX_REPORT_SIZE, type MeasurableShape } from '../client/layout/measurement-reporter'

const text = (id: string, content = 'hello'): MeasurableShape => ({ id: `shape:${id}`, type: 'text', props: { richText: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: content }] }] }, size: 'm', font: 'draw', scale: 1, autoSize: true, w: 200 } })
const geo = (id: string): MeasurableShape => ({ id: `shape:${id}`, type: 'geo', props: { w: 100, h: 100 } })

function harness(initial: MeasurableShape[], options: { fail?: () => boolean; size?: (shape: MeasurableShape) => { w: number; h: number } | null } = {}) {
	const state = { shapes: initial, sent: [] as MeasurementReport[], timers: [] as Array<{ run: () => void; delay: number; cancelled: boolean }> }
	const reporter = createMeasurementReporter({
		shapes: () => state.shapes,
		measure: options.size ?? (() => ({ w: 123.456, h: 45.678 })),
		ready: async () => undefined,
		send: async (report) => { if (options.fail?.()) throw new Error('offline'); state.sent.push(report) },
		schedule: (run, delay) => { const timer = { run, delay, cancelled: false }; state.timers.push(timer); return () => { timer.cancelled = true } },
	})
	const fire = async () => { const live = state.timers.filter((timer) => !timer.cancelled); state.timers = []; for (const timer of live) timer.run(); await reporter.flush() }
	return { state, reporter, fire }
}

describe('measurement reporter', () => {
	it('sends text and note sizes bound to the content fingerprint, rounded, and nothing for other shapes', async () => {
		const { state, reporter } = harness([text('t'), geo('g'), { id: 'shape:n', type: 'note', props: { richText: { type: 'doc', content: [] }, size: 'm', font: 'draw', scale: 1 } }])
		await reporter.flush()
		expect(state.sent).toHaveLength(1)
		expect(state.sent[0].measurements).toEqual([
			{ id: 'shape:t', w: 123.46, h: 45.68, fp: layoutFingerprint(text('t')) },
			{ id: 'shape:n', w: 123.46, h: 45.68, fp: layoutFingerprint({ type: 'note', props: { richText: { type: 'doc', content: [] }, size: 'm', font: 'draw', scale: 1 } }) },
		])
	})

	it('does not resend what the server already has, but does when the content or the size changes', async () => {
		let height = 40
		const { state, reporter } = harness([text('t')], { size: () => ({ w: 100, h: height }) })
		await reporter.flush()
		await reporter.flush()
		expect(state.sent).toHaveLength(1)
		state.shapes = [text('t', 'edited text')]
		await reporter.flush()
		expect(state.sent).toHaveLength(2)
		height = 80
		await reporter.flush()
		expect(state.sent).toHaveLength(3)
	})

	it('skips shapes it cannot measure sensibly rather than reporting a guess', async () => {
		const sizes: Record<string, { w: number; h: number } | null> = { 'shape:a': null, 'shape:b': { w: 0, h: 10 }, 'shape:c': { w: Number.NaN, h: 10 }, 'shape:d': { w: 10, h: 1e9 }, 'shape:e': { w: 10, h: 10 } }
		const { state, reporter } = harness(['a', 'b', 'c', 'd', 'e'].map((id) => text(id)), { size: (shape) => sizes[shape.id] })
		await reporter.flush()
		expect(state.sent[0].measurements.map((m) => m.id)).toEqual(['shape:e'])
	})

	it('sends nothing at all when there is nothing new to say', async () => {
		const { state, reporter } = harness([geo('g')])
		await reporter.flush()
		expect(state.sent).toEqual([])
	})

	it('batches to the size the server accepts', async () => {
		const many = Array.from({ length: MAX_REPORT_SIZE + 25 }, (_, i) => text(`t${i}`, `text ${i}`))
		const { state, reporter } = harness(many)
		await reporter.flush()
		expect(state.sent.map((report) => report.measurements.length)).toEqual([MAX_REPORT_SIZE, 25])
	})

	it('debounces: many changes in a row are one scheduled flush', async () => {
		const { state, reporter, fire } = harness([text('t')])
		for (let i = 0; i < 10; i += 1) reporter.touch()
		expect(state.timers.filter((timer) => !timer.cancelled)).toHaveLength(1)
		await fire()
		expect(state.sent).toHaveLength(1)
	})

	it('a failed request is silent, is retried later with a backoff, and succeeds when the network does', async () => {
		let offline = true
		const { state, reporter, fire } = harness([text('t')], { fail: () => offline })
		await expect(reporter.flush()).resolves.toBeUndefined()
		expect(state.sent).toEqual([])
		const retry = state.timers.filter((timer) => !timer.cancelled)
		expect(retry).toHaveLength(1)
		expect(retry[0].delay).toBeGreaterThanOrEqual(10_000)
		offline = false
		await fire()
		expect(state.sent).toHaveLength(1)
	})

	it('forgets deleted shapes, so a recreated one with the same id is reported again', async () => {
		const { state, reporter } = harness([text('t')])
		await reporter.flush()
		state.shapes = []
		await reporter.flush()
		state.shapes = [text('t')]
		await reporter.flush()
		expect(state.sent).toHaveLength(2)
	})

	it('stops cleanly: nothing is sent or scheduled after stop()', async () => {
		const { state, reporter, fire } = harness([text('t')])
		reporter.touch()
		reporter.stop()
		reporter.touch()
		await fire()
		expect(state.sent).toEqual([])
	})
})
