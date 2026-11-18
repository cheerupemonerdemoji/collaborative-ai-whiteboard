import { BaseBoxShapeUtil, HTMLContainer, RecordProps, type Editor, type TLShape, useValue } from 'tldraw'
import {
	approvedCadRevision,
	CAD_CARD_SIZE,
	CAD_REVIEW_SHAPE_TYPE,
	CAD_STATUS_LABELS,
	cadReviewShapeProps,
	cadModelStatus,
	latestCadRevision,
	type CadModel,
	type CadReviewShapeProps,
} from '../../shared/cad-model'
import { cadAssetUrl } from './cad-api'
import './cad-review.css'

declare module '@tldraw/tlschema' {
	export interface TLGlobalShapePropsMap {
		[CAD_REVIEW_SHAPE_TYPE]: CadReviewShapeProps
	}
}

export type CadReviewShape = TLShape<typeof CAD_REVIEW_SHAPE_TYPE>
export const CAD_REVIEW_OPEN_EVENT = 'aw:open-cad-review'

export function requestCadReviewOpen(modelRecordId: string) {
	window.dispatchEvent(new CustomEvent(CAD_REVIEW_OPEN_EVENT, { detail: { modelRecordId } }))
}

export function formatsOf(model: CadModel): string[] {
	const files = latestCadRevision(model).files
	return [files.step ? 'STEP' : null, files.glb ? 'GLB' : null, files.stl ? 'STL' : null].filter((value): value is string => value !== null)
}

/**
 * The canvas card is deliberately cheap: text from the model record and one still image. No WebGL runs on the canvas,
 * so a board full of cards costs nothing until someone opens one. Everything shown comes from the `cad_model`
 * record (which only the server can write), never from the shape, so a card cannot claim a status it does not have.
 */
function CadCard({ shape, editor }: { shape: CadReviewShape; editor: Editor }) {
	const model = useValue('cad model', () => editor.store.get(shape.props.modelRecordId as never) as unknown as CadModel | undefined, [editor, shape.props.modelRecordId])
	const open = () => { if (model) requestCadReviewOpen(model.id) }
	if (!model) {
		return <HTMLContainer className="cad-review-card" style={{ width: shape.props.w, height: shape.props.h }}>
			<div className="cad-card-kicker">CAD review</div>
			<div className="cad-card-heading"><div><strong>Model unavailable</strong><span>This card points at a CAD model that is not on the board.</span></div></div>
		</HTMLContainer>
	}
	const latest = latestCadRevision(model)
	const approved = approvedCadRevision(model)
	const status = cadModelStatus(model)
	const thumbnail = latest.thumbnail ? cadAssetUrl(latest.thumbnail.assetId) : null
	return <HTMLContainer className="cad-review-card" style={{ width: shape.props.w, height: shape.props.h }}>
		<div className="cad-card-kicker">CAD review</div>
		<div className="cad-card-heading">
			<div><strong>{model.name}</strong><span>{model.modelId}</span></div>
			<span className={`cad-status cad-status-${status}`}>{CAD_STATUS_LABELS[status]}</span>
		</div>
		<div className="cad-card-preview">
			{thumbnail ? <img src={thumbnail} alt="" draggable={false} loading="lazy" /> : <span>No thumbnail</span>}
		</div>
		<div className="cad-card-meta">
			<span>Rev <b>{latest.number}</b></span>
			<span>{model.units}</span>
			<span>{formatsOf(model).join(' · ')}</span>
			{latest.assembly ? <span title="This revision lists parts. It is not checked against a STEP file.">Assembly · {latest.assembly.parts.length} nodes</span> : null}
			{approved && approved.id !== latest.id ? <span title="A later revision is not approved yet">Rev {approved.number} approved</span> : null}
		</div>
		<button
			type="button"
			className="cad-card-open"
			onPointerDown={(event) => event.stopPropagation()}
			onClick={(event) => { event.stopPropagation(); open() }}
		>
			Open 3D review
		</button>
	</HTMLContainer>
}

export class CadReviewShapeUtil extends BaseBoxShapeUtil<CadReviewShape> {
	static override type = CAD_REVIEW_SHAPE_TYPE
	static override props: RecordProps<CadReviewShape> = cadReviewShapeProps

	override getDefaultProps(): CadReviewShape['props'] {
		return { ...CAD_CARD_SIZE, modelRecordId: 'cad_model:000000000000' }
	}

	override canEdit() { return false }

	/** tldraw's select tool owns the pointer on a shape, so the double-click arrives here and not as a DOM event on the card. */
	override onDoubleClick(shape: CadReviewShape) {
		requestCadReviewOpen(shape.props.modelRecordId)
	}
	override canBind() { return true }

	override component(shape: CadReviewShape) {
		return <CadCard shape={shape} editor={this.editor} />
	}

	override getIndicatorPath(shape: CadReviewShape) {
		const path = new Path2D()
		path.roundRect(0, 0, shape.props.w, shape.props.h, 16)
		return path
	}

	override getText(shape: CadReviewShape) {
		const model = this.editor.store.get(shape.props.modelRecordId as never) as unknown as CadModel | undefined
		return model ? `${model.name} ${model.modelId} ${CAD_STATUS_LABELS[cadModelStatus(model)]}` : ''
	}
}

export const cadReviewShapeUtils = [CadReviewShapeUtil]
