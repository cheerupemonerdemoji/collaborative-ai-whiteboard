import { getIndexAbove } from '@tldraw/utils'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { TLRecord } from '@tldraw/tlschema'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import {
	addCadComponentLink,
	removeCadComponentLink,
	CAD_PART_KEY,
	addCadComment,
	addCadEvidence,
	appendCadRevision,
	CAD_EVIDENCE_KINDS,
	CAD_MODEL_RECORD_ID,
	CAD_MODEL_TYPE,
	CAD_CARD_SIZE,
	CAD_REVIEW_SHAPE_TYPE,
	CAD_STATUSES,
	CAD_UNITS,
	cadModelSchema,
	CadModelError,
	checkCadFiles,
	createCadModel,
	transitionCadRevision,
	CAD_LIMITS,
	type CadActor,
	type CadModel,
	type CadRevisionFiles,
	type NewCadRevision,
} from '../shared/cad-model'
import type { CurrentSession } from './auth'
import type { BoardRole } from './auth-db'
import { CAD_ARTIFACT_KINDS, cleanFileName, inspectCadArtifact, storeCadArtifact } from './cad-artifacts'
import { extractCadAssembly } from './cad-assembly'
import { HttpError } from './http'
import { getRoomHandle, schema, withRoomHistory, type RoomHandle } from './rooms'
import type { SlidingWindowRateLimiter } from './security'

/** Everything the routes need from the app, so they can be exercised and reasoned about on their own. */
export interface CadRouteDeps {
	/** Browser session cookie only. A machine bearer token never reaches these routes. */
	currentSession(request: FastifyRequest): CurrentSession | null
	boardRole(userId: string, boardId: string): BoardRole | null
	assetBelongsToBoard(uploadId: string, boardId: string): boolean
	/** Registers the asset unless the board already holds `max` assets with the prefix. */
	registerAssetIfUnderCap(boardId: string, uploadId: string, prefix: string, max: number): boolean
	/** Gives back a registration whose file was never stored. */
	unregisterAsset(boardId: string, uploadId: string): void
	assetDirectory: string
	uploadLimiter: SlidingWindowRateLimiter
	writeLimiter: SlidingWindowRateLimiter
	/**
	 * Machine upload (the machine CAD upload design note). Optional: without these two the cad-machine routes are not
	 * registered at all. `machineCadClient` returns the credential's name only for a valid, unexpired bearer that holds write
	 * access AND the `cad-upload` capability on exactly this board; anything else is null.
	 */
	machineCadClient?(authorization: string | undefined, boardId: string): string | null
	boardIsLive?(boardId: string): boolean
}

const MAX_MODELS_PER_BOARD = 100
const fileInput = z.object({ assetId: z.string(), name: z.string().max(200).optional() }).strict()
const filesInput = z.object({ glb: fileInput.optional(), stl: fileInput.optional(), step: fileInput.optional() }).strict()
const revisionInput = z.object({
	files: filesInput,
	thumbnailAssetId: z.string().optional(),
	changeNote: z.string().max(2_000).default(''),
	label: z.string().max(120).optional(),
}).strict()
const createInput = revisionInput.extend({
	name: z.string().min(1).max(120),
	modelId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/).optional(),
	units: z.enum(CAD_UNITS),
}).strict()
const linkInput = z.object({ partKey: z.string().regex(CAD_PART_KEY), modelRecordId: z.string(), revisionId: z.string() }).strict()
const statusInput = z.object({ to: z.enum(CAD_STATUSES), note: z.string().max(1_000).default('') }).strict()
const commentInput = z.object({ revisionId: z.string(), body: z.string().min(1).max(2_000) }).strict()
const evidenceInput = z.object({ kind: z.enum(CAD_EVIDENCE_KINDS), label: z.string().min(1).max(200), ref: z.string().max(200).optional() }).strict()

/** Machine create: the model ID is required (a retry must not make a second entry) and the card is placed in the same write. */
const machineCreateInput = createInput.extend({
	modelId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
	placement: z.object({ pageId: z.string().regex(/^page:[A-Za-z0-9_-]{1,80}$/), x: z.number().finite().min(-1_000_000).max(1_000_000), y: z.number().finite().min(-1_000_000).max(1_000_000) }).strict(),
}).strict()

const newId = (prefix: string) => `${prefix}-${randomBytes(6).toString('hex')}`

function slug(name: string): string {
	const base = name.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
	return `${base || 'MODEL'}-${randomBytes(2).toString('hex').toUpperCase()}`
}

