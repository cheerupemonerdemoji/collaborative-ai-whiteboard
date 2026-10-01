import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import {
	ENTITY_FIELD_SPECS,
	ENTITY_TYPES,
	RELATION_TYPES,
	defaultStatusFor,
	statusValuesFor,
	type EngineeringEntity,
	type EntityFieldSpec,
	type EntityType,
	type RelationType,
	type SemanticAction,
} from '../../shared/entities'
import type { EvidenceTable, EvidenceTableSummary } from '../../shared/evidence-tables'
import { createEvidenceTable, fetchEvidenceTable, parseCsvToTable } from './evidenceTables'
import { fetchSemanticContext, formatApiError, formatScalarMapText, parseScalarMapText, postSemanticActions } from './semanticApi'
import '../account-history.css'
import './semantic-inspector.css'

interface Props {
	boardId: string
	/** Precomputed the same way HistoryPanel's canRestore is: true for editor and owner, false for viewer. */
	canEdit: boolean
	onClose: () => void
}

type FieldValues = Record<string, string>

function slugify(value: string): string {
	return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-|-$/g, '').slice(0, 70) || 'entity'
}

function entityLabel(entityType: EntityType): string {
	return entityType.charAt(0).toUpperCase() + entityType.slice(1)
}

function shortId(id: string): string {
	return id.startsWith('engineering_entity:') ? id.slice('engineering_entity:'.length) : id
}

function emptyFieldValues(entityType: EntityType): FieldValues {
	const values: FieldValues = {}
	for (const spec of ENTITY_FIELD_SPECS[entityType]) values[spec.key] = ''
	return values
}

function fieldValuesFromEntity(entity: EngineeringEntity): FieldValues {
	const values: FieldValues = {}
	const record = entity as unknown as Record<string, unknown>
	for (const spec of ENTITY_FIELD_SPECS[entity.entityType]) {
		const raw = record[spec.key]
		if (spec.kind === 'scalarMap') values[spec.key] = formatScalarMapText(raw as Record<string, unknown> | undefined)
		else values[spec.key] = typeof raw === 'string' ? raw : raw == null ? '' : String(raw)
	}
	return values
}

type CreateEntityAction = Extract<SemanticAction, { tool: 'create_entity' }>
type UpdateEntityAction = Extract<SemanticAction, { tool: 'update_entity' }>
type LinkEntitiesAction = Extract<SemanticAction, { tool: 'link_entities' }>
type UnlinkEntitiesAction = Extract<SemanticAction, { tool: 'unlink_entities' }>

/**
 * Turns the form's raw strings back into the shape `create_entity`/`update_entity` expect.
 *
 * `update_entity`'s server-side merge (`applyUpdateEntity` in server/canvas-api.ts) only ever
 * adds or overwrites the keys present in `fields` -- an omitted key leaves the entity's existing
 * value untouched. So a blank text/longText/scalarMap field must still be sent (as `''` / `{}`)
 * for editing to actually clear it, not omitted. Enum fields are the one exception: `''` is not
 * a valid value for an optional enum per the schema (only a listed option or absent), and there
 * is no value that means "clear this enum back to unset" in this API at all -- so a blank enum
 * selection is always omitted, on both create and edit, which leaves an existing value alone
 * rather than sending a request the server would reject.
 */
export function fieldsForSubmit(entityType: EntityType, values: FieldValues): NonNullable<CreateEntityAction['fields']> {
	const fields: NonNullable<CreateEntityAction['fields']> = {}
	for (const spec of ENTITY_FIELD_SPECS[entityType]) {
		const raw = values[spec.key] ?? ''
		if (spec.kind === 'scalarMap') {
			fields[spec.key] = parseScalarMapText(raw)
			continue
		}
		if (spec.kind === 'enum') {
			if (raw.trim() === '') continue
			fields[spec.key] = raw
			continue
		}
		fields[spec.key] = raw
	}
	return fields
}

function FieldInput({ spec, value, onChange }: { spec: EntityFieldSpec; value: string; onChange: (next: string) => void }) {
	if (spec.kind === 'enum') {
		return <select value={value} onChange={(event) => onChange(event.target.value)} required={spec.required}>
			<option value="">{spec.required ? 'Choose one…' : '(none)'}</option>
			{spec.options?.map((option) => <option value={option} key={option}>{option}</option>)}
		</select>
	}
	if (spec.kind === 'longText') {
		return <textarea rows={3} value={value} onChange={(event) => onChange(event.target.value)} required={spec.required} />
	}
	if (spec.kind === 'scalarMap') {
		return <textarea rows={3} placeholder={'one per line, e.g.\nseed: 7\nfrequency_hz: 0.25'} value={value} onChange={(event) => onChange(event.target.value)} />
	}
	return <input type="text" value={value} onChange={(event) => onChange(event.target.value)} required={spec.required} maxLength={2000} />
}

