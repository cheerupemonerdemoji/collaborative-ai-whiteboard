import { useEffect, useMemo, useState } from 'react'
import { useValue, type Editor } from 'tldraw'
import {
	approvedCadRevision,
	CAD_STATUS_LABELS,
	CAD_TRANSITIONS,
	cadModelStatus,
	latestCadRevision,
	type CadModel,
	type CadRevision,
	type CadStatus,
} from '../../shared/cad-model'
import { addCadModelComment, addCadModelEvidence, cadAssetUrl, setCadStatus } from './cad-api'
import { CadAssemblySection } from './CadAssemblySection'
import { CadUploadDialog } from './CadUploadDialog'
import { CadViewer } from './CadViewer'
import type { AlternativeGroups } from './explode-layout'

interface CadReviewPanelProps {
	editor: Editor
	modelRecordId: string
	canEdit: boolean
	onClose: () => void
}

const STATUS_ACTIONS: Record<CadStatus, Array<{ to: CadStatus; label: string; primary?: boolean }>> = {
	draft: [{ to: 'in-review', label: 'Submit for review', primary: true }],
	'in-review': [{ to: 'approved', label: 'Approve', primary: true }, { to: 'rejected', label: 'Reject' }, { to: 'draft', label: 'Back to draft' }],
	rejected: [{ to: 'draft', label: 'Return to draft' }],
	approved: [],
}

