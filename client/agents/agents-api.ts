import { apiRequest } from '../auth'
import type { AccessLevel, Agent, OwnedBoard } from './agents-model'

/**
 * Calls to the owner-only agent management API (server/agent-access.ts). The session cookie carries
 * authentication, exactly as for every other page; nothing here ever sets an Authorization header.
 *
 * Functions that return a bearer token (`createAgent`, `rotateAgent`) hand it straight to the caller and keep
 * no copy. They do not log, cache or persist anything, and the caller is expected to put the token in component
 * memory only (see `tokenReducer`).
 */

interface BoardSummary {
	id: string
	name: string
	role: 'owner' | 'editor' | 'viewer'
	deletedAt?: number | string | null
}

/** The boards this person owns and can still use. Only owners can manage agents, and a deleted board has nothing to manage. */
export async function listOwnedBoards(): Promise<OwnedBoard[]> {
	const { boards } = await apiRequest<{ boards: BoardSummary[] }>('/api/boards')
	return boards.filter((board) => board.role === 'owner' && !board.deletedAt).map((board) => ({ id: board.id, name: board.name }))
}

export async function listAgents(boardId: string): Promise<Agent[]> {
	const { agents } = await apiRequest<{ agents: Agent[] }>(`/api/agent-access?boardId=${encodeURIComponent(boardId)}`)
	return agents
}

export interface CreateAgentInput {
	boardId: string
	displayName: string
	access: AccessLevel
	expiresAt?: string
}

export interface AgentWithToken {
	agent: Agent
	/** Plaintext bearer. Exists only in this response. */
	token: string
}

export function createAgent(input: CreateAgentInput): Promise<AgentWithToken> {
	return apiRequest<AgentWithToken>('/api/agent-access', { method: 'POST', body: JSON.stringify(input) })
}

/** `ref` is the opaque handle from the listing. Omit `expiresAt` to keep the current expiry. */
export function rotateAgent(ref: string, expiresAt?: string): Promise<AgentWithToken> {
	return apiRequest<AgentWithToken>(`/api/agent-access/${encodeURIComponent(ref)}/rotate`, {
		method: 'POST',
		body: JSON.stringify(expiresAt === undefined ? {} : { expiresAt }),
	})
}

export async function revokeAgent(ref: string): Promise<void> {
	await apiRequest(`/api/agent-access/${encodeURIComponent(ref)}`, { method: 'DELETE' })
}
