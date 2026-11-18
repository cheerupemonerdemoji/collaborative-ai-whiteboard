import { T } from '@tldraw/validate'
import { z } from 'zod'

/**
 * Browser CAD review: a `cad_model` document record holds a model's revisions, comments, evidence links and
 * review state; the `cad-review` shape is only a light card that points at it.
 *
 * Trust model. Clients can read `cad_model` records through sync but can never write them: the room vetoes
 * every client create, update and delete of the type (server/rooms.ts), and mutations go through the
 * authenticated HTTP routes in server/cad-routes.ts, which stamp the actor from the session. The functions below
 * are the only code that changes a model, and they are pure so the rules can be tested without a server.
 */
export const CAD_REVIEW_SHAPE_TYPE = 'cad-review' as const
export const CAD_MODEL_TYPE = 'cad_model' as const

export const CAD_UNITS = ['mm', 'cm', 'm', 'in'] as const
export const CAD_STATUSES = ['draft', 'in-review', 'approved', 'rejected'] as const
export type CadUnits = (typeof CAD_UNITS)[number]
export type CadStatus = (typeof CAD_STATUSES)[number]

export const CAD_STATUS_LABELS: Record<CadStatus, string> = {
	draft: 'Draft',
	'in-review': 'In review',
	approved: 'Approved',
	rejected: 'Rejected',
}

export const CAD_LIMITS = {
	maxRevisions: 50,
	maxComments: 500,
	maxEvidence: 100,
	maxModelBytes: 400_000,
	/** Largest accepted artifact. The server's octet-stream parser allows 20 MB, which bounds this. */
	maxArtifactBytes: 20_000_000,
	maxThumbnailBytes: 2_000_000,
	/** Content-addressed `cad-*` artifacts a single board may hold, thumbnails included. */
	maxArtifactsPerBoard: 300,
	/** Parts listed for one assembly revision, and component links one revision may carry. */
	maxParts: 500,
	maxLinks: 500,
} as const

export const CAD_MODEL_RECORD_ID = /^cad_model:[a-f0-9]{12}$/
export const CAD_ARTIFACT_ID = /^cad-[0-9a-f]{64}\.(glb|stl|step|png)$/
const SHA256 = /^[0-9a-f]{64}$/

export const CAD_ARTIFACT_EXTENSIONS = { glb: 'glb', stl: 'stl', step: 'step', thumbnail: 'png' } as const
export type CadArtifactKind = keyof typeof CAD_ARTIFACT_EXTENSIONS

export function cadArtifactId(sha256: string, kind: CadArtifactKind): string {
	return `cad-${sha256}.${CAD_ARTIFACT_EXTENSIONS[kind]}`
}

export class CadModelError extends Error {
	constructor(message: string, readonly statusCode: 403 | 404 | 409 | 422 = 422) { super(message) }
}

const actorSchema = z.object({
	userId: z.string().min(1).max(100),
	displayName: z.string().min(1).max(100),
	source: z.enum(['human', 'ai']),
}).strict()
export type CadActor = z.infer<typeof actorSchema>

const artifactSchema = z.object({
	assetId: z.string().regex(CAD_ARTIFACT_ID),
	sha256: z.string().regex(SHA256),
	bytes: z.number().int().positive().max(CAD_LIMITS.maxArtifactBytes),
	name: z.string().min(1).max(120),
}).strict()
export type CadArtifact = z.infer<typeof artifactSchema>

const thumbnailSchema = z.object({
	assetId: z.string().regex(CAD_ARTIFACT_ID),
	sha256: z.string().regex(SHA256),
}).strict()

const filesSchema = z.object({
	glb: artifactSchema.optional(),
	stl: artifactSchema.optional(),
	step: artifactSchema.optional(),
}).strict()
export type CadRevisionFiles = z.infer<typeof filesSchema>

/**
 * Assembly structure, read by the server from the GLB it stored (never supplied by the browser).
 * A part's `key` is the file's own `extras.partId` when it gave a unique one (`stable: true`); otherwise it is only the
 * glTF node number (`stable: false`), which means nothing outside this one file.
 */
