import { z } from 'zod'

/**
 * IDs use the `engineering_entity:` prefix, not the `entity:` prefix originally sketched in
 * docs/chibi-robo/whiteboard-integration-plan.md. @tldraw/store's RecordType ties a record's
 * store id to its typeName (`RecordType.createId`/`isId`/`parseId` all assume
 * `${typeName}:${suffix}`); fighting that convention would only work by accident. The
 * namespace-separation goal the plan cared about (semantic IDs distinct from `shape:` IDs) is
 * fully preserved -- only the literal prefix string differs from the original sketch.
 */
export const ENTITY_ID_PATTERN = /^engineering_entity:[a-z0-9_-]{1,80}$/
export const entityId = z.string().regex(ENTITY_ID_PATTERN, 'Expected an engineering_entity: id')

const shapeIdField = z.string().regex(/^shape:[A-Za-z0-9_-]{1,80}$/)
const title = z.string().trim().min(1).max(200)
const shortText = z.string().trim().max(2000)
const auditActor = z.string().trim().min(1).max(120)
const timestamp = z.number().int().nonnegative()

export const ENTITY_TYPES = [
	'component',
	'interface',
	'requirement',
	'task',
	'experiment',
	'decision',
	'risk',
	'evidence',
] as const
export type EntityType = (typeof ENTITY_TYPES)[number]

export const RELATION_TYPES = [
	'contains',
	'connects_to',
	'satisfies',
	'tests',
	'blocks',
	'depends_on',
	'mitigates',
	'supported_by',
] as const
export type RelationType = (typeof RELATION_TYPES)[number]

const relation = z.object({ type: z.enum(RELATION_TYPES), targetId: entityId }).strict()
// Bounded per docs/chibi-robo/whiteboard-integration-plan.md's one-hop, non-graph-language constraint.
const relations = z.array(relation).max(20)

export const TEST_TYPES = ['simulation', 'physical'] as const
export const EVIDENCE_KINDS = [
	'git_commit',
	'file_path',
	'cad_file',
	'simulation_file',
	'image',
	'graph',
	'document',
	'url',
	/** A structured result table (shared/evidence-tables.ts), stored as a validated JSON
	 * artifact through the board asset system. `reference` holds the artifact's upload id. */
	'table',
] as const

/**
 * Safe references only, per the plan and CLAUDE.md: the server never dereferences, fetches,
 * previews, checksums, or executes any evidence reference. A file_path/cad_file/simulation_file
 * reference is stored and displayed as an opaque label, never opened locally. A url reference
 * must be https and is never fetched server-side -- these constraints are structural (no code
 * path anywhere calls fs/child_process/fetch on this string), not just a validation nicety.
 */
const evidenceReference = z
	.string()
	.trim()
	.min(1)
	.max(2000)
	.regex(/^[^\x00-\x1f]+$/, 'Evidence references may not contain control characters')
	.superRefine((value, ctx) => {
		if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^https:\/\//i.test(value)) {
			ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Only https:// URLs are accepted as URL-shaped evidence references' })
		}
	})

/** Small bounded scalar bag for experiment parameters/metrics -- not a general-purpose JSON blob. */
const boundedScalarMap = z
	.record(
		z.string().min(1).max(60),
		z.union([z.string().max(500), z.number().finite(), z.boolean(), z.null()])
	)
	.refine((value) => Object.keys(value).length <= 30, 'At most 30 fields')

const STATUS_BY_TYPE = {
	component: ['proposed', 'active', 'deprecated', 'archived'],
	interface: ['proposed', 'active', 'deprecated', 'archived'],
	requirement: ['draft', 'approved', 'satisfied', 'violated', 'archived'],
	task: ['open', 'in_progress', 'blocked', 'done', 'archived'],
	experiment: ['planned', 'running', 'completed', 'inconclusive', 'archived'],
	decision: ['proposed', 'decided', 'superseded', 'archived'],
	risk: ['open', 'mitigated', 'accepted', 'closed', 'archived'],
	evidence: ['active', 'archived'],
} as const satisfies Record<EntityType, readonly string[]>

/** V1 has no hard-delete action. Archiving (via `update_status`) is the only removal path, so a
 * relation's targetId is always resolvable -- there is never a dangling reference to clean up. */
export const ARCHIVED_STATUS = 'archived'

function baseFields<Type extends EntityType>(entityType: Type, status: z.ZodEnum<any>) {
	return {
		typeName: z.literal('engineering_entity'),
		id: entityId,
		entityType: z.literal(entityType),
		shapeId: shapeIdField.optional(),
		title,
		status,
		relations,
		createdBy: auditActor,
		updatedBy: auditActor,
		createdAt: timestamp,
		updatedAt: timestamp,
	}
}

const componentEntity = z.object({
	...baseFields('component', z.enum(STATUS_BY_TYPE.component)),
	subsystem: z.string().trim().max(80).optional(),
	description: shortText.optional(),
}).strict()

const interfaceEntity = z.object({
	...baseFields('interface', z.enum(STATUS_BY_TYPE.interface)),
	kind: z.enum(['mechanical', 'electrical', 'data', 'power', 'control']).optional(),
	description: shortText.optional(),
}).strict()

