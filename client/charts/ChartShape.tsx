import { useEffect, useRef, useState } from 'react'
import { BaseBoxShapeUtil, HTMLContainer, type TLShape } from 'tldraw'
import { CHART_SHAPE_TYPE, CHART_SIZE, chartShapeProps, parseChartDefinition, type ChartShapeProps } from '../../shared/chart'
import { chartToVegaSpec } from './chart-spec'
import './chart-shape.css'

declare module '@tldraw/tlschema' {
	export interface TLGlobalShapePropsMap { [CHART_SHAPE_TYPE]: ChartShapeProps }
}
export type ChartShape = TLShape<typeof CHART_SHAPE_TYPE>

function ChartView({ shape }: { shape: ChartShape }) {
	const hostRef = useRef<HTMLDivElement>(null)
	const [error, setError] = useState('')
	let chart
	try { chart = parseChartDefinition(shape.props.definitionJson) } catch { chart = null }
	const title = chart?.title ?? 'Invalid chart'
	const source = chart?.source ?? 'Chart data could not be read'
	useEffect(() => {
		if (!chart || !hostRef.current) return
		let active = true
		let view: { finalize: () => void } | undefined
		const host = hostRef.current
		setError('')
		void import('vega-embed').then(({ default: embed }) => {
			if (!active) return
			return embed(host, chartToVegaSpec(chart, Math.max(150, shape.props.w - 100), Math.max(100, shape.props.h - 145)) as Parameters<typeof embed>[1], { actions: false, renderer: 'svg', tooltip: false })
		}).then((result) => {
			if (!result) return
			if (!active) result.view.finalize()
			else view = result.view
		}).catch(() => { if (active) setError('Chart could not be rendered') })
		return () => { active = false; view?.finalize(); host.replaceChildren() }
	}, [shape.props.definitionJson, shape.props.w, shape.props.h])
	return <HTMLContainer className="aw-chart-shape" style={{ width: shape.props.w, height: shape.props.h }}>
		<strong className="aw-chart-title">{title}</strong>
		<div className="aw-chart-host" ref={hostRef} aria-label={title} />
		{error ? <div className="aw-chart-error" role="alert">{error}</div> : null}
		<small className="aw-chart-source">Source: {source}</small>
	</HTMLContainer>
}

export class ChartShapeUtil extends BaseBoxShapeUtil<ChartShape> {
	static override type = CHART_SHAPE_TYPE
	static override props = chartShapeProps
	override getDefaultProps(): ChartShape['props'] { return { ...CHART_SIZE, definitionJson: JSON.stringify({ kind: 'bar', title: 'Chart', source: 'Unspecified', data: [{ label: 'A', value: 1 }] }) } }
	override canEdit() { return false }
	override canBind() { return true }
	override component(shape: ChartShape) { return <ChartView shape={shape} /> }
	override getIndicatorPath(shape: ChartShape) {
		const path = new Path2D()
		path.roundRect(0, 0, shape.props.w, shape.props.h, 12)
		return path
	}
	override getText(shape: ChartShape) { try { return parseChartDefinition(shape.props.definitionJson).title } catch { return 'Invalid chart' } }
}
export const chartShapeUtils = [ChartShapeUtil]