export const CAD_PART_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/
const partSchema = z.object({
	key: z.string().regex(CAD_PART_KEY),
	stable: z.boolean(),
	node: z.number().int().nonnegative(),
	parent: z.string().regex(CAD_PART_KEY).nullable(),
	name: z.string().max(120),
	/** False when the file gave the node no name. Unnamed parts never get a bill-of-materials row. */
	named: z.boolean(),
	mesh: z.boolean(),
}).strict()
export type CadAssemblyPart = z.infer<typeof partSchema>

/** One row, and only where the file itself declared a part number and a quantity for a named part. */
const bomRowSchema = z.object({
	partKey: z.string().regex(CAD_PART_KEY),
	partNumber: z.string().min(1).max(64),
	description: z.string().max(200).optional(),
	quantity: z.number().int().min(1).max(100_000),
	source: z.literal('glb-extras'),
}).strict()
export type CadBomRow = z.infer<typeof bomRowSchema>

const assemblySchema = z.object({
	parts: z.array(partSchema).min(2).max(CAD_LIMITS.maxParts),
	bom: z.array(bomRowSchema).max(CAD_LIMITS.maxParts),
	/**
	 * The outermost component groups the FILE marked with `extras.explodeGroup`, recorded only when the server verified that
	 * the grouping is complete (every piece of geometry sits inside exactly one group) and that there are at least two groups.
	 * The exploded view moves each listed group as one unit. It is absent when the file gave no verified grouping, and then the
	 * exploded view is disabled: groups are never guessed from names, order, colour or position.
	 */
	explode: z.array(z.string().regex(CAD_PART_KEY)).min(2).max(CAD_LIMITS.maxParts).optional(),
}).strict()
export type CadAssembly = z.infer<typeof assemblySchema>

/** Pins a part of an assembly revision to one exact revision of another model. It is a reference, not an approval. */
const componentLinkSchema = z.object({
	partKey: z.string().regex(CAD_PART_KEY),
	modelRecordId: z.string().regex(CAD_MODEL_RECORD_ID),
	revisionId: z.string().regex(/^rev-[a-z0-9]{6,24}$/),
	addedBy: actorSchema,
	addedAt: z.number().int().nonnegative(),
}).strict()
export type CadComponentLink = z.infer<typeof componentLinkSchema>

const decisionSchema = z.object({
	by: actorSchema,
	at: z.number().int().nonnegative(),
	note: z.string().max(1_000),
}).strict()

const revisionSchema = z.object({
	id: z.string().regex(/^rev-[a-z0-9]{6,24}$/),
	number: z.number().int().positive(),
	label: z.string().min(1).max(120),
	createdAt: z.number().int().nonnegative(),
	createdBy: actorSchema,
	changeNote: z.string().max(2_000),
	files: filesSchema,
	thumbnail: thumbnailSchema.optional(),
	assembly: assemblySchema.optional(),
	links: z.array(componentLinkSchema).max(CAD_LIMITS.maxLinks).optional(),
	status: z.enum(CAD_STATUSES),
	decision: decisionSchema.optional(),
}).strict()
export type CadRevision = z.infer<typeof revisionSchema>

const commentSchema = z.object({
	id: z.string().regex(/^cmt-[a-z0-9]{6,24}$/),
	revisionId: z.string().regex(/^rev-[a-z0-9]{6,24}$/),
	author: actorSchema,
	body: z.string().min(1).max(2_000),
	createdAt: z.number().int().nonnegative(),
}).strict()
export type CadComment = z.infer<typeof commentSchema>

export const CAD_EVIDENCE_KINDS = ['note', 'entity', 'asset'] as const
const evidenceSchema = z.object({
	id: z.string().regex(/^evd-[a-z0-9]{6,24}$/),
	kind: z.enum(CAD_EVIDENCE_KINDS),
	label: z.string().min(1).max(200),
	/** `entity` is an engineering_entity id; `asset` is a board asset id. A `note` has no reference. */
	ref: z.string().min(1).max(200).optional(),
	addedBy: actorSchema,
	addedAt: z.number().int().nonnegative(),
}).strict()
export type CadEvidence = z.infer<typeof evidenceSchema>