const when = (value: number) => new Date(value).toLocaleString()
const kilobytes = (bytes: number) => (bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1_000))} KB`)

export function CadReviewPanel({ editor, modelRecordId, canEdit, onClose }: CadReviewPanelProps) {
	const model = useValue('cad model', () => editor.store.get(modelRecordId as never) as unknown as CadModel | undefined, [editor, modelRecordId])
	const entities = useValue('cad entities', () => editor.store.allRecords().filter((record) => (record.typeName as string) === 'engineering_entity') as unknown as Array<{ id: string; title: string; entityType: string }>, [editor])
	const [selectedId, setSelectedId] = useState<string | null>(null)
	const [comment, setComment] = useState('')
	const [decisionNote, setDecisionNote] = useState('')
	const [evidenceKind, setEvidenceKind] = useState<'note' | 'entity'>('note')
	const [evidenceLabel, setEvidenceLabel] = useState('')
	const [evidenceEntity, setEvidenceEntity] = useState('')
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [uploadOpen, setUploadOpen] = useState(false)
	// Review-only view state for an assembly. It lives in this panel and is never saved anywhere.
	const [partKey, setPartKey] = useState<string | null>(null)
	const [hiddenParts, setHiddenParts] = useState<ReadonlySet<string>>(() => new Set())
	const [explosion, setExplosion] = useState(0)
	// Groups the file puts in the same place, reported by the viewer once it has loaded the geometry. Display only.
	const [alternatives, setAlternatives] = useState<readonly AlternativeGroups[]>([])

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !uploadOpen) onClose() }
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [onClose, uploadOpen])

	const revision: CadRevision | undefined = useMemo(() => {
		if (!model) return undefined
		return model.revisions.find((item) => item.id === selectedId) ?? latestCadRevision(model)
	}, [model, selectedId])

	const shownRevisionId = revision?.id
	useEffect(() => { setPartKey(null); setHiddenParts(new Set()); setExplosion(0) }, [shownRevisionId])

	if (!model || !revision) {
		return <div className="cad-panel-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
			<section className="cad-review-panel cad-panel-missing" role="dialog" aria-modal="true" aria-label="CAD review">
				<p>This CAD model is no longer on the board.</p>
				<button type="button" onClick={onClose}>Close</button>
			</section>
		</div>
	}

	const latest = latestCadRevision(model)
	const isLatest = revision.id === latest.id
	const status = cadModelStatus(model)
	const approved = approvedCadRevision(model)
	const previewFile = revision.files.glb ?? revision.files.stl
	const previewFormat = revision.files.glb ? 'glb' : 'stl'
	const previewUrl = previewFile ? cadAssetUrl(previewFile.assetId) : null
	const comments = model.comments.filter((item) => item.revisionId === revision.id)
	const actions = canEdit && isLatest ? STATUS_ACTIONS[revision.status] : []

	async function run(task: () => Promise<unknown>, after?: () => void) {
		setBusy(true)
		setError(null)
		try { await task(); after?.() }
		catch (caught) { setError(caught instanceof Error ? caught.message : 'That did not work.') }
		finally { setBusy(false) }
	}

	function files(rev: CadRevision) {
		return ([['STEP source', rev.files.step], ['GLB preview', rev.files.glb], ['STL preview', rev.files.stl]] as const)
			.flatMap(([label, file]) => (file ? [{ label, file, url: cadAssetUrl(file.assetId) }] : []))
	}

	return <div className="cad-panel-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
		<section className="cad-review-panel" role="dialog" aria-modal="true" aria-label={`CAD review: ${model.name}`}>
			<header className="cad-panel-header">
				<div><span>CAD review workspace</span><h2>{model.name}</h2><p>{model.modelId} · Revision {revision.number} of {latest.number} · {model.units}</p></div>
				<div className="cad-panel-actions">
					<span className={`cad-status cad-status-${status}`}>{CAD_STATUS_LABELS[status]}</span>
					<button type="button" onClick={onClose} aria-label="Close CAD review">Close</button>
				</div>
			</header>
			<div className="cad-panel-layout">
				<div className="cad-panel-stage">
					{previewUrl ? <CadViewer key={previewFile!.assetId} url={previewUrl} format={previewFormat} units={model.units} label={`${model.name} revision ${revision.number}`} parts={previewFormat === 'glb' ? revision.assembly?.parts : undefined} explodeGroups={previewFormat === 'glb' ? revision.assembly?.explode : undefined} selectedKey={partKey} hiddenKeys={hiddenParts} explosion={explosion} onPick={setPartKey} onAlternatives={setAlternatives} /> : <p className="cad-empty">This revision has no preview.</p>}
				</div>
				<aside className="cad-panel-sidebar">
					{error ? <p className="cad-error" role="alert">{error}</p> : null}
					<section>
						<h3>Model</h3>
						<label>Revision<select value={revision.id} onChange={(event) => setSelectedId(event.target.value)}>
							{[...model.revisions].reverse().map((item) => <option key={item.id} value={item.id}>Rev {item.number} — {CAD_STATUS_LABELS[item.status]}{item.id === latest.id ? ' (latest)' : ''}</option>)}
						</select></label>
						<dl className="cad-meta-list">
							<div><dt>Name</dt><dd>{model.name}</dd></div>
							<div><dt>Model ID</dt><dd>{model.modelId}</dd></div>
							<div><dt>Units</dt><dd>{model.units}</dd></div>
							<div><dt>Added</dt><dd>{when(revision.createdAt)} by {revision.createdBy.displayName}{revision.createdBy.source === 'ai' ? ' (AI)' : ''}</dd></div>
							{revision.changeNote ? <div><dt>Note</dt><dd>{revision.changeNote}</dd></div> : null}
							{files(revision).map(({ label, file, url }) => <div key={label}><dt>{label}</dt><dd>{url ? <a href={url} download={file.name}>{file.name}</a> : file.name} · {kilobytes(file.bytes)}<small title={file.sha256}> · {file.sha256.slice(0, 10)}…</small></dd></div>)}
						</dl>
						<p className="cad-caution">STEP is the manufacturing source. The {previewFormat.toUpperCase()} is a browser preview only: verify every dimension against the STEP file and the physical part before fabrication.</p>
					</section>
					{revision.assembly ? <CadAssemblySection model={model} revision={revision} editor={editor} canEdit={canEdit} selectedKey={partKey} onSelect={setPartKey} hidden={hiddenParts} onHidden={setHiddenParts} explosion={explosion} onExplosion={setExplosion} alternatives={alternatives} busy={busy} run={run} /> : null}
					<section>
						<h3>Review</h3>
						<p><span className={`cad-status cad-status-${revision.status}`}>{CAD_STATUS_LABELS[revision.status]}</span></p>
						{revision.decision ? <p className="cad-muted">{revision.status === 'approved' ? 'Approved' : 'Rejected'} by {revision.decision.by.displayName} on {when(revision.decision.at)}{revision.decision.note ? `: ${revision.decision.note}` : ''}</p> : null}
						{revision.assembly ? <p className="cad-muted">This is the status of the assembly revision. Its linked components keep their own status, and a decision here does not change them.</p> : null}
						{!isLatest ? <p className="cad-muted">Only the newest revision can change review status.</p> : null}
						{revision.status === 'approved' && isLatest ? <p className="cad-muted">Approved revisions are final. Add a new revision to change the model; it will need its own approval.</p> : null}
						{approved && approved.id !== latest.id ? <p className="cad-muted">Revision {approved.number} is the latest approved revision. Revision {latest.number} is {CAD_STATUS_LABELS[latest.status].toLowerCase()}.</p> : null}
						{actions.length ? <>
							{actions.some((action) => action.to === 'approved' || action.to === 'rejected') ? <label>Decision note (optional)<textarea value={decisionNote} onChange={(event) => setDecisionNote(event.target.value)} maxLength={1000} /></label> : null}
							<div className="cad-approval-actions">
								{actions.map((action) => <button key={action.to} type="button" className={action.primary ? 'cad-primary' : undefined} disabled={busy || !CAD_TRANSITIONS[revision.status].includes(action.to)}
									onClick={() => void run(() => setCadStatus(model.id, revision.id, action.to, decisionNote), () => setDecisionNote(''))}>{action.label}</button>)}
							</div>
						</> : null}
						{canEdit ? <button type="button" disabled={busy} onClick={() => setUploadOpen(true)}>Add a new revision…</button> : <p className="cad-muted">You have view-only access to this board.</p>}
					</section>
					<section>
						<h3>Comments on revision {revision.number}</h3>
						{comments.length ? <ul className="cad-comment-list">{comments.map((item) => <li key={item.id}><strong>{item.author.displayName}</strong><span>{item.body}</span><time>{when(item.createdAt)}</time></li>)}</ul> : <p className="cad-empty">No comments on this revision.</p>}
						{canEdit ? <><label>Comment<textarea value={comment} onChange={(event) => setComment(event.target.value)} maxLength={2000} placeholder="Record a measurement, a concern or a condition for approval" /></label>
							<button type="button" disabled={busy || !comment.trim()} onClick={() => void run(() => addCadModelComment(model.id, revision.id, comment.trim()), () => setComment(''))}>Add comment</button></> : null}
					</section>
					<section>
						<h3>Linked evidence</h3>
						{model.evidence.length ? <ul className="cad-note-list">{model.evidence.map((item) => <li key={item.id}>
							{item.kind === 'entity' ? <b>{entities.find((entity) => entity.id === item.ref)?.title ?? 'Engineering entity'}: </b> : null}{item.label}
							<small> — {item.addedBy.displayName}</small></li>)}</ul> : <p className="cad-empty">No evidence linked yet.</p>}
						{canEdit ? <>
							<label>Add<select value={evidenceKind} onChange={(event) => setEvidenceKind(event.target.value as 'note' | 'entity')}><option value="note">A note or measurement</option><option value="entity" disabled={!entities.length}>An engineering entity on this board</option></select></label>
							{evidenceKind === 'entity' ? <label>Entity<select value={evidenceEntity} onChange={(event) => setEvidenceEntity(event.target.value)}><option value="">Choose…</option>{entities.map((entity) => <option key={entity.id} value={entity.id}>{entity.title} ({entity.entityType})</option>)}</select></label> : null}
							<label>Description<input value={evidenceLabel} onChange={(event) => setEvidenceLabel(event.target.value)} maxLength={200} /></label>
							<button type="button" disabled={busy || !evidenceLabel.trim() || (evidenceKind === 'entity' && !evidenceEntity)}
								onClick={() => void run(() => addCadModelEvidence(model.id, { kind: evidenceKind, label: evidenceLabel.trim(), ...(evidenceKind === 'entity' ? { ref: evidenceEntity } : {}) }), () => { setEvidenceLabel(''); setEvidenceEntity('') })}>Link evidence</button>
						</> : null}
					</section>
				</aside>
			</div>
			{uploadOpen ? <CadUploadDialog mode="revision" modelRecordId={model.id} onCancel={() => setUploadOpen(false)} onDone={(updated) => { setUploadOpen(false); setSelectedId(latestCadRevision(updated).id) }} /> : null}
		</section>
	</div>
}
