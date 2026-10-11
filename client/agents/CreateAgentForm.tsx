import { type FormEvent, useState } from 'react'
import {
	ACCESS_LEVELS,
	EXPIRY_CHOICES,
	INITIAL_CREATE_FORM,
	chooseAccess,
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
	boardName: string
	busy: boolean
	onCreate(input: { displayName: string; access: AccessLevel; expiresAt?: string }): void
	/** Starting values, for tests. */
	initial?: Partial<CreateForm>
	now?: number
}

export function CreateAgentForm({ boardName, busy, onCreate, initial, now = Date.now() }: CreateAgentFormProps) {
	const [form, setForm] = useState<CreateForm>({ ...INITIAL_CREATE_FORM, ...initial })
	const [message, setMessage] = useState<string | null>(null)
	const dangerous = isDangerous(form.access)

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
		<h2 id="aw-create-title">Give an agent access to “{boardName}”</h2>
		<label>
			<span>Name</span>
			<input value={form.displayName} maxLength={80} onChange={(event) => setForm({ ...form, displayName: event.target.value })} placeholder="Claude, Chibi notes" autoComplete="off" />
			<small>Shown in this list, so pick something you will recognise. (History lists the agent's changes under a generated identifier, not this name.)</small>
		</label>
		<fieldset>
			<legend>What can it do?</legend>
			{ACCESS_LEVELS.map((level) => <label className="aw-agents-choice" key={level.value}>
				<input type="radio" name="access" value={level.value} checked={form.access === level.value} onChange={() => setForm(chooseAccess(form, level.value))} />
				<span><strong>{level.label}</strong><small>{level.summary}</small></span>
			</label>)}
		</fieldset>
		{dangerous ? <div className="aw-agents-warning aw-agents-danger" role="alert">
			<strong>This includes restore.</strong> {RESTORE_WARNING}
			<label className="aw-agents-ack">
				<input type="checkbox" checked={form.restoreAcknowledged} onChange={(event) => setForm({ ...form, restoreAcknowledged: event.target.checked })} />
				<span>I understand, and I want this agent to be able to restore the whiteboard</span>
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