const SLOT_EXTENSION: Record<keyof CadRevisionFiles, string> = { glb: '.glb', stl: '.stl', step: '.step' }

/** Shared by the record schema and the route input so both enforce the same file rules. */
export function checkCadFiles(files: CadRevisionFiles, thumbnail?: { assetId: string }): string | null {
	if (!files.glb && !files.stl) return 'A revision needs a browser preview (GLB, or STL as a fallback)'
	for (const slot of Object.keys(SLOT_EXTENSION) as Array<keyof CadRevisionFiles>) {
		const file = files[slot]
		if (file && !file.assetId.endsWith(SLOT_EXTENSION[slot])) return `The ${slot} file must be a ${slot} artifact`
		if (file && !file.assetId.startsWith(`cad-${file.sha256}.`)) return `The ${slot} artifact id does not match its hash`
	}
	if (thumbnail && !thumbnail.assetId.endsWith('.png')) return 'The thumbnail must be a PNG artifact'
	return null
}

/** Cross-field rules for an assembly revision: unique part keys, a BOM only for named parts, links only to parts. */
function assemblyProblems(revision: { assembly?: CadAssembly; links?: CadComponentLink[] }, ownRecordId: string): string[] {
	const problems: string[] = []
	const { assembly, links } = revision
	if (!assembly) return links?.length ? ['component links need an assembly structure'] : []
	const byKey = new Map<string, CadAssemblyPart>()
	for (const part of assembly.parts) {
		if (byKey.has(part.key)) problems.push(`duplicate part key ${part.key}`)
		byKey.set(part.key, part)
	}
	for (const part of assembly.parts) if (part.parent !== null && !byKey.has(part.parent)) problems.push(`part ${part.key} has an unknown parent`)
	if (assembly.explode) {
		const groups = new Set(assembly.explode)
		if (groups.size !== assembly.explode.length) problems.push('duplicate exploded-view group')
		const insideGroup = (part: CadAssemblyPart, strict: boolean): boolean => {
			for (let current: CadAssemblyPart | undefined = strict ? (part.parent ? byKey.get(part.parent) : undefined) : part, hops = 0; current && hops < 64; current = current.parent ? byKey.get(current.parent) : undefined, hops++) if (groups.has(current.key)) return true
			return false
		}
		for (const key of assembly.explode) {
			const part = byKey.get(key)
			if (!part) { problems.push(`exploded-view group ${key} is not a part`); continue }
			// Groups are the outermost ones: none may sit inside another, or one piece would move twice.
			if (insideGroup(part, true)) problems.push(`exploded-view group ${key} is inside another group`)
		}
		for (const part of assembly.parts) if (part.mesh && !insideGroup(part, false)) problems.push(`part ${part.key} is not in any exploded-view group`)
	}
	const seenBom = new Set<string>()
	for (const row of assembly.bom) {
		const part = byKey.get(row.partKey)
		if (!part) problems.push(`bill of materials row for unknown part ${row.partKey}`)
		else if (!part.named) problems.push(`bill of materials row for the unnamed part ${row.partKey}`)
		if (seenBom.has(row.partKey)) problems.push(`two bill of materials rows for ${row.partKey}`)
		seenBom.add(row.partKey)
	}
	const seenLinks = new Set<string>()
	for (const link of links ?? []) {
		if (!byKey.has(link.partKey)) problems.push(`component link to unknown part ${link.partKey}`)
		if (seenLinks.has(link.partKey)) problems.push(`two component links for ${link.partKey}`)
		seenLinks.add(link.partKey)
		if (link.modelRecordId === ownRecordId) problems.push('an assembly cannot link to itself')
	}
	return problems
}

