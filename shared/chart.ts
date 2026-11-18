import { T } from '@tldraw/validate'
import { z } from 'zod'

export const CHART_SHAPE_TYPE = 'data-chart' as const
export const CHART_SIZE = { w: 720, h: 500 } as const

export const chartDatumSchema = z.object({
	label: z.string().trim().min(1).max(80),
	value: z.number().finite().min(-1_000_000_000).max(1_000_000_000),
	x: z.number().finite().min(-1_000_000_000).max(1_000_000_000).optional(),
}).strict()

export const chartDefinitionSchema = z.object({
	kind: z.enum(['bar', 'line', 'scatter', 'pareto']),
	title: z.string().trim().min(1).max(120),
	xLabel: z.string().trim().max(80).optional(),
	yLabel: z.string().trim().max(80).optional(),
	source: z.string().trim().min(1).max(240),
	data: z.array(chartDatumSchema).min(1).max(100),
}).strict().superRefine((chart, ctx) => {
	if (chart.kind === 'scatter' && chart.data.some((datum) => datum.x === undefined)) {
		ctx.addIssue({ code: 'custom', message: 'Scatter charts need an x value for every point' })
	}
	if (chart.kind === 'pareto' && chart.data.some((datum) => datum.value < 0)) {
		ctx.addIssue({ code: 'custom', message: 'Pareto counts must be nonnegative' })
	}
})
export type ChartDefinition = z.infer<typeof chartDefinitionSchema>

/** JSON is stored as a string so tldraw validates the CRDT record consistently in browser and server. */
export const chartShapeProps = {
	w: T.number,
	h: T.number,
	definitionJson: T.string,
}
export type ChartShapeProps = { w: number; h: number; definitionJson: string }

export function parseChartDefinition(json: string): ChartDefinition {
	return chartDefinitionSchema.parse(JSON.parse(json))
}
