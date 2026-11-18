import { useEffect, useMemo, useRef, useState } from 'react'
import { useValue, type Editor } from 'tldraw'
import {
	CAD_STATUS_LABELS,
	latestCadRevision,
	type CadModel,
	type CadRevision,
} from '../../shared/cad-model'
import { alternativeChoice, hiddenForIsolation, partDepths, withAlternativeChoice } from './assembly-view'
import type { AlternativeGroups } from './explode-layout'
import { linkCadComponent, unlinkCadComponent } from './cad-api'

interface CadAssemblySectionProps {
	model: CadModel
	revision: CadRevision
	editor: Editor
	canEdit: boolean
	selectedKey: string | null
	onSelect: (key: string | null) => void
	hidden: ReadonlySet<string>
	onHidden: (hidden: ReadonlySet<string>) => void
	explosion: number
	onExplosion: (value: number) => void
	/** Groups the file puts in the same place, found by the viewer from the loaded geometry. Empty until it has loaded. */
	alternatives?: readonly AlternativeGroups[]
	busy: boolean
	run: (task: () => Promise<unknown>, after?: () => void) => Promise<void>
}

/**
 * Parts, bill of materials and component links for an assembly revision.
 * The tree, hide, isolate and explode controls are for looking only, so anyone who can open the review can use them.
 * Linking components changes the record, so it is offered only to editors, only on a draft, and the server decides.
 */
