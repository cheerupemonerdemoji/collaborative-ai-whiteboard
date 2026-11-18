import { compile } from 'vega-lite'
import { parse, View } from 'vega'
import { describe, expect, it } from 'vitest'
import { chartDefinitionSchema } from '../shared/chart'
import { chartToVegaSpec } from '../client/charts/chart-spec'

describe('bounded data charts', () => {
	it.each(['bar', 'line', 'scatter', 'pareto'] as const)('compiles a %s chart without external data', (kind) => {
		const chart = chartDefinitionSchema.parse({ kind, title: 'Trial outcomes', source: 'saved results', data: [
			{ label: 'A', x: 1, value: 8 }, { label: 'B', x: 2, value: 3 },
		] })
		const spec = chartToVegaSpec(chart, 500, 300)
		expect(JSON.stringify(spec)).not.toContain('"url"')
		expect(() => compile(spec as Parameters<typeof compile>[0])).not.toThrow()
	})
	it('rejects raw Vega instructions, remote URLs and oversized data', () => {
		expect(() => chartDefinitionSchema.parse({ kind: 'bar', title: 'Bad', source: 'test', data: [{ label: 'A', value: 1 }], dataUrl: 'https://example.com/private' })).toThrow()
		expect(() => chartDefinitionSchema.parse({ kind: 'scatter', title: 'Bad', source: 'test', data: [{ label: 'A', value: 1 }] })).toThrow()
		expect(() => chartDefinitionSchema.parse({ kind: 'bar', title: 'Bad', source: 'test', data: Array.from({ length: 101 }, (_, i) => ({ label: String(i), value: i })) })).toThrow()
	})
	it('renders a Pareto chart to SVG with bars and a cumulative line', async () => {
		const chart = chartDefinitionSchema.parse({ kind: 'pareto', title: 'Walk endings', source: 'saved runs', data: [
			{ label: 'Wall', value: 3566 }, { label: 'Time', value: 2587 }, { label: 'Aligned', value: 805 },
		] })
		const { spec } = compile(chartToVegaSpec(chart, 500, 300) as Parameters<typeof compile>[0])
		const view = new View(parse(spec), { renderer: 'none' })
		try {
			const svg = await view.toSVG()
			expect(svg).toContain('<svg')
			expect(svg).toContain('Wall')
			expect(svg).toContain('Cumulative %')
		} finally { view.finalize() }
	})
})
