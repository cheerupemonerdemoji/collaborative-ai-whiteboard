import { type FormEvent, useState } from 'react'
import {
	ACCESS_LEVELS,
	CREATOR_ACCESS_NOTE,
	CREATOR_DEFAULT_ACCESS,
	CREATOR_NOTICE,
	CREATOR_RESTORE_WARNING,
	EXPIRY_CHOICES,
	INITIAL_CREATE_FORM,
	chooseAccess,
	chooseCreator,
	RESTORE_WARNING,
	isDangerous,
	validateCreate,
	type AccessLevel,
	type CreateForm,
	type ExpiryChoice,
} from './agents-model'

/** The date input's lower bound: tomorrow, in the owner's time zone. */
function tomorrow(now: number): string {
	const date = new Date(now + 86_400_000)
	const pad = (value: number) => String(value).padStart(2, '0')
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export interface CreateAgentFormProps {
	/** The whiteboard an existing-board agent would get; null when the person owns none, which leaves only the other type. */
	boardName: string | null
	busy: boolean
	onCreate(input: { displayName: string; access: AccessLevel; expiresAt?: string; creator?: true }): void
	/** Starting values, for tests. */
	initial?: Partial<CreateForm>
	now?: number
}

export function CreateAgentForm({ boardName, busy, onCreate, initial, now = Date.now() }: CreateAgentFormProps) {
	const [form, setForm] = useState<CreateForm>(() => {
		const start = { ...INITIAL_CREATE_FORM, ...initial }
		// With no whiteboard of their own, the only thing to create is an agent that makes its own.
		return boardName === null && !start.creator ? chooseCreator(start, true) : start
	})
	const [message, setMessage] = useState<string | null>(null)
	const dangerous = isDangerous(form.access)
	const creator = form.creator

	function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		const result = validateCreate(form, Date.now())
		if (!result.ok) {
			setMessage(result.message)
			return
		}
		setMessage(null)
		onCreate(result.input)
	}

	return <form className="aw-agents-form" onSubmit={submit} aria-labelledby="aw-create-title">
		<h2 id="aw-create-title">{creator ? 'Create an agent that makes new whiteboards' : `Give an agent access to “${boardName}”`}</h2>
		<fieldset>
			<legend>What is it for?</legend>
			<label className="aw-agents-choice">
				<input type="radio" name="agent-kind" value="existing" checked={!creator} disabled={boardName === null} onChange={() => setForm(chooseCreator(form, false))} />
				<span>
					<strong>An existing whiteboard</strong>
					<small>{boardName === null ? 'You do not own a whiteboard yet.' : `Work on “${boardName}” only.`}</small>
				</span>
			</label>
			<label className="aw-agents-choice">
				<input type="radio" name="agent-kind" value="creator" checked={creator} onChange={() => setForm(chooseCreator(form, true))} />
				<span>
					<strong>Create new whiteboards</strong>
					<small>{CREATOR_NOTICE}</small>
				</span>
			</label>
		</fieldset>
		<label>
			<span>Name</span>
			<input value={form.displayName} maxLength={80} onChange={(event) => setForm({ ...form, displayName: event.target.value })} placeholder="Claude, Chibi notes" autoComplete="off" />
			<small>Shown in this list, so pick something you will recognise. (History lists the agent's changes under a generated identifier, not this name.)</small>
		</label>
		<fieldset>
			<legend>{creator ? 'What can it do on the whiteboards it creates?' : 'What can it do?'}</legend>
			{creator ? <p className="aw-muted aw-agents-note">{CREATOR_ACCESS_NOTE}</p> : null}
			{ACCESS_LEVELS.map((level) => <label className="aw-agents-choice" key={level.value}>
				<input type="radio" name="access" value={level.value} checked={form.access === level.value} onChange={() => setForm(chooseAccess(form, level.value))} />
				<span>
					<strong>{level.label}{creator && level.value === CREATOR_DEFAULT_ACCESS ? ' (recommended)' : ''}</strong>
					<small>{level.summary}</small>
				</span>
			</label>)}
		</fieldset>
		{dangerous ? <div className="aw-agents-warning aw-agents-danger" role="alert">
			<strong>This includes restore.</strong> {creator ? CREATOR_RESTORE_WARNING : RESTORE_WARNING}
			<label className="aw-agents-ack">
				<input type="checkbox" checked={form.restoreAcknowledged} onChange={(event) => setForm({ ...form, restoreAcknowledged: event.target.checked })} />
				<span>{creator ? 'I understand, and I want this agent to be able to restore every whiteboard it creates' : 'I understand, and I want this agent to be able to restore the whiteboard'}</span>
			</label>
		</div> : null}
		<fieldset>
			<legend>How long should it last?</legend>
			<select aria-label="Expiry" value={form.expiry} onChange={(event) => setForm({ ...form, expiry: event.target.value as ExpiryChoice })}>
				{EXPIRY_CHOICES.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
			</select>
			{form.expiry === 'custom' ? <input type="date" aria-label="Last day of access" min={tomorrow(now)} value={form.customDate} onChange={(event) => setForm({ ...form, customDate: event.target.value })} /> : null}
			<small>{form.expiry === 'never' ? 'With no expiry the token stays valid until you revoke it.' : 'After this the token stops working on its own. You can rotate it to extend it.'}</small>
		</fieldset>
		{message ? <div className="aw-error" role="alert">{message}</div> : null}
		<div className="aw-agents-form-actions">
			<button className="aw-primary-button" disabled={busy || (dangerous && !form.restoreAcknowledged)}>{busy ? 'Creating…' : 'Create access'}</button>
		</div>
	</form>
}