export function CadAssemblySection({ model, revision, editor, canEdit, selectedKey, onSelect, hidden, onHidden, explosion, onExplosion, alternatives = [], busy, run }: CadAssemblySectionProps) {
	const assembly = revision.assembly!
	const depth = useMemo(() => partDepths(assembly.parts), [assembly])
	const byKey = useMemo(() => new Map(assembly.parts.map((part) => [part.key, part])), [assembly])
	const bomByKey = useMemo(() => new Map(assembly.bom.map((row) => [row.partKey, row])), [assembly])
	const links = revision.links ?? []
	const linkByPart = new Map(links.map((link) => [link.partKey, link]))
	const models = useValue('cad models', () => editor.store.allRecords().filter((record) => (record.typeName as string) === 'cad_model') as unknown as CadModel[], [editor])
	const [linkPart, setLinkPart] = useState('')
	const [linkModel, setLinkModel] = useState('')
	const [linkRevision, setLinkRevision] = useState('')
	const targets = models.filter((item) => item.id !== model.id)
	const chosen = targets.find((item) => item.id === linkModel)
	const canLink = canEdit && revision.status === 'draft'
	const selected = selectedKey ? byKey.get(selectedKey) : undefined
	const selectedRow = selectedKey ? bomByKey.get(selectedKey) : undefined
	const meshParts = assembly.parts.filter((part) => part.mesh).length
	const named = assembly.parts.filter((part) => part.named).length
	// The server records verified component groups only when the file's grouping is complete; without them there is nothing honest to move.
	const canExplode = (assembly.explode?.length ?? 0) >= 2
	const groups = assembly.explode ?? []
	// Picking a part in the 3D view brings its row into sight in the tree; the whole tree stays listed.
	const treeRef = useRef<HTMLUListElement | null>(null)
	useEffect(() => { treeRef.current?.querySelector('li.selected')?.scrollIntoView?.({ block: 'nearest' }) }, [selectedKey])
	const toggleHidden = (key: string) => { const next = new Set(hidden); if (next.has(key)) next.delete(key); else next.add(key); onHidden(next) }

	const linkState = (link: (typeof links)[number]) => {
		const component = models.find((item) => item.id === link.modelRecordId)
		const pinned = component?.revisions.find((item) => item.id === link.revisionId)
		return { component, pinned, newer: component && pinned ? latestCadRevision(component).number > pinned.number : false }
	}
	const notApproved = links.filter((link) => linkState(link).pinned?.status !== 'approved').length

	return <section className="cad-assembly" aria-label="Assembly">
		<h3>Assembly</h3>
		<p className="cad-muted">{assembly.parts.length} nodes in the file ({meshParts} with geometry, {named} named). The structure is read from the GLB by the server. It is not checked against the STEP file.</p>

		{canExplode ? <>
			<h4>Component groups ({groups.length})</h4>
			<ul className="cad-group-list" aria-label="Component groups">
				{groups.map((key) => {
					const group = byKey.get(key)
					if (!group) return null
					const isHidden = hidden.has(key)
					const twin = alternatives.find((pair) => pair.keys.includes(key))
					return <li key={key} className={key === selectedKey ? 'selected' : ''}>
						<button type="button" className="cad-part-name" onClick={() => onSelect(key === selectedKey ? null : key)} aria-pressed={key === selectedKey}>{group.name}</button>
						{twin ? <span className="cad-part-badge cad-same-place" title={`The file places ${twin.names[0]} and ${twin.names[1]} in the same place. Which one belongs there is not stated and has not been verified.`}>same place as {twin.names[twin.keys[0] === key ? 1 : 0]}</span> : null}
						<button type="button" className="cad-part-toggle" onClick={() => toggleHidden(key)} aria-label={`${isHidden ? 'Show' : 'Hide'} group ${group.name}`} aria-pressed={isHidden}>{isHidden ? 'Show' : 'Hide'}</button>
					</li>
				})}
			</ul>
			<p className="cad-muted">The groups the exploded view moves. Every individual part is still listed in the tree below.</p>
			{alternatives.map((pair) => {
				const choice = alternativeChoice(hidden, pair.keys)
				const name = `same-place-${pair.keys.join('-')}`
				const options: [Exclude<typeof choice, 'custom'>, string][] = [['both', 'Show both, as the file supplies them'], ['first', `${pair.names[0]} only`], ['second', `${pair.names[1]} only`]]
				return <fieldset key={name} className="cad-alternatives">
					<legend>Two models in the same place (not verified)</legend>
					<p>The file contains both {pair.names[0]} and {pair.names[1]}, and they occupy almost the same place: {Math.round(pair.overlap * 100)}% of the smaller one's box lies inside the other's. The file does not say whether they are alternatives or which one is fitted, and this review has not verified it. Nothing is removed or moved: this only changes which of them is drawn here.</p>
					{options.map(([value, label]) => <label key={value}><input type="radio" name={name} checked={choice === value} onChange={() => onHidden(withAlternativeChoice(hidden, pair.keys, value))} />{label}</label>)}
					{choice === 'custom' ? <p className="cad-muted">Both are hidden from the tree. Pick an option to show them again.</p> : null}
				</fieldset>
			})}
		</> : null}

		<h4>Parts</h4>
		<ul className="cad-part-tree" ref={treeRef}>
			{assembly.parts.map((part) => {
				const isHidden = hidden.has(part.key)
				return <li key={part.key} className={part.key === selectedKey ? 'selected' : ''} style={{ paddingLeft: (depth.get(part.key) ?? 0) * 14 }}>
					<button type="button" className="cad-part-toggle" onClick={() => toggleHidden(part.key)}
						aria-label={`${isHidden ? 'Show' : 'Hide'} ${part.name}`} aria-pressed={isHidden}>{isHidden ? 'Show' : 'Hide'}</button>
					<button type="button" className={`cad-part-name${part.named ? '' : ' unnamed'}`} onClick={() => onSelect(part.key === selectedKey ? null : part.key)} aria-pressed={part.key === selectedKey}>{part.name}</button>
					<span className="cad-part-badge" title={part.stable ? 'The file gave this part its own identity.' : 'The file gave this part no identity. The key is only its position in this file, and may change if the model is exported again.'}>{part.stable ? 'id' : 'no id'}</span>
				</li>
			})}
		</ul>

		<div className="cad-part-controls">
			<button type="button" disabled={!selectedKey} onClick={() => selectedKey && onHidden(hiddenForIsolation(assembly.parts, selectedKey))}>Isolate selected</button>
			<button type="button" onClick={() => { onHidden(new Set()); onSelect(null); onExplosion(0) }}>Show all and reset</button>
		</div>
		<label className="cad-explode">Exploded view, for review only ({canExplode ? Math.round(explosion * 100) : 0}%)
			<input type="range" min={0} max={100} step={1} value={canExplode ? Math.round(explosion * 100) : 0} disabled={!canExplode} onChange={(event) => onExplosion(Number(event.target.value) / 100)} aria-label="Exploded view" />
		</label>
		{canExplode
			? <p className="cad-caution">This is a visualization, not a mate, fit, clearance or disassembly check. Each of the {groups.length} component groups the file marks moves as one unit along a straight line chosen for legibility, with a gap kept between groups. Nothing is measured or validated, and nothing stored changes: not the model, the file, the revision, its approval or the bill of materials. Use Fit exploded view in the viewer to frame the result.</p>
			: <p className="cad-caution cad-explode-off">Exploded view requires verified component grouping for this model.</p>}

		{selected ? <div className="cad-part-detail" aria-live="polite">
			<strong>{selected.name}</strong>
			<span>Key: {selected.key}{selected.stable ? '' : ' (file gave no identity)'}</span>
			{selectedRow ? <span>Declared in the file: {selectedRow.partNumber}, quantity {selectedRow.quantity}</span> : <span>No part number or quantity is declared for this part.</span>}
			{linkByPart.get(selected.key) ? <span>Linked component: {linkState(linkByPart.get(selected.key)!).component?.name ?? 'unavailable'}</span> : null}
		</div> : null}

		<h4>Bill of materials</h4>
		{assembly.bom.length ? <>
			<table className="cad-bom"><thead><tr><th>Part number</th><th>Part</th><th>Qty</th></tr></thead>
				<tbody>{assembly.bom.map((row) => <tr key={row.partKey}><td>{row.partNumber}</td><td>{byKey.get(row.partKey)?.name ?? row.partKey}{row.description ? <small>{row.description}</small> : null}</td><td>{row.quantity}</td></tr>)}</tbody></table>
			<p className="cad-muted">{assembly.bom.length} of {named} named nodes declare a part number and quantity in the file. Quantities are copied as declared. They are not counted from the geometry or checked against the STEP file, so this is not a manufacturing BOM.</p>
		</> : <p className="cad-empty">The file declares no part numbers or quantities, so there is no bill of materials. Anonymous parts are never given one.</p>}

		<h4>Components</h4>
		<p className="cad-muted">A link points a part at one exact revision of another model on this board. It records a reference only. {CAD_STATUS_LABELS[revision.status]} here is the status of this assembly revision. Approving the assembly does not approve its components, and a component keeps its own status.</p>
		{links.length ? <ul className="cad-link-list">
			{links.map((link) => {
				const { component, pinned, newer } = linkState(link)
				return <li key={link.partKey}>
					<strong>{byKey.get(link.partKey)?.name ?? link.partKey}</strong>
					<span> → {component ? component.name : 'a model that is no longer on the board'}{pinned ? `, Rev ${pinned.number}` : ''}</span>
					{pinned ? <span className={`cad-status cad-status-${pinned.status}`} title="Review status of that component revision, separate from this assembly">Component: {CAD_STATUS_LABELS[pinned.status]}</span> : null}
					{newer ? <small>A newer revision of this component exists. This link still points at Rev {pinned!.number}.</small> : null}
					{canLink ? <button type="button" disabled={busy} onClick={() => void run(() => unlinkCadComponent(model.id, revision.id, link.partKey))}>Remove</button> : null}
				</li>
			})}
		</ul> : <p className="cad-empty">No components linked yet.</p>}
		{links.length && notApproved ? <p className="cad-muted">{notApproved} of {links.length} linked component revisions are not approved. That does not stop this assembly from being reviewed on its own.</p> : null}
		{revision.status !== 'draft' && canEdit ? <p className="cad-muted">Links are fixed once the revision leaves draft. Add a new revision to change them.</p> : null}
		{canLink ? <div className="cad-link-form">
			<label>Part<select value={linkPart} onChange={(event) => setLinkPart(event.target.value)}><option value="">Choose…</option>{assembly.parts.filter((part) => part.named).map((part) => <option key={part.key} value={part.key}>{part.name}</option>)}</select></label>
			<label>Component model<select value={linkModel} onChange={(event) => { setLinkModel(event.target.value); setLinkRevision('') }}><option value="">Choose…</option>{targets.map((item) => <option key={item.id} value={item.id}>{item.name} ({item.modelId})</option>)}</select></label>
			<label>Component revision<select value={linkRevision} onChange={(event) => setLinkRevision(event.target.value)} disabled={!chosen}><option value="">Choose…</option>{chosen?.revisions.map((item) => <option key={item.id} value={item.id}>Rev {item.number} ({CAD_STATUS_LABELS[item.status]})</option>)}</select></label>
			<button type="button" className="cad-primary" disabled={busy || !linkPart || !linkModel || !linkRevision} onClick={() => void run(() => linkCadComponent(model.id, revision.id, { partKey: linkPart, modelRecordId: linkModel, revisionId: linkRevision }), () => { setLinkPart(''); setLinkRevision('') })}>Link component</button>
			{!targets.length ? <p className="cad-empty">Add another CAD model to the board to link it here.</p> : null}
		</div> : null}
	</section>
}