function EntityForm({ entityType, values, onChange, skipKeys }: { entityType: EntityType; values: FieldValues; onChange: (key: string, value: string) => void; skipKeys?: ReadonlySet<string> }) {
	return <>{ENTITY_FIELD_SPECS[entityType].filter((spec) => !skipKeys?.has(spec.key)).map((spec) => (
		<label key={spec.key}>
			<span>{spec.label}{spec.required ? ' *' : ''}</span>
			<FieldInput spec={spec} value={values[spec.key] ?? ''} onChange={(next) => onChange(spec.key, next)} />
		</label>
	))}</>
}

interface TableResult { uploadId: string; summary: EvidenceTableSummary }

/**
 * Replaces the plain `reference` text input when Evidence.kind === 'table': paste CSV, build
 * (validates client-side for fast feedback, then stores through the real authorized/validated
 * POST /api/boards/:boardId/evidence-tables route - the server's response, not the client's own
 * guess, is what becomes tableSummary; see docs/development/structured-evidence-design.md's
 * DeepSeek review disposition for finding #4).
 */
function EvidenceTableEditor({ boardId, existingReference, onReady }: { boardId: string; existingReference?: string; onReady: (result: TableResult | null) => void }) {
	const [csvText, setCsvText] = useState('')
	const [warnings, setWarnings] = useState<string[]>([])
	const [error, setError] = useState<string | null>(null)
	const [building, setBuilding] = useState(false)
	const [result, setResult] = useState<TableResult | null>(null)

	async function build() {
		setError(null)
		let parsed: { table: EvidenceTable; warnings: string[] }
		try {
			parsed = parseCsvToTable(csvText)
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : 'Could not parse that as CSV.')
			return
		}
		setBuilding(true)
		try {
			const created = await createEvidenceTable(boardId, parsed.table)
			setWarnings(parsed.warnings)
			setResult(created)
			onReady(created)
		} catch (caught) {
			setError(formatApiError(caught))
			onReady(null)
		} finally {
			setBuilding(false)
		}
	}

	return <div className="aw-inspector-table-editor">
		<label><span>Structured table (paste CSV - first row is column headers)</span>
			<textarea rows={4} placeholder={'frequency_hz,support_margin_mm,result\n0.16,5.22,PASS\n0.17,4.95,FAIL'} value={csvText} onChange={(event) => setCsvText(event.target.value)} />
		</label>
		<div><button type="button" onClick={() => void build()} disabled={building || !csvText.trim()}>{building ? 'Building…' : 'Build table'}</button></div>
		{error ? <p className="aw-inspector-error" role="alert">{error}</p> : null}
		{warnings.map((warning, index) => <p key={index} className="aw-inspector-table-warning">{warning}</p>)}
		{result ? <p className="aw-inspector-table-ready">Ready: {result.summary.rows} row(s) × {result.summary.columns.length} column(s) ({result.summary.columns.join(', ')}).</p> : null}
		{!result && existingReference ? <p className="aw-inspector-table-warning">Leave blank to keep the existing table ({existingReference}).</p> : null}
	</div>
}

function TableView({ boardId, uploadId }: { boardId: string; uploadId: string }) {
	const [table, setTable] = useState<EvidenceTable | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [loading, setLoading] = useState(true)

	useEffect(() => {
		let cancelled = false
		setLoading(true)
		setError(null)
		fetchEvidenceTable(boardId, uploadId)
			.then((loaded) => { if (!cancelled) setTable(loaded) })
			.catch((caught) => { if (!cancelled) setError(caught instanceof Error ? caught.message : 'Could not load the table.') })
			.finally(() => { if (!cancelled) setLoading(false) })
		return () => { cancelled = true }
	}, [boardId, uploadId])

	if (loading) return <p className="aw-inspector-empty-inline">Loading table…</p>
	if (error) return <p className="aw-inspector-error" role="alert">{error}</p>
	if (!table) return null
	return <table className="aw-inspector-table">
		<thead><tr>{table.columns.map((column) => <th key={column.key}>{column.label}{column.unit ? <span> ({column.unit})</span> : null}</th>)}</tr></thead>
		<tbody>{table.rows.map((row, index) => <tr key={index}>{table.columns.map((column) => <td key={column.key}>{row[column.key] ?? ''}</td>)}</tr>)}</tbody>
	</table>
}