export const cadModelSchema = z.object({
	typeName: z.literal(CAD_MODEL_TYPE),
	id: z.string().regex(CAD_MODEL_RECORD_ID),
	modelId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
	name: z.string().min(1).max(120),
	units: z.enum(CAD_UNITS),
	createdAt: z.number().int().nonnegative(),
	createdBy: actorSchema,
	updatedAt: z.number().int().nonnegative(),
	revisions: z.array(revisionSchema).min(1).max(CAD_LIMITS.maxRevisions),
	comments: z.array(commentSchema).max(CAD_LIMITS.maxComments),
	evidence: z.array(evidenceSchema).max(CAD_LIMITS.maxEvidence),
}).strict().superRefine((model, context) => {
	const ids = new Set<string>()
	model.revisions.forEach((revision, index) => {
		if (ids.has(revision.id)) context.addIssue({ code: 'custom', message: `Duplicate revision ${revision.id}` })
		ids.add(revision.id)
		if (revision.number !== index + 1) context.addIssue({ code: 'custom', message: 'Revisions must be numbered 1..n in order' })
		const problem = checkCadFiles(revision.files, revision.thumbnail)
		if (problem) context.addIssue({ code: 'custom', message: problem })
		for (const message of assemblyProblems(revision, model.id)) context.addIssue({ code: 'custom', message: `Revision ${revision.id}: ${message}` })
		const decided = revision.status === 'approved' || revision.status === 'rejected'
		if (decided !== (revision.decision !== undefined)) context.addIssue({ code: 'custom', message: `Revision ${revision.id}: a decision belongs to approved and rejected revisions only` })
	})
	for (const comment of model.comments) if (!ids.has(comment.revisionId)) context.addIssue({ code: 'custom', message: `Comment ${comment.id} names an unknown revision` })
})
export type CadModel = z.infer<typeof cadModelSchema>

/** The light card. Everything it displays is read from the `cad_model` record it points at. */
export const cadReviewShapeProps = {
	w: T.nonZeroNumber,
	h: T.nonZeroNumber,
	modelRecordId: T.string.check('modelRecordId', (value) => {
		if (!CAD_MODEL_RECORD_ID.test(value)) throw new Error('Expected a cad_model record id')
	}),
}
export interface CadReviewShapeProps { w: number; h: number; modelRecordId: string }

export const CAD_CARD_SIZE = { w: 360, h: 300 } as const

export function latestCadRevision(model: CadModel): CadRevision {
	return model.revisions[model.revisions.length - 1]
}

/** The newest approved revision, if any. Approval is never inherited by a later revision. */
export function approvedCadRevision(model: CadModel): CadRevision | undefined {
	return [...model.revisions].reverse().find((revision) => revision.status === 'approved')
}

export function cadModelStatus(model: CadModel): CadStatus {
	return latestCadRevision(model).status
}

export function hasApprovedCadRevision(model: CadModel): boolean {
	return model.revisions.some((revision) => revision.status === 'approved')
}

/** Allowed review transitions. `approved` is terminal: change means a new revision. */
export const CAD_TRANSITIONS: Record<CadStatus, readonly CadStatus[]> = {
	draft: ['in-review'],
	'in-review': ['approved', 'rejected', 'draft'],
	rejected: ['draft'],
	approved: [],
}

function cleanText(value: string, field: string, max: number): string {
	const text = value.trim()
	if (!text) throw new CadModelError(`${field} is required`)
	if (text.length > max) throw new CadModelError(`${field} is limited to ${max} characters`)
	return text
}

function requireHuman(actor: CadActor, action: string): void {
	if (actor.source !== 'human') throw new CadModelError(`${action} requires a signed-in person; an AI client cannot do this`, 403)
}

function finish(model: CadModel): CadModel {
	const parsed = cadModelSchema.safeParse(model)
	if (!parsed.success) throw new CadModelError(parsed.error.issues.map((issue) => issue.message).join('; '))
	if (new TextEncoder().encode(JSON.stringify(parsed.data)).length > CAD_LIMITS.maxModelBytes) throw new CadModelError('This model has reached its size limit')
	return parsed.data
}

