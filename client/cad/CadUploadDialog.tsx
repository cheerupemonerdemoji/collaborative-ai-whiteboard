import { useState, type FormEvent } from 'react'
import { CAD_LIMITS, CAD_UNITS, type CadModel, type CadUnits } from '../../shared/cad-model'
import { submitCad } from './cad-api'
import './cad-review.css'

interface CadUploadDialogProps {
	mode: 'model' | 'revision'
	/** Required when mode is `revision`. */
	modelRecordId?: string
	onDone: (model: CadModel) => void
	onCancel: () => void
}

const extensionOf = (name: string) => name.slice(name.lastIndexOf('.') + 1).toLowerCase()

/** New model or new revision: the same two files and the same note, so there is one form for both. */
export function CadUploadDialog({ mode, modelRecordId, onDone, onCancel }: CadUploadDialogProps) {
	const [name, setName] = useState('')
	const [modelId, setModelId] = useState('')
	const [units, setUnits] = useState<CadUnits>('mm')
	const [preview, setPreview] = useState<File | null>(null)
	const [step, setStep] = useState<File | null>(null)
	const [note, setNote] = useState('')
	const [busy, setBusy] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)

	async function submit(event: FormEvent) {
		event.preventDefault()
		setError(null)
		if (!preview) { setError('Choose a GLB (or STL) preview file.'); return }
		const format = extensionOf(preview.name) === 'stl' ? 'stl' : extensionOf(preview.name) === 'glb' ? 'glb' : null
		if (!format) { setError('The preview must be a .glb or .stl file.'); return }
		if (preview.size > CAD_LIMITS.maxArtifactBytes || (step?.size ?? 0) > CAD_LIMITS.maxArtifactBytes) { setError('Files are limited to 20 MB each.'); return }
		if (mode === 'model' && !name.trim()) { setError('Give the model a name.'); return }
		try {
			setBusy('Starting…')
			const model = await submitCad({
				...(mode === 'revision' ? { modelRecordId } : { name: name.trim(), units, ...(modelId.trim() ? { modelId: modelId.trim() } : {}) }),
				preview: { data: preview, name: preview.name, format },
				...(step ? { step: { data: step, name: step.name } } : {}),
				changeNote: note.trim(),
			}, setBusy)
			onDone(model)
		} catch (caught) {
			setBusy(null)
			setError(caught instanceof Error ? caught.message : 'The upload failed.')
		}
	}

	return <div className="cad-panel-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onCancel() }}>
		<form className="cad-upload-dialog" role="dialog" aria-modal="true" aria-label={mode === 'model' ? 'Add CAD model' : 'Add CAD revision'} onSubmit={(event) => void submit(event)}>
			<h2>{mode === 'model' ? 'Add CAD model' : 'Add a new revision'}</h2>
			<p className="cad-muted">The preview is what everyone sees in the browser. The STEP file stays the manufacturing source. {mode === 'revision' ? 'A new revision never replaces an approved one; it starts as a draft and needs its own approval.' : ''}</p>
			{mode === 'model' ? <>
				<label>Name<input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} required /></label>
				<label>Model ID (optional)<input value={modelId} onChange={(event) => setModelId(event.target.value)} maxLength={64} placeholder="Generated from the name if left blank" pattern="[A-Za-z0-9][A-Za-z0-9._\-]*" /></label>
				<label>Units of the model's coordinates<select value={units} onChange={(event) => setUnits(event.target.value as CadUnits)}>{CAD_UNITS.map((unit) => <option key={unit}>{unit}</option>)}</select></label>
			</> : null}
			<label>3D preview (.glb preferred, .stl accepted)<input type="file" accept=".glb,.stl" onChange={(event) => setPreview(event.target.files?.[0] ?? null)} required /></label>
			<label>STEP source (optional, .step or .stp)<input type="file" accept=".step,.stp" onChange={(event) => setStep(event.target.files?.[0] ?? null)} /></label>
			<label>{mode === 'model' ? 'Note' : 'What changed'}<textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={2000} /></label>
			{error ? <p className="cad-error" role="alert">{error}</p> : null}
			{busy ? <p className="cad-muted" role="status">{busy}</p> : null}
			<div className="cad-dialog-actions">
				<button type="button" onClick={onCancel} disabled={!!busy}>Cancel</button>
				<button type="submit" className="cad-primary" disabled={!!busy}>{mode === 'model' ? 'Add model' : 'Add revision'}</button>
			</div>
		</form>
	</div>
}