export function registerCadRoutes(app: FastifyInstance, deps: CadRouteDeps): void {
	/** Session, membership and write role, in that order, answered exactly as the other board routes answer. */
	function authorize(request: FastifyRequest, reply: FastifyReply, limiter: SlidingWindowRateLimiter, scope: string): { boardId: string; actor: CadActor } | null {
		const session = deps.currentSession(request)
		if (!session) { void reply.code(401).send({ error: 'Authentication required' }); return null }
		const boardId = (request.params as { boardId: string }).boardId
		if (!/^[A-Za-z0-9_-]{1,80}$/.test(boardId)) { void reply.code(400).send({ error: 'Invalid board ID' }); return null }
		const role = deps.boardRole(session.user.id, boardId)
		if (!role) { void reply.code(404).send({ error: 'Board not found' }); return null }
		if (role !== 'owner' && role !== 'editor') { void reply.code(403).send({ error: 'You do not have permission to change CAD models on this board' }); return null }
		if (!limiter.allow(`user:${session.user.id}:${scope}:${boardId}`)) { void reply.code(429).send({ error: `Too many ${scope} requests. Try again later.` }); return null }
		return { boardId, actor: { userId: `user:${session.user.id}`, displayName: session.user.displayName, source: 'human' } }
	}

	/**
	 * Machine credential, never a session. The cookie is not read, a bearer that is wrong, expired, for another board or
	 * lacking the capability is one undifferentiated 401, and the credential's name (never the token) is the audited actor.
	 */
	function authorizeMachine(request: FastifyRequest, reply: FastifyReply, limiter: SlidingWindowRateLimiter, scope: string): { boardId: string; actor: CadActor } | null {
		const boardId = (request.params as { boardId: string }).boardId
		if (!/^[A-Za-z0-9_-]{1,80}$/.test(boardId)) { void reply.code(400).send({ error: 'Invalid board ID' }); return null }
		const client = deps.machineCadClient?.(request.headers.authorization, boardId) ?? null
		if (!client) { void reply.code(401).send({ error: 'Authentication required' }); return null }
		if (!deps.boardIsLive?.(boardId)) { void reply.code(404).send({ error: 'Board not found' }); return null }
		if (!limiter.allow(`token:${client}:cad-${scope}:${boardId}`)) { void reply.code(429).send({ error: `Too many ${scope} requests. Try again later.` }); return null }
		return { boardId, actor: { userId: `token:${client}`, displayName: client, source: 'ai' } }
	}

	/** Resolves a client-named artifact to a stored, board-owned, content-addressed file; sizes come from disk, never the client. */
	async function resolveFiles(boardId: string, input: z.infer<typeof filesInput>): Promise<CadRevisionFiles> {
		const files: CadRevisionFiles = {}
		for (const slot of ['glb', 'stl', 'step'] as const) {
			const given = input[slot]
			if (!given) continue
			const match = /^cad-([0-9a-f]{64})\.(glb|stl|step)$/.exec(given.assetId)
			if (!match || match[2] !== slot) throw new HttpError(422, `The ${slot} file is not a CAD ${slot} artifact`)
			if (!deps.assetBelongsToBoard(given.assetId, boardId)) throw new HttpError(404, `The ${slot} file was not uploaded to this board`)
			const size = await stat(join(deps.assetDirectory, given.assetId)).then((info) => info.size, () => 0)
			if (!size) throw new HttpError(404, `The ${slot} file was not uploaded to this board`)
			files[slot] = { assetId: given.assetId, sha256: match[1], bytes: size, name: cleanFileName(given.name, `model.${slot}`) }
		}
		return files
	}

	async function resolveThumbnail(boardId: string, assetId: string | undefined): Promise<NewCadRevision['thumbnail']> {
		if (!assetId) return undefined
		const match = /^cad-([0-9a-f]{64})\.png$/.exec(assetId)
		if (!match) throw new HttpError(422, 'The thumbnail is not a CAD thumbnail artifact')
		if (!deps.assetBelongsToBoard(assetId, boardId)) throw new HttpError(404, 'The thumbnail was not uploaded to this board')
		return { assetId, sha256: match[1] }
	}

	async function revisionFrom(boardId: string, input: z.infer<typeof revisionInput>): Promise<NewCadRevision> {
		const files = await resolveFiles(boardId, input.files)
		const thumbnail = await resolveThumbnail(boardId, input.thumbnailAssetId)
		const problem = checkCadFiles(files, thumbnail)
		if (problem) throw new HttpError(422, problem)
		// Assembly structure comes from the stored GLB, read here, never from the request. The bytes are re-hashed first so a
		// file that is not what its content-addressed name says is never trusted.
		let assembly: NewCadRevision['assembly']
		if (files.glb) {
			const bytes = await readFile(join(deps.assetDirectory, files.glb.assetId))
			if (createHash('sha256').update(bytes).digest('hex') !== files.glb.sha256) throw new HttpError(422, 'The stored GLB does not match its hash')
			assembly = extractCadAssembly(bytes)
		}
		return { id: newId('rev'), files, ...(thumbnail ? { thumbnail } : {}), ...(assembly ? { assembly } : {}), changeNote: input.changeNote, ...(input.label ? { label: input.label } : {}) }
	}

	/**
	 * Applies one change to one model as the signed-in person. It runs on the server's own storage transaction, so the
	 * room's refusal of browser writes (server/rooms.ts) does not apply to it, and it is recorded in history as that
	 * person's action. A rule failure throws before anything is written.
	 */
	function mutate(handle: RoomHandle, actor: CadActor, eventType: string, metadata: Record<string, unknown>, change: (txn: StorageTxn) => CadModel): CadModel {
		return withRoomHistory(handle, { actorUserId: actor.userId, actorDisplayName: actor.displayName, source: actor.source, immediate: true, eventType, metadata }, () =>
			handle.room.storage.transaction((txn) => {
				const next = change(txn as unknown as StorageTxn)
				txn.set(next.id, next as unknown as TLRecord)
				return next
			}).result)
	}

	function loadModel(txn: StorageTxn, recordId: string): CadModel {
		const id = `${CAD_MODEL_TYPE}:${recordId}`
		const existing = CAD_MODEL_RECORD_ID.test(id) ? txn.get(id) : undefined
		const parsed = cadModelSchema.safeParse(existing)
		if (!parsed.success) throw new CadModelError('Unknown CAD model', 404)
		return parsed.data
	}

	/** Validates, quota-checks and stores one uploaded artifact. Shared by the signed-in route and the machine route. */
	async function receiveArtifact(request: FastifyRequest, reply: FastifyReply, auth: { boardId: string; actor: CadActor }) {
		const kind = (request.params as { kind: string }).kind
		if (!(CAD_ARTIFACT_KINDS as string[]).includes(kind)) return reply.code(400).send({ error: 'Unknown artifact kind' })
		const inspected = inspectCadArtifact(kind as (typeof CAD_ARTIFACT_KINDS)[number], request.body)
		const { assetId } = inspected
		const register = () => deps.registerAssetIfUnderCap(auth.boardId, assetId, 'cad-', CAD_LIMITS.maxArtifactsPerBoard)
		const limit = () => new HttpError(422, 'This board has reached its CAD artifact limit')
		// The quota is reserved first (it is checked and taken in one transaction), so a flood cannot write files past the
		// cap. The reservation is given back if the file does not end up on disk, so a failed upload costs nothing.
		const reserved = !deps.assetBelongsToBoard(assetId, auth.boardId)
		if (reserved && !register()) throw limit()
		try {
			await storeCadArtifact(deps.assetDirectory, assetId, inspected.data)
			// A request for the same bytes that raced this one may have given the row back while the file was in flight.
			if (!deps.assetBelongsToBoard(assetId, auth.boardId) && !register()) throw limit()
		} catch (error) {
			if (reserved && !existsSync(join(deps.assetDirectory, assetId))) deps.unregisterAsset(auth.boardId, assetId)
			throw error
		}
		const name = cleanFileName((request.query as { name?: string }).name, `model.${inspected.assetId.split('.').pop()}`)
		// Audit line for machine uploads: who (the credential's name, never the token), where, what and how big.
		if (auth.actor.source === 'ai') request.log.info({ audit: 'cad.artifact.uploaded', actor: auth.actor.userId, boardId: auth.boardId, assetId: inspected.assetId, bytes: inspected.bytes }, 'machine CAD artifact stored')
		return reply.code(201).send({ artifact: { assetId: inspected.assetId, sha256: inspected.sha256, bytes: inspected.bytes, name } })
	}

	app.post('/api/boards/:boardId/cad-artifacts/:kind', async (request, reply) => {
		const auth = authorize(request, reply, deps.uploadLimiter, 'upload')
		if (!auth) return reply
		return receiveArtifact(request, reply, auth)
	})

	if (deps.machineCadClient && deps.boardIsLive) {
		app.post('/api/boards/:boardId/cad-machine/artifacts/:kind', async (request, reply) => {
			const auth = authorizeMachine(request, reply, deps.uploadLimiter, 'upload')
			if (!auth) return reply
			return receiveArtifact(request, reply, auth)
		})
	}

	type Placement = z.infer<typeof machineCreateInput>['placement']

	/** Creates one model entry, and a card for it when `placement` is given, in one history-recorded write. */
	async function createModelEntry(auth: { boardId: string; actor: CadActor }, body: z.infer<typeof createInput>, placement?: Placement): Promise<CadModel> {
		const revision = await revisionFrom(auth.boardId, body)
		const handle = getRoomHandle(auth.boardId)
		const recordId = randomBytes(6).toString('hex')
		return mutate(handle, auth.actor, 'cad.model.created', { modelRecordId: `${CAD_MODEL_TYPE}:${recordId}`, name: body.name, units: body.units, revisionId: revision.id, ...(placement ? { pageId: placement.pageId } : {}) }, (txn) => {
			const existing = [...txn.values()].filter((record) => (record as { typeName?: string }).typeName === CAD_MODEL_TYPE) as unknown as CadModel[]
			if (existing.length >= MAX_MODELS_PER_BOARD) throw new CadModelError('This board has reached its CAD model limit')
			const modelId = body.modelId ?? slug(body.name)
			if (existing.some((item) => item.modelId.toLowerCase() === modelId.toLowerCase())) throw new CadModelError(`Model ID ${modelId} is already used on this board`, 409)
			const created = createCadModel({ id: `${CAD_MODEL_TYPE}:${recordId}`, modelId, name: body.name, units: body.units, revision }, auth.actor, Date.now())
			if (placement) placeCard(txn, placement, created.id, recordId)
			return created
		})
	}

	/** A card for a model, on a page that exists on this board, above everything already there. Validated like any shape. */
	function placeCard(txn: StorageTxn, placement: Placement, modelRecordId: string, recordId: string): void {
		if ((txn.get(placement.pageId) as { typeName?: string } | undefined)?.typeName !== 'page') throw new CadModelError('That page does not exist on this board', 404)
		const indexes = [...txn.values()].filter((record) => (record as { typeName?: string }).typeName === 'shape' && (record as { parentId?: string }).parentId === placement.pageId).map((record) => (record as { index: string }).index).sort()
		const card = { id: `shape:cad_${recordId}`, typeName: 'shape', type: CAD_REVIEW_SHAPE_TYPE, x: placement.x, y: placement.y, rotation: 0, index: getIndexAbove(indexes.at(-1) as never), parentId: placement.pageId, isLocked: false, opacity: 1, props: { ...CAD_CARD_SIZE, modelRecordId }, meta: {} }
		schema.types.shape.validate(card)
		txn.set(card.id, card as unknown as TLRecord)
	}

	app.post('/api/boards/:boardId/cad-models', async (request, reply) => {
		const auth = authorize(request, reply, deps.writeLimiter, 'cad')
		if (!auth) return reply
		const model = await createModelEntry(auth, createInput.parse(request.body))
		return reply.code(201).send({ model })
	})

	if (deps.machineCadClient && deps.boardIsLive) {
		app.post('/api/boards/:boardId/cad-machine/models', async (request, reply) => {
			const auth = authorizeMachine(request, reply, deps.writeLimiter, 'model')
			if (!auth) return reply
			const { placement, ...body } = machineCreateInput.parse(request.body)
			const model = await createModelEntry(auth, body, placement)
			request.log.info({ audit: 'cad.model.created', actor: auth.actor.userId, boardId: auth.boardId, modelRecordId: model.id, modelId: model.modelId, pageId: placement.pageId }, 'machine CAD model created')
			return reply.code(201).send({ model, card: { id: `shape:cad_${model.id.slice(`${CAD_MODEL_TYPE}:`.length)}`, pageId: placement.pageId, x: placement.x, y: placement.y, ...CAD_CARD_SIZE } })
		})
	}

	app.post('/api/boards/:boardId/cad-models/:recordId/revisions', async (request, reply) => {
		const auth = authorize(request, reply, deps.writeLimiter, 'cad')
		if (!auth) return reply
		const { recordId } = request.params as { recordId: string }
		const body = revisionInput.parse(request.body)
		const revision = await revisionFrom(auth.boardId, body)
		const model = mutate(getRoomHandle(auth.boardId), auth.actor, 'cad.revision.added', { modelRecordId: `${CAD_MODEL_TYPE}:${recordId}`, revisionId: revision.id }, (txn) =>
			appendCadRevision(loadModel(txn, recordId), revision, auth.actor, Date.now()))
		return reply.code(201).send({ model })
	})

	app.post('/api/boards/:boardId/cad-models/:recordId/revisions/:revisionId/status', async (request, reply) => {
		const auth = authorize(request, reply, deps.writeLimiter, 'cad')
		if (!auth) return reply
		const { recordId, revisionId } = request.params as { recordId: string; revisionId: string }
		const body = statusInput.parse(request.body)
		const model = mutate(getRoomHandle(auth.boardId), auth.actor, 'cad.revision.status_changed', { modelRecordId: `${CAD_MODEL_TYPE}:${recordId}`, revisionId, to: body.to }, (txn) =>
			transitionCadRevision(loadModel(txn, recordId), revisionId, body.to, auth.actor, body.note, Date.now()))
		return { model }
	})

	/** The lookup the link rules use to confirm a component exists on this board, read from the same transaction. */
	const lookupIn = (txn: StorageTxn) => (id: string): CadModel | undefined => {
		const parsed = CAD_MODEL_RECORD_ID.test(id) ? cadModelSchema.safeParse(txn.get(id)) : null
		return parsed?.success ? parsed.data : undefined
	}

	app.post('/api/boards/:boardId/cad-models/:recordId/revisions/:revisionId/links', async (request, reply) => {
		const auth = authorize(request, reply, deps.writeLimiter, 'cad')
		if (!auth) return reply
		const { recordId, revisionId } = request.params as { recordId: string; revisionId: string }
		const body = linkInput.parse(request.body)
		const model = mutate(getRoomHandle(auth.boardId), auth.actor, 'cad.component.linked', { modelRecordId: `${CAD_MODEL_TYPE}:${recordId}`, revisionId, partKey: body.partKey, componentModelRecordId: body.modelRecordId, componentRevisionId: body.revisionId }, (txn) =>
			addCadComponentLink(loadModel(txn, recordId), revisionId, body, lookupIn(txn), auth.actor, Date.now()))
		return reply.code(201).send({ model })
	})

	app.delete('/api/boards/:boardId/cad-models/:recordId/revisions/:revisionId/links/:partKey', async (request, reply) => {
		const auth = authorize(request, reply, deps.writeLimiter, 'cad')
		if (!auth) return reply
		const { recordId, revisionId, partKey } = request.params as { recordId: string; revisionId: string; partKey: string }
		if (!CAD_PART_KEY.test(partKey)) return reply.code(400).send({ error: 'Invalid part key' })
		const model = mutate(getRoomHandle(auth.boardId), auth.actor, 'cad.component.unlinked', { modelRecordId: `${CAD_MODEL_TYPE}:${recordId}`, revisionId, partKey }, (txn) =>
			removeCadComponentLink(loadModel(txn, recordId), revisionId, partKey, auth.actor, Date.now()))
		return { model }
	})

	app.post('/api/boards/:boardId/cad-models/:recordId/comments', async (request, reply) => {
		const auth = authorize(request, reply, deps.writeLimiter, 'cad')
		if (!auth) return reply
		const { recordId } = request.params as { recordId: string }
		const body = commentInput.parse(request.body)
		const model = mutate(getRoomHandle(auth.boardId), auth.actor, 'cad.comment.added', { modelRecordId: `${CAD_MODEL_TYPE}:${recordId}`, revisionId: body.revisionId }, (txn) =>
			addCadComment(loadModel(txn, recordId), { id: newId('cmt'), revisionId: body.revisionId, body: body.body }, auth.actor, Date.now()))
		return reply.code(201).send({ model })
	})

	app.post('/api/boards/:boardId/cad-models/:recordId/evidence', async (request, reply) => {
		const auth = authorize(request, reply, deps.writeLimiter, 'cad')
		if (!auth) return reply
		const { recordId } = request.params as { recordId: string }
		const body = evidenceInput.parse(request.body)
		const model = mutate(getRoomHandle(auth.boardId), auth.actor, 'cad.evidence.added', { modelRecordId: `${CAD_MODEL_TYPE}:${recordId}`, kind: body.kind }, (txn) => {
			// A link must point at something on this board; it is never a dangling or cross-board reference.
			if (body.kind === 'entity' && (txn.get(body.ref ?? '') as { typeName?: string } | undefined)?.typeName !== 'engineering_entity') throw new CadModelError('That engineering entity is not on this board', 404)
			if (body.kind === 'asset' && !(body.ref && deps.assetBelongsToBoard(body.ref, auth.boardId))) throw new CadModelError('That file is not on this board', 404)
			return addCadEvidence(loadModel(txn, recordId), { id: newId('evd'), kind: body.kind, label: body.label, ...(body.ref ? { ref: body.ref } : {}) }, auth.actor, Date.now())
		})
		return reply.code(201).send({ model })
	})
}

interface StorageTxn {
	get(id: string): unknown
	set(id: string, record: TLRecord): void
	values(): Iterable<unknown>
}