export interface NewCadRevision {
	id: string
	files: CadRevisionFiles
	thumbnail?: { assetId: string; sha256: string }
	changeNote: string
	label?: string
	/** Read by the server from the stored GLB. */
	assembly?: CadAssembly
}

function newRevision(input: NewCadRevision, number: number, actor: CadActor, now: number): CadRevision {
	return {
		id: input.id,
		number,
		label: input.label?.trim() || `Revision ${number}`,
		createdAt: now,
		createdBy: actor,
		changeNote: input.changeNote.trim().slice(0, 2_000),
		files: input.files,
		...(input.thumbnail ? { thumbnail: input.thumbnail } : {}),
		...(input.assembly ? { assembly: input.assembly } : {}),
		// Whoever creates a revision, it starts as a draft. Nothing is born approved.
		status: 'draft',
	}
}

export function createCadModel(
	input: { id: string; modelId: string; name: string; units: CadUnits; revision: NewCadRevision },
	actor: CadActor,
	now: number
): CadModel {
	return finish({
		typeName: CAD_MODEL_TYPE,
		id: input.id,
		modelId: input.modelId.trim(),
		name: cleanText(input.name, 'Name', 120),
		units: input.units,
		createdAt: now,
		createdBy: actor,
		updatedAt: now,
		revisions: [newRevision(input.revision, 1, actor, now)],
		comments: [],
		evidence: [],
	})
}

/**
 * Appends a draft revision. Earlier revisions, including an approved one, are copied through untouched, so a
 * replacement of the model's files is always a new, separately attributed and separately approved revision.
 */
export function appendCadRevision(model: CadModel, input: NewCadRevision, actor: CadActor, now: number): CadModel {
	if (model.revisions.length >= CAD_LIMITS.maxRevisions) throw new CadModelError('This model has reached its revision limit')
	return finish({
		...model,
		updatedAt: now,
		revisions: [...model.revisions, newRevision(input, model.revisions.length + 1, actor, now)],
	})
}

/**
 * Moves the newest revision through review. Only a person can do this, and only the newest revision can be
 * decided, so a superseded draft cannot be approved after the fact.
 */
export function transitionCadRevision(
	model: CadModel,
	revisionId: string,
	to: CadStatus,
	actor: CadActor,
	note: string,
	now: number
): CadModel {
	requireHuman(actor, 'Changing review status')
	const index = model.revisions.findIndex((revision) => revision.id === revisionId)
	if (index < 0) throw new CadModelError(`Unknown revision ${revisionId}`, 404)
	if (index !== model.revisions.length - 1) throw new CadModelError('Only the newest revision can change review status', 409)
	const revision = model.revisions[index]
	if (!CAD_TRANSITIONS[revision.status].includes(to)) {
		throw new CadModelError(
			revision.status === 'approved'
				? 'An approved revision is final. Create a new revision to change the model.'
				: `A ${revision.status} revision cannot become ${to}`,
			409
		)
	}
	const decided = to === 'approved' || to === 'rejected'
	const { decision: _previous, ...rest } = revision
	const next: CadRevision = {
		...rest,
		status: to,
		...(decided ? { decision: { by: actor, at: now, note: note.trim().slice(0, 1_000) } } : {}),
	}
	return finish({ ...model, updatedAt: now, revisions: model.revisions.map((item, position) => (position === index ? next : item)) })
}

export function addCadComment(model: CadModel, input: { id: string; revisionId: string; body: string }, actor: CadActor, now: number): CadModel {
	requireHuman(actor, 'Commenting')
	if (!model.revisions.some((revision) => revision.id === input.revisionId)) throw new CadModelError(`Unknown revision ${input.revisionId}`, 404)
	if (model.comments.length >= CAD_LIMITS.maxComments) throw new CadModelError('This model has reached its comment limit')
	return finish({
		...model,
		updatedAt: now,
		comments: [...model.comments, { id: input.id, revisionId: input.revisionId, author: actor, body: cleanText(input.body, 'Comment', 2_000), createdAt: now }],
	})
}