const requirementEntity = z.object({
	...baseFields('requirement', z.enum(STATUS_BY_TYPE.requirement)),
	statement: shortText.optional(),
}).strict()

const taskEntity = z.object({
	...baseFields('task', z.enum(STATUS_BY_TYPE.task)),
	owner: z.string().trim().max(120).optional(),
	description: shortText.optional(),
}).strict()

const experimentEntity = z.object({
	...baseFields('experiment', z.enum(STATUS_BY_TYPE.experiment)),
	objective: shortText.optional(),
	hypothesis: shortText.optional(),
	testType: z.enum(TEST_TYPES).optional(),
	parameters: boundedScalarMap.optional(),
	metrics: boundedScalarMap.optional(),
	passCriteria: shortText.optional(),
	result: shortText.optional(),
	// relatedComponents/relatedRequirements are expressed via `relations` (tests/satisfies) --
	// no parallel id-list field, per the already-settled "one canonical evidence linkage" rule.
}).strict()

const decisionEntity = z.object({
	...baseFields('decision', z.enum(STATUS_BY_TYPE.decision)),
	rationale: shortText.optional(),
}).strict()

const riskEntity = z.object({
	...baseFields('risk', z.enum(STATUS_BY_TYPE.risk)),
	likelihood: z.enum(['low', 'medium', 'high']).optional(),
	impact: z.enum(['low', 'medium', 'high']).optional(),
	mitigation: shortText.optional(),
}).strict()

/**
 * Compact, bounded metadata for a `kind: 'table'` evidence artifact (shared/evidence-tables.ts),
 * so semantic-context (and an AI reading it) can know a table exists, its size, and its column
 * names without fetching the artifact. This is advisory, not authoritative: the server never
 * verifies it matches the real artifact at entity-write time (crossing into the asset store from
 * the semantic-action path is a boundary this design deliberately does not cross - see
 * docs/development/structured-evidence-design.md). The Inspector always sets it from the same
 * server response that validated the table, never independently.
 */
const tableSummary = z.object({
	rows: z.number().int().nonnegative(),
	columns: z.array(z.string().max(100)).max(20), // 20 matches EVIDENCE_TABLE_LIMITS.maxColumns
}).strict()

const evidenceEntity = z.object({
	...baseFields('evidence', z.enum(STATUS_BY_TYPE.evidence)),
	kind: z.enum(EVIDENCE_KINDS),
	reference: evidenceReference,
	note: shortText.optional(),
	tableSummary: tableSummary.optional(),
}).strict()

export const engineeringEntitySchema = z.discriminatedUnion('entityType', [
	componentEntity,
	interfaceEntity,
	requirementEntity,
	taskEntity,
	experimentEntity,
	decisionEntity,
	riskEntity,
	evidenceEntity,
])
export type EngineeringEntity = z.infer<typeof engineeringEntitySchema>

export function statusValuesFor(entityType: EntityType): readonly string[] {
	return STATUS_BY_TYPE[entityType]
}

export function defaultStatusFor(entityType: EntityType): string {
	return STATUS_BY_TYPE[entityType][0]
}

/**
 * Client field metadata for a schema-aware create/edit form, colocated with (and only ever
 * changed alongside) the `*Entity` Zod schemas above rather than introspected via Zod internals
 * or duplicated in a separate client-side validation layer. This describes shape only -- which
 * generic keys exist per entity type, and how to render an input for each -- never validation.
 * The server's `engineeringEntitySchema.parse` remains the sole source of truth for whether a
 * value is actually accepted; a form built from this metadata can still be rejected, and the
 * caller must surface that rejection rather than predict or bypass it.
 */
export type EntityFieldKind = 'text' | 'longText' | 'enum' | 'scalarMap'
export interface EntityFieldSpec {
	key: string
	label: string
	kind: EntityFieldKind
	required?: boolean
	options?: readonly string[]
}
const RISK_LEVELS = ['low', 'medium', 'high'] as const
const INTERFACE_KINDS = ['mechanical', 'electrical', 'data', 'power', 'control'] as const
export const ENTITY_FIELD_SPECS: Record<EntityType, readonly EntityFieldSpec[]> = {
	component: [
		{ key: 'subsystem', label: 'Subsystem', kind: 'text' },
		{ key: 'description', label: 'Description', kind: 'longText' },
	],
	interface: [
		{ key: 'kind', label: 'Kind', kind: 'enum', options: INTERFACE_KINDS },
		{ key: 'description', label: 'Description', kind: 'longText' },
	],
	requirement: [
		{ key: 'statement', label: 'Statement', kind: 'longText' },
	],
	task: [
		{ key: 'owner', label: 'Owner', kind: 'text' },
		{ key: 'description', label: 'Description', kind: 'longText' },
	],
	experiment: [
		{ key: 'objective', label: 'Objective', kind: 'longText' },
		{ key: 'hypothesis', label: 'Hypothesis', kind: 'longText' },
		{ key: 'testType', label: 'Test type', kind: 'enum', options: TEST_TYPES },
		{ key: 'parameters', label: 'Parameters', kind: 'scalarMap' },
		{ key: 'metrics', label: 'Metrics', kind: 'scalarMap' },
		{ key: 'passCriteria', label: 'Pass criteria', kind: 'longText' },
		{ key: 'result', label: 'Result', kind: 'longText' },
	],
	decision: [
		{ key: 'rationale', label: 'Rationale', kind: 'longText' },
	],
	risk: [
		{ key: 'likelihood', label: 'Likelihood', kind: 'enum', options: RISK_LEVELS },
		{ key: 'impact', label: 'Impact', kind: 'enum', options: RISK_LEVELS },
		{ key: 'mitigation', label: 'Mitigation', kind: 'longText' },
	],
	evidence: [
		{ key: 'kind', label: 'Kind', kind: 'enum', options: EVIDENCE_KINDS, required: true },
		{ key: 'reference', label: 'Reference', kind: 'text', required: true },
		{ key: 'note', label: 'Note', kind: 'longText' },
	],
}

