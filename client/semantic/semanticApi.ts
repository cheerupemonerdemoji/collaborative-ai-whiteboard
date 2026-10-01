import type { EngineeringEntity, SemanticAction } from '../../shared/entities'
import { ApiError, apiRequest } from '../auth'

export interface SemanticContextResponse {
	roomId: string
	entities: EngineeringEntity[]
}

/** Every inspector read goes through the same authorized endpoint a human/AI action already uses. */
export function fetchSemanticContext(boardId: string): Promise<SemanticContextResponse> {
	return apiRequest<SemanticContextResponse>(`/api/rooms/${encodeURIComponent(boardId)}/semantic-context`)
}

/**
 * Every inspector write goes through the same `/actions` endpoint and the same `SemanticAction`
 * union as any other client of the AI/canvas action API -- there is no separate inspector-side
 * mutation path, so server validation, RBAC, rate limits, and history all apply exactly as they
 * do today.
 */
export function postSemanticActions(boardId: string, actions: SemanticAction[]): Promise<{ applied: number; clock: number }> {
	return apiRequest(`/api/rooms/${encodeURIComponent(boardId)}/actions`, {
		method: 'POST',
		body: JSON.stringify({ actions }),
	})
}

interface ZodIssueLike {
	path?: unknown
	message?: unknown
}

/**
 * Surfaces the server's actual per-field validation message instead of the generic "Invalid
 * request" string. `ApiError.details` is the whole parsed response body (see `apiRequest` in
 * ../auth), and for a Zod validation failure that body is `{ error, details: ZodIssue[] }` (see
 * the `ZodError` branch of server/app.ts's error handler) -- so the real issue list is one level
 * down, at `error.details.details`, not at `error.details` itself.
 */
export function formatApiError(error: unknown): string {
	if (error instanceof ApiError) {
		const body = error.details
		const issueList = Array.isArray(body) ? body : isRecord(body) && Array.isArray(body.details) ? body.details : null
		if (issueList && issueList.length) {
			const issues = (issueList as ZodIssueLike[])
				.map((issue) => {
					const path = Array.isArray(issue.path) ? issue.path.join('.') : ''
					const message = typeof issue.message === 'string' ? issue.message : ''
					return path ? `${path}: ${message}` : message
				})
				.filter(Boolean)
			if (issues.length) return issues.join('; ')
		}
		return error.message
	}
	return error instanceof Error ? error.message : 'Something went wrong.'
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Parses the inspector's plain "key: value" per-line textarea into the scalar map the server expects. */
export function parseScalarMapText(text: string): Record<string, string | number | boolean | null> {
	const result: Record<string, string | number | boolean | null> = {}
	for (const rawLine of text.split('\n')) {
		const line = rawLine.trim()
		if (!line) continue
		const separatorIndex = line.indexOf(':')
		const key = (separatorIndex === -1 ? line : line.slice(0, separatorIndex)).trim()
		const rawValue = separatorIndex === -1 ? '' : line.slice(separatorIndex + 1).trim()
		if (!key) continue
		if (rawValue === '') result[key] = ''
		else if (rawValue === 'true') result[key] = true
		else if (rawValue === 'false') result[key] = false
		else if (rawValue === 'null') result[key] = null
		// Number.isFinite, not just !isNaN: the server's genericScalar requires a finite number
		// (z.number().finite()), so "Infinity"/"-Infinity" must fall through to a plain string
		// rather than becoming a value the server would reject with an otherwise-confusing 422.
		else if (rawValue !== '' && Number.isFinite(Number(rawValue))) result[key] = Number(rawValue)
		else result[key] = rawValue
	}
	return result
}

/** The inverse of parseScalarMapText, for pre-filling the edit form from an existing record. */
export function formatScalarMapText(value: Record<string, unknown> | undefined): string {
	if (!value) return ''
	return Object.entries(value).map(([key, entryValue]) => `${key}: ${String(entryValue)}`).join('\n')
}