function draftAssemblyRevision(model: CadModel, revisionId: string): { revision: CadRevision; index: number; assembly: CadAssembly } {
	const index = model.revisions.findIndex((revision) => revision.id === revisionId)
	if (index < 0) throw new CadModelError(`Unknown revision ${revisionId}`, 404)
	const revision = model.revisions[index]
	if (!revision.assembly) throw new CadModelError('This revision has no assembly structure, so it has no parts to link')
	// A link is part of what the revision says. Once the revision is under review or decided, its content is fixed.
	if (revision.status !== 'draft') throw new CadModelError('Component links can only change while the assembly revision is a draft', 409)
	return { revision, index, assembly: revision.assembly }
}

/**
 * Pins a part of an assembly revision to one exact revision of another model on the board. This records a reference
 * and nothing else: it does not approve the component, it does not make the assembly depend on the component's
 * status, and it never changes either model's review state.
 */
export function addCadComponentLink(
	model: CadModel,
	revisionId: string,
	input: { partKey: string; modelRecordId: string; revisionId: string },
	lookup: (modelRecordId: string) => CadModel | undefined,
	actor: CadActor,
	now: number
): CadModel {
	requireHuman(actor, 'Linking a component')
	const { revision, index, assembly } = draftAssemblyRevision(model, revisionId)
	const part = assembly.parts.find((item) => item.key === input.partKey)
	if (!part) throw new CadModelError(`Unknown part ${input.partKey}`, 404)
	if (!part.named) throw new CadModelError('An unnamed part cannot be linked: name it in the source model first')
	if (input.modelRecordId === model.id) throw new CadModelError('An assembly cannot link to itself')
	const target = lookup(input.modelRecordId)
	if (!target) throw new CadModelError('That component model is not on this board', 404)
	if (!target.revisions.some((item) => item.id === input.revisionId)) throw new CadModelError('That component revision does not exist', 404)
	const others = (revision.links ?? []).filter((link) => link.partKey !== input.partKey)
	if (others.length >= CAD_LIMITS.maxLinks) throw new CadModelError('This revision has reached its component link limit')
	const links = [...others, { partKey: input.partKey, modelRecordId: input.modelRecordId, revisionId: input.revisionId, addedBy: actor, addedAt: now }]
	return finish({ ...model, updatedAt: now, revisions: model.revisions.map((item, position) => (position === index ? { ...revision, links } : item)) })
}

export function removeCadComponentLink(model: CadModel, revisionId: string, partKey: string, actor: CadActor, now: number): CadModel {
	requireHuman(actor, 'Unlinking a component')
	const { revision, index } = draftAssemblyRevision(model, revisionId)
	const existing = revision.links ?? []
	if (!existing.some((link) => link.partKey === partKey)) throw new CadModelError(`Part ${partKey} has no component link`, 404)
	const links = existing.filter((link) => link.partKey !== partKey)
	const { links: _old, ...rest } = revision
	return finish({ ...model, updatedAt: now, revisions: model.revisions.map((item, position) => (position === index ? { ...rest, ...(links.length ? { links } : {}) } : item)) })
}

export function addCadEvidence(
	model: CadModel,
	input: { id: string; kind: (typeof CAD_EVIDENCE_KINDS)[number]; label: string; ref?: string },
	actor: CadActor,
	now: number
): CadModel {
	requireHuman(actor, 'Linking evidence')
	if (model.evidence.length >= CAD_LIMITS.maxEvidence) throw new CadModelError('This model has reached its evidence limit')
	if (input.kind !== 'note' && !input.ref) throw new CadModelError('This evidence needs a reference')
	return finish({
		...model,
		updatedAt: now,
		evidence: [...model.evidence, {
			id: input.id,
			kind: input.kind,
			label: cleanText(input.label, 'Label', 200),
			...(input.kind !== 'note' && input.ref ? { ref: input.ref } : {}),
			addedBy: actor,
			addedAt: now,
		}],
	})
}