/* ---------------------------------------------------------- semantic actions -- */

/**
 * Deliberately separate from shared/ai.ts's canvasActionSchema (zero changes made to that
 * file or its 8 visual actions) rather than folded into the same discriminated union.
 */
const genericScalar = z.union([z.string().max(2000), z.number().finite(), z.boolean(), z.null()])
const genericScalarMap = z
	.record(z.string().min(1).max(60), genericScalar)
	.refine((value) => Object.keys(value).length <= 30, 'At most 30 nested fields')
const genericFields = z
	.record(z.string().min(1).max(60), z.union([genericScalar, z.array(entityId).max(20), genericScalarMap]))
	.refine((value) => Object.keys(value).length <= 30, 'At most 30 fields')

const createEntity = z.object({
	tool: z.literal('create_entity'),
	id: entityId,
	entityType: z.enum(ENTITY_TYPES),
	shapeId: shapeIdField.optional(),
	title,
	status: z.string().max(40).optional(),
	fields: genericFields.optional(),
	// First-class, not part of `fields`: tableSummary's shape ({rows, columns: string[]}) does
	// not fit genericFields' scalar/scalar-map/entity-id-array union, the same way title/status
	// are first-class rather than squeezed through it.
	tableSummary: tableSummary.optional(),
}).strict()

const updateEntity = z.object({
	tool: z.literal('update_entity'),
	id: entityId,
	title: title.optional(),
	status: z.string().max(40).optional(),
	shapeId: shapeIdField.nullable().optional(),
	fields: genericFields.optional(),
	tableSummary: tableSummary.optional(),
}).strict()

const linkEntities = z.object({
	tool: z.literal('link_entities'),
	id: entityId,
	relationType: z.enum(RELATION_TYPES),
	targetId: entityId,
}).strict()

const unlinkEntities = z.object({
	tool: z.literal('unlink_entities'),
	id: entityId,
	relationType: z.enum(RELATION_TYPES),
	targetId: entityId,
}).strict()

/** Thin wrapper over the same update path as update_entity (fields.result [+ status]). */
const recordExperimentResult = z.object({
	tool: z.literal('record_experiment_result'),
	id: entityId,
	result: shortText,
	status: z.enum(STATUS_BY_TYPE.experiment).optional(),
}).strict()

/** Thin wrapper over link_entities with relationType fixed to 'supported_by'. */
const attachEvidence = z.object({
	tool: z.literal('attach_evidence'),
	id: entityId,
	evidenceId: entityId,
}).strict()

/** Thin wrapper over update_entity with only `status` set. */
const updateStatus = z.object({
	tool: z.literal('update_status'),
	id: entityId,
	status: z.string().max(40),
}).strict()

export const semanticActionSchema = z.discriminatedUnion('tool', [
	createEntity,
	updateEntity,
	linkEntities,
	unlinkEntities,
	recordExperimentResult,
	attachEvidence,
	updateStatus,
])
export const semanticActionsSchema = z.array(semanticActionSchema).min(1).max(30)
export type SemanticAction = z.infer<typeof semanticActionSchema>

/* ------------------------------------------------------------ context budgets -- */

export const SEMANTIC_CONTEXT_LIMITS = {
	maxEntities: 200,
	maxRelationshipEdges: 400,
	maxReferencedSummaries: 50,
	maxSerializedBytes: 200_000,
} as const

export const SEMANTIC_WRITE_LIMITS = {
	maxEntityBytes: 8_000,
	maxEntitiesPerBoard: 2_000,
} as const

export const semanticContextRequestSchema = z.object({
	entityTypes: z.array(z.enum(ENTITY_TYPES)).max(ENTITY_TYPES.length).optional(),
	status: z.array(z.string().max(40)).max(20).optional(),
	ids: z.array(entityId).max(SEMANTIC_CONTEXT_LIMITS.maxEntities).optional(),
	relationsFor: entityId.optional(),
	includeArchived: z.boolean().optional(),
}).strict()
export type SemanticContextRequest = z.infer<typeof semanticContextRequestSchema>
