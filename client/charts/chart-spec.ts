import type { ChartDefinition } from '../../shared/chart'

/** Build a Vega-Lite spec from bounded data; an agent never submits an arbitrary spec or URL. */
export function chartToVegaSpec(chart: ChartDefinition, width: number, height: number) {
	const base = { $schema: 'https://vega.github.io/schema/vega-lite/v6.json', width, height, background: '#ffffff',
		config: { view: { stroke: null }, axis: { labelColor: '#24313d', titleColor: '#24313d', gridColor: '#e2e8f0' } } }
	const xTitle = chart.xLabel || undefined
	const yTitle = chart.yLabel || undefined
	if (chart.kind === 'bar') return { ...base, data: { values: chart.data }, mark: { type: 'bar', color: '#2979a7' },
		encoding: { y: { field: 'label', type: 'nominal', sort: null, title: yTitle }, x: { field: 'value', type: 'quantitative', title: xTitle || 'Value' } } }
	if (chart.kind === 'line') return { ...base, data: { values: chart.data }, mark: { type: 'line', color: '#2979a7', point: true },
		encoding: { x: { field: 'label', type: 'ordinal', title: xTitle }, y: { field: 'value', type: 'quantitative', title: yTitle || 'Value', scale: { zero: false } } } }
	if (chart.kind === 'scatter') return { ...base, data: { values: chart.data }, mark: { type: 'point', filled: true, color: '#2979a7', size: 100 },
		encoding: { x: { field: 'x', type: 'quantitative', title: xTitle || 'X' }, y: { field: 'value', type: 'quantitative', title: yTitle || 'Y' },
			tooltip: [{ field: 'label', type: 'nominal' }, { field: 'x', type: 'quantitative' }, { field: 'value', type: 'quantitative' }] } }
	const sorted = [...chart.data].sort((a, b) => b.value - a.value)
	const total = sorted.reduce((sum, item) => sum + item.value, 0)
	let running = 0
	const values = sorted.map((item) => { running += item.value; return { ...item, cumulativePercent: total ? 100 * running / total : 0 } })
	return { ...base, data: { values }, layer: [
		{ mark: { type: 'bar', color: '#2979a7' }, encoding: { x: { field: 'label', type: 'nominal', sort: null, title: xTitle }, y: { field: 'value', type: 'quantitative', title: yTitle || 'Count' } } },
		{ mark: { type: 'line', color: '#d97721', point: true }, encoding: { x: { field: 'label', type: 'nominal', sort: null }, y: { field: 'cumulativePercent', type: 'quantitative', title: 'Cumulative %', scale: { domain: [0, 100] } } } },
	], resolve: { scale: { y: 'independent' } } }
}
