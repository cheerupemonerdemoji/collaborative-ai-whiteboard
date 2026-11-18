import { apiRequest } from '../auth'
import { buildSampleAssemblyGlb, buildSampleGlb, SAMPLE_ASSEMBLY, SAMPLE_CAD, SAMPLE_STEP_TEXT } from '../../shared/cad-sample'
import type { CadModel, CadStatus, CadUnits } from '../../shared/cad-model'

/*
 * Browser side of the CAD review routes (server/cad-routes.ts). Every file is fetched through the board's own
 * authenticated asset route, so a card, a thumbnail or a download only works for someone who may read the board.
 * This module must stay free of Three.js: the canvas card imports it, and the viewer is loaded only on demand.
 */

let currentBoardId: string | null = null

export function setCadBoardId(boardId: string | null) { currentBoardId = boardId }

function board(): string {
	if (!currentBoardId) throw new Error('No board is open')
	return encodeURIComponent(currentBoardId)
}

export function cadAssetUrl(assetId: string): string | null {
	return currentBoardId ? `/api/boards/${encodeURIComponent(currentBoardId)}/assets/${encodeURIComponent(assetId)}` : null
}

export const recordKey = (modelRecordId: string) => modelRecordId.slice('cad_model:'.length)

export interface UploadedCadArtifact { assetId: string; sha256: string; bytes: number; name: string }

export async function uploadCadArtifact(kind: 'glb' | 'stl' | 'step' | 'thumbnail', data: Blob, name: string): Promise<UploadedCadArtifact> {
	const result = await apiRequest<{ artifact: UploadedCadArtifact }>(`/api/boards/${board()}/cad-artifacts/${kind}?name=${encodeURIComponent(name)}`, {
		method: 'POST',
		body: data,
		headers: { 'Content-Type': 'application/octet-stream' },
	})
	return result.artifact
}

function post<T>(path: string, body: unknown) {
	return apiRequest<T>(`/api/boards/${board()}${path}`, { method: 'POST', body: JSON.stringify(body) })
}

export interface CadSubmission {
	/** Present when adding a revision to an existing model. */
	modelRecordId?: string
	name?: string
	modelId?: string
	units?: CadUnits
	preview: { data: Blob; name: string; format: 'glb' | 'stl' }
	step?: { data: Blob; name: string }
	changeNote: string
}

/** Uploads the files, renders a thumbnail from the preview, then creates the model or appends the revision. */
export async function submitCad(input: CadSubmission, onProgress: (message: string) => void = () => {}): Promise<CadModel> {
	onProgress('Uploading the preview…')
	const previewArtifact = await uploadCadArtifact(input.preview.format, input.preview.data, input.preview.name)
	let stepArtifact: UploadedCadArtifact | undefined
	if (input.step) {
		onProgress('Uploading the STEP source…')
		stepArtifact = await uploadCadArtifact('step', input.step.data, input.step.name)
	}
	let thumbnailAssetId: string | undefined
	try {
		onProgress('Rendering a thumbnail…')
		const { renderCadThumbnail } = await import('./thumbnail')
		const thumbnail = await renderCadThumbnail(await input.preview.data.arrayBuffer(), input.preview.format)
		if (thumbnail) thumbnailAssetId = (await uploadCadArtifact('thumbnail', thumbnail, 'thumbnail.png')).assetId
	} catch {
		// A thumbnail is a convenience: without WebGL the card shows a placeholder and the model is still created.
	}
	onProgress('Saving…')
	const files = {
		[input.preview.format]: { assetId: previewArtifact.assetId, name: previewArtifact.name },
		...(stepArtifact ? { step: { assetId: stepArtifact.assetId, name: stepArtifact.name } } : {}),
	}
	const revision = { files, ...(thumbnailAssetId ? { thumbnailAssetId } : {}), changeNote: input.changeNote }
	const result = input.modelRecordId
		? await post<{ model: CadModel }>(`/cad-models/${recordKey(input.modelRecordId)}/revisions`, revision)
		: await post<{ model: CadModel }>('/cad-models', { ...revision, name: input.name, units: input.units, ...(input.modelId ? { modelId: input.modelId } : {}) })
	return result.model
}

/** The synthetic training part, sent through exactly the same path as a real upload. */
export function submitCadSample(onProgress?: (message: string) => void): Promise<CadModel> {
	return submitCad({
		name: SAMPLE_CAD.name,
		units: SAMPLE_CAD.units,
		preview: { data: new Blob([buildSampleGlb() as BlobPart], { type: 'application/octet-stream' }), name: 'training-spacer.glb', format: 'glb' },
		step: { data: new Blob([SAMPLE_STEP_TEXT], { type: 'application/octet-stream' }), name: 'training-spacer.step' },
		changeNote: 'Synthetic 60 x 40 x 10 mm training block. Not a verified part: do not fabricate from it.',
	}, onProgress)
}

/** A synthetic five-part assembly with explicit part identities and a declared bill of materials (no STEP source). */
export function submitCadAssemblySample(onProgress?: (message: string) => void): Promise<CadModel> {
	return submitCad({
		name: SAMPLE_ASSEMBLY.name,
		modelId: SAMPLE_ASSEMBLY.modelId,
		units: SAMPLE_ASSEMBLY.units,
		preview: { data: new Blob([buildSampleAssemblyGlb() as BlobPart], { type: 'application/octet-stream' }), name: 'training-bracket-assembly.glb', format: 'glb' },
		changeNote: 'Synthetic five-part assembly for trying assembly review. Not a real product: do not fabricate from it.',
	}, onProgress)
}

export async function linkCadComponent(modelRecordId: string, revisionId: string, link: { partKey: string; modelRecordId: string; revisionId: string }): Promise<CadModel> {
	return (await post<{ model: CadModel }>(`/cad-models/${recordKey(modelRecordId)}/revisions/${encodeURIComponent(revisionId)}/links`, link)).model
}

export async function unlinkCadComponent(modelRecordId: string, revisionId: string, partKey: string): Promise<CadModel> {
	return (await apiRequest<{ model: CadModel }>(`/api/boards/${board()}/cad-models/${recordKey(modelRecordId)}/revisions/${encodeURIComponent(revisionId)}/links/${encodeURIComponent(partKey)}`, { method: 'DELETE' })).model
}

export async function setCadStatus(modelRecordId: string, revisionId: string, to: CadStatus, note: string): Promise<CadModel> {
	return (await post<{ model: CadModel }>(`/cad-models/${recordKey(modelRecordId)}/revisions/${encodeURIComponent(revisionId)}/status`, { to, note })).model
}

export async function addCadModelComment(modelRecordId: string, revisionId: string, body: string): Promise<CadModel> {
	return (await post<{ model: CadModel }>(`/cad-models/${recordKey(modelRecordId)}/comments`, { revisionId, body })).model
}

export async function addCadModelEvidence(modelRecordId: string, evidence: { kind: 'note' | 'entity' | 'asset'; label: string; ref?: string }): Promise<CadModel> {
	return (await post<{ model: CadModel }>(`/cad-models/${recordKey(modelRecordId)}/evidence`, evidence)).model
}