/** The Evidence detail view's structured-data section, visually separate from the entity's own
 * narrative fields (note, rationale, …) so measured data and interpretation are never conflated. */
function EvidenceTableSection({ boardId, reference, summary }: { boardId: string; reference: string; summary: EvidenceTableSummary }) {
	const [open, setOpen] = useState(false)
	return <div className="aw-inspector-table-section">
		<h4>Structured table</h4>
		<p className="aw-inspector-meta">{summary.rows} row(s) × {summary.columns.length} column(s) ({summary.columns.join(', ')})</p>
		<button type="button" onClick={() => setOpen((value) => !value)}>{open ? 'Hide table' : 'View table'}</button>
		{open ? <TableView boardId={boardId} uploadId={reference} /> : null}
	</div>
}

export function SemanticInspectorPanel({ boardId, canEdit, onClose }: Props) {
	const [entities, setEntities] = useState<EngineeringEntity[] | null>(null)
	const [loadError, setLoadError] = useState<string | null>(null)
	const [selectedId, setSelectedId] = useState<string | null>(null)
	const [typeFilter, setTypeFilter] = useState<EntityType | 'all'>('all')
	const [statusFilter, setStatusFilter] = useState<string>('all')
	const [creating, setCreating] = useState(false)
	const [editing, setEditing] = useState(false)
	const [busy, setBusy] = useState(false)
	const [formError, setFormError] = useState<string | null>(null)

	const [createType, setCreateType] = useState<EntityType>('component')
	const [createTitle, setCreateTitle] = useState('')
	const [createIdSuffix, setCreateIdSuffix] = useState('')
	const [createIdTouched, setCreateIdTouched] = useState(false)
	const [createStatus, setCreateStatus] = useState<string>(defaultStatusFor('component'))
	const [createValues, setCreateValues] = useState<FieldValues>(() => emptyFieldValues('component'))
	const [createTableResult, setCreateTableResult] = useState<TableResult | null>(null)

	const [editTitle, setEditTitle] = useState('')
	const [editStatus, setEditStatus] = useState('')
	const [editValues, setEditValues] = useState<FieldValues>({})
	const [editTableResult, setEditTableResult] = useState<TableResult | null>(null)

	const [relOpen, setRelOpen] = useState(false)
	const [relType, setRelType] = useState<RelationType>(RELATION_TYPES[0])
	const [relTarget, setRelTarget] = useState('')

	const load = useCallback(async () => {
		setLoadError(null)
		try {
			const result = await fetchSemanticContext(boardId)
			setEntities(result.entities)
			return result.entities
		} catch (caught) {
			setEntities(null)
			setLoadError(formatApiError(caught))
			return null
		}
	}, [boardId])

	useEffect(() => { void load() }, [load])

	const entitiesById = useMemo(() => new Map((entities ?? []).map((entity) => [entity.id, entity])), [entities])
	const selected = selectedId ? entitiesById.get(selectedId) ?? null : null

	const visibleEntities = useMemo(() => {
		return (entities ?? []).filter((entity) =>
			(typeFilter === 'all' || entity.entityType === typeFilter) &&
			(statusFilter === 'all' || entity.status === statusFilter)
		)
	}, [entities, typeFilter, statusFilter])

	const statusesPresent = useMemo(() => [...new Set((entities ?? []).map((entity) => entity.status))].sort(), [entities])

	const grouped = useMemo(() => {
		const byType = new Map<EntityType, EngineeringEntity[]>()
		for (const entity of visibleEntities) {
			if (!byType.has(entity.entityType)) byType.set(entity.entityType, [])
			byType.get(entity.entityType)!.push(entity)
		}
		return ENTITY_TYPES.filter((type) => byType.has(type)).map((type) => ({ type, items: byType.get(type)! }))
	}, [visibleEntities])

	function openCreate() {
		setFormError(null)
		setEditing(false)
		setCreateType('component')
		setCreateTitle('')
		setCreateIdSuffix('')
		setCreateIdTouched(false)
		setCreateStatus(defaultStatusFor('component'))
		setCreateValues(emptyFieldValues('component'))
		setCreateTableResult(null)
		setCreating(true)
	}

	function changeCreateType(nextType: EntityType) {
		setCreateType(nextType)
		setCreateStatus(defaultStatusFor(nextType))
		setCreateValues(emptyFieldValues(nextType))
		setCreateTableResult(null)
	}

	const isTableEvidence = (entityType: EntityType, values: FieldValues) => entityType === 'evidence' && values.kind === 'table'

	async function submitCreate(event: FormEvent) {
		event.preventDefault()
		setFormError(null)
		if (isTableEvidence(createType, createValues) && !createTableResult) {
			setFormError('Build the table before creating this entity.')
			return
		}
		const id = `engineering_entity:${createIdSuffix || slugify(createTitle)}`
		setBusy(true)
		try {
			const fields = fieldsForSubmit(createType, createValues)
			if (createTableResult) fields.reference = createTableResult.uploadId
			const action: CreateEntityAction = {
				tool: 'create_entity',
				id,
				entityType: createType,
				title: createTitle,
				status: createStatus,
				fields,
				...(createTableResult ? { tableSummary: createTableResult.summary } : {}),
			}
			await postSemanticActions(boardId, [action])
			setCreating(false)
			await load()
			setSelectedId(id)
		} catch (caught) {
			setFormError(formatApiError(caught))
		} finally {
			setBusy(false)
		}
	}

	function openEdit() {
		if (!selected) return
		setFormError(null)
		setCreating(false)
		setEditTitle(selected.title)
		setEditStatus(selected.status)
		setEditValues(fieldValuesFromEntity(selected))
		setEditTableResult(null)
		setEditing(true)
	}

	async function submitEdit(event: FormEvent) {
		event.preventDefault()
		if (!selected) return
		setFormError(null)
		setBusy(true)
		try {
			const fields = fieldsForSubmit(selected.entityType, editValues)
			if (editTableResult) fields.reference = editTableResult.uploadId
			// If the user didn't rebuild the table, `editValues.reference` still holds the
			// entity's existing reference (openEdit pre-filled it, and the input is hidden for
			// kind: 'table' rather than cleared) - fieldsForSubmit already carries it through
			// unchanged. tableSummary is only included when a new table was actually built, so
			// omitting it here (not sending `tableSummary: undefined`) leaves the entity's
			// existing summary untouched via the server's patch-merge semantics.
			const action: UpdateEntityAction = {
				tool: 'update_entity',
				id: selected.id,
				title: editTitle,
				status: editStatus,
				fields,
				...(editTableResult ? { tableSummary: editTableResult.summary } : {}),
			}
			await postSemanticActions(boardId, [action])
			setEditing(false)
			const refreshed = await load()
			// An edit that archives the entity (or otherwise drops it out of the default,
			// non-archived semantic-context read) leaves it out of `refreshed`. Clear the
			// selection explicitly rather than leaving `selectedId` pointing at nothing.
			if (refreshed && !refreshed.some((entity) => entity.id === selected.id)) setSelectedId(null)
		} catch (caught) {
			setFormError(formatApiError(caught))
		} finally {
			setBusy(false)
		}
	}

	async function submitRelation(event: FormEvent) {
		event.preventDefault()
		if (!selected || !relTarget) return
		setFormError(null)
		setBusy(true)
		try {
			const action: LinkEntitiesAction = { tool: 'link_entities', id: selected.id, relationType: relType, targetId: relTarget }
			await postSemanticActions(boardId, [action])
			setRelOpen(false)
			setRelTarget('')
			await load()
		} catch (caught) {
			setFormError(formatApiError(caught))
		} finally {
			setBusy(false)
		}
	}

	async function removeRelation(relationType: RelationType, targetId: string) {
		if (!selected) return
		setFormError(null)
		setBusy(true)
		try {
			const action: UnlinkEntitiesAction = { tool: 'unlink_entities', id: selected.id, relationType, targetId }
			await postSemanticActions(boardId, [action])
			await load()
		} catch (caught) {
			setFormError(formatApiError(caught))
		} finally {
			setBusy(false)
		}
	}

	return <aside className="aw-history-panel aw-inspector-panel" aria-label="Semantic entities">
		<header className="aw-history-header">
			<div><h2>Semantic entities</h2><p>Components, requirements, experiments, evidence, decisions, and tasks tracked on this board.</p></div>
			<button className="aw-icon-button" onClick={onClose} aria-label="Close semantic entities">×</button>
		</header>

		<div className="aw-history-actions">
			<button onClick={() => void load()}>Refresh</button>
			{canEdit ? <button onClick={openCreate}>＋ New entity</button> : null}
		</div>

		{loadError ? <p className="aw-inspector-error" role="alert">{loadError}</p> : null}

		{creating ? <form className="aw-inspector-form" onSubmit={(event) => void submitCreate(event)}>
			<h3>New entity</h3>
			<label><span>Type</span>
				<select value={createType} onChange={(event) => changeCreateType(event.target.value as EntityType)}>
					{ENTITY_TYPES.map((type) => <option value={type} key={type}>{entityLabel(type)}</option>)}
				</select>
			</label>
			<label><span>Title *</span><input type="text" required maxLength={200} value={createTitle} onChange={(event) => { setCreateTitle(event.target.value); if (!createIdTouched) setCreateIdSuffix(slugify(event.target.value)) }} /></label>
			<label><span>ID (technical, must be unique)</span>
				<div className="aw-inspector-id-row"><code>engineering_entity:</code><input type="text" value={createIdSuffix} onChange={(event) => { setCreateIdTouched(true); setCreateIdSuffix(slugify(event.target.value)) }} /></div>
			</label>
			<label><span>Status</span>
				<select value={createStatus} onChange={(event) => setCreateStatus(event.target.value)}>
					{statusValuesFor(createType).map((status) => <option value={status} key={status}>{status}</option>)}
				</select>
			</label>
			<EntityForm entityType={createType} values={createValues} skipKeys={isTableEvidence(createType, createValues) ? new Set(['reference']) : undefined} onChange={(key, value) => setCreateValues((prev) => ({ ...prev, [key]: value }))} />
			{isTableEvidence(createType, createValues) ? <EvidenceTableEditor boardId={boardId} onReady={setCreateTableResult} /> : null}
			{formError ? <p className="aw-inspector-error" role="alert">{formError}</p> : null}
			<div><button type="button" onClick={() => setCreating(false)}>Cancel</button><button className="aw-primary-button" disabled={busy}>{busy ? 'Creating…' : 'Create entity'}</button></div>
		</form> : null}

		{editing && selected ? <form className="aw-inspector-form" onSubmit={(event) => void submitEdit(event)}>
			<h3>Edit {entityLabel(selected.entityType)}</h3>
			<label><span>Title *</span><input type="text" required maxLength={200} value={editTitle} onChange={(event) => setEditTitle(event.target.value)} /></label>
			<label><span>Status</span>
				<select value={editStatus} onChange={(event) => setEditStatus(event.target.value)}>
					{statusValuesFor(selected.entityType).map((status) => <option value={status} key={status}>{status}</option>)}
				</select>
			</label>
			<EntityForm entityType={selected.entityType} values={editValues} skipKeys={isTableEvidence(selected.entityType, editValues) ? new Set(['reference']) : undefined} onChange={(key, value) => setEditValues((prev) => ({ ...prev, [key]: value }))} />
			{isTableEvidence(selected.entityType, editValues) ? <EvidenceTableEditor boardId={boardId} existingReference={(selected as unknown as { reference?: string }).reference} onReady={setEditTableResult} /> : null}
			{formError ? <p className="aw-inspector-error" role="alert">{formError}</p> : null}
			<div><button type="button" onClick={() => setEditing(false)}>Cancel</button><button className="aw-primary-button" disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button></div>
		</form> : null}

		{!creating && !editing ? <div className="aw-inspector-filters">
			<label><span>Type</span>
				<select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value as EntityType | 'all')}>
					<option value="all">All types</option>
					{ENTITY_TYPES.map((type) => <option value={type} key={type}>{entityLabel(type)}</option>)}
				</select>
			</label>
			<label><span>Status</span>
				<select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
					<option value="all">All statuses</option>
					{statusesPresent.map((status) => <option value={status} key={status}>{status}</option>)}
				</select>
			</label>
		</div> : null}

		{!creating && !editing ? <div className="aw-inspector-body">
			{entities === null && !loadError ? <p className="aw-inspector-empty">Loading…</p> : null}
			{entities !== null && entities.length === 0 ? <div className="aw-inspector-empty">
				<p><strong>No semantic entities yet.</strong></p>
				<p>Semantic entities are real engineering records — components, requirements,
				experiments, evidence, decisions, and tasks — that live alongside this board's
				canvas shapes but are tracked separately, with their own relationships and
				history. They do not draw anything on the canvas.</p>
				{canEdit ? <p>Use “＋ New entity” above to create the first one.</p> : null}
			</div> : null}
			{entities !== null && entities.length > 0 && grouped.length === 0 ? <div className="aw-inspector-empty">
				<p><strong>No entities match this filter.</strong></p>
				<p>This board has {entities.length} semantic {entities.length === 1 ? 'entity' : 'entities'} in
				total; none of them match the current type/status filter. Archived entities are
				never shown here - change the filter above to see more.</p>
			</div> : null}

			{!selected ? <div className="aw-inspector-list">
				{grouped.map((group) => <section key={group.type}>
					<h4>{entityLabel(group.type)} ({group.items.length})</h4>
					{group.items.map((entity) => <button key={entity.id} className="aw-inspector-row" onClick={() => setSelectedId(entity.id)}>
						<span className="aw-inspector-row-title">{entity.title}</span>
						<span className={`aw-inspector-status aw-inspector-status-${entity.status}`}>{entity.status}</span>
					</button>)}
				</section>)}
			</div> : null}

			{selected ? <div className="aw-inspector-detail">
				<button className="aw-inspector-back" onClick={() => setSelectedId(null)}>← Back to list</button>
				<h3>{selected.title}</h3>
				<p className="aw-inspector-meta">{entityLabel(selected.entityType)} · <span className={`aw-inspector-status aw-inspector-status-${selected.status}`}>{selected.status}</span> · <code>{shortId(selected.id)}</code></p>

				<dl className="aw-inspector-fields">
					{ENTITY_FIELD_SPECS[selected.entityType].map((spec) => {
						const raw = (selected as unknown as Record<string, unknown>)[spec.key]
						if (raw === undefined) return null
						const display = spec.kind === 'scalarMap' ? formatScalarMapText(raw as Record<string, unknown>) : String(raw)
						if (!display.trim()) return null
						return <div key={spec.key}><dt>{spec.label}</dt><dd>{display}</dd></div>
					})}
				</dl>

				{selected.entityType === 'evidence' && (selected as unknown as { tableSummary?: EvidenceTableSummary }).tableSummary ? <EvidenceTableSection boardId={boardId} reference={(selected as unknown as { reference: string }).reference} summary={(selected as unknown as { tableSummary: EvidenceTableSummary }).tableSummary} /> : null}

				{canEdit ? <button onClick={openEdit} disabled={busy}>Edit entity</button> : null}

				<h4>Relationships</h4>
				{selected.relations.length === 0 ? <p className="aw-inspector-empty-inline">No relationships yet.</p> : <ul className="aw-inspector-relations">
					{selected.relations.map((relation) => {
						const target = entitiesById.get(relation.targetId)
						return <li key={`${relation.type}:${relation.targetId}`}>
							<span className="aw-inspector-rel-type">{relation.type}</span>
							<span>{target ? `${target.title} (${entityLabel(target.entityType)})` : shortId(relation.targetId)}</span>
							{canEdit ? <button className="aw-icon-button" aria-label="Remove relationship" onClick={() => void removeRelation(relation.type, relation.targetId)} disabled={busy}>×</button> : null}
						</li>
					})}
				</ul>}

				{canEdit ? (relOpen ? <form className="aw-inspector-relation-form" onSubmit={(event) => void submitRelation(event)}>
					<label><span>Relationship</span>
						<select value={relType} onChange={(event) => setRelType(event.target.value as RelationType)}>
							{RELATION_TYPES.map((type) => <option value={type} key={type}>{type}</option>)}
						</select>
					</label>
					<label><span>Target entity</span>
						<select value={relTarget} onChange={(event) => setRelTarget(event.target.value)} required>
							<option value="">Choose…</option>
							{(entities ?? []).filter((entity) => entity.id !== selected.id).map((entity) => <option value={entity.id} key={entity.id}>{entity.title} ({entityLabel(entity.entityType)})</option>)}
						</select>
					</label>
					{formError ? <p className="aw-inspector-error" role="alert">{formError}</p> : null}
					<div><button type="button" onClick={() => setRelOpen(false)}>Cancel</button><button className="aw-primary-button" disabled={busy}>{busy ? 'Linking…' : 'Add relationship'}</button></div>
				</form> : <button onClick={() => { setFormError(null); setRelOpen(true) }} disabled={busy}>＋ Add relationship</button>) : null}
			</div> : null}
		</div> : null}
	</aside>
}
