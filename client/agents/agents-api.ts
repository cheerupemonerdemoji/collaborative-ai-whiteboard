import { apiRequest } from '../auth'
import type { AccessLevel, Agent, AgentConnection, OwnedBoard, Permission } from './agents-model'

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

/**
 * Every board that is still in use, for the site owner (the administrator), who may manage agents on any of them.
 * The server refuses `scope=all` to anyone else, so call this only when the signed-in account is an administrator.
 */
export async function listAllBoardsAsSiteOwner(): Promise<OwnedBoard[]> {
	const { boards } = await apiRequest<{ boards: BoardSummary[] }>('/api/boards?scope=all')
	return boards.filter((board) => !board.deletedAt).map((board) => ({ id: board.id, name: board.name }))
}

export async function listAgents(boardId: string): Promise<Agent[]> {
	const { agents } = await apiRequest<{ agents: Agent[] }>(`/api/agent-access?boardId=${encodeURIComponent(boardId)}`)
	return agents
}

/** Where an agent sends its requests, and whether it also needs a Cloudflare Access pair to get there. */
export async function getAgentApiOrigin(): Promise<AgentConnection> {
	const { agentApiOrigin, viaCloudflare, agentGuideUrl } = await apiRequest<{ agentApiOrigin: string; viaCloudflare: boolean; agentGuideUrl: string }>('/api/agent-access/config')
	return { apiOrigin: agentApiOrigin, viaCloudflare, guideUrl: agentGuideUrl }
}

/** The caller's own board-creating agents, including ones that have not created a whiteboard yet. */
export async function listBoardCreators(): Promise<Agent[]> {
	const { agents } = await apiRequest<{ agents: Agent[] }>('/api/agent-access?scope=creators')
	return agents
}

export interface CreateBoardCreatorInput {
	displayName: string
	access: AccessLevel
	expiresAt?: string
}

/** Registers an agent and provisions its first, same-named whiteboard owned by the caller. */
export function createBoardCreator(input: CreateBoardCreatorInput): Promise<AgentWithToken & { board: OwnedBoard }> {
	return apiRequest<AgentWithToken & { board: OwnedBoard }>('/api/agent-access', { method: 'POST', body: JSON.stringify({ kind: 'board-creator', ...input }) })
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

export interface AccessChangeSummary {
	previous: Permission[]
	current: Permission[]
	added: Permission[]
	removed: Permission[]
}

export interface RotateChange {
	access: AccessLevel
	/** Required by the server when the change adds restore. */
	acknowledgeRestore?: true
}

/**
 * `ref` is the opaque handle from the listing. Omit `expiresAt` to keep the current expiry. Pass `change` to replace the bearer AND change the
 * access in one step (the previous bearer stops working at once); omit it and the access stays exactly as it is.
 */
export function rotateAgent(ref: string, expiresAt?: string, change?: RotateChange): Promise<AgentWithToken & { accessChange?: AccessChangeSummary }> {
	return apiRequest<AgentWithToken & { accessChange?: AccessChangeSummary }>(`/api/agent-access/${encodeURIComponent(ref)}/rotate`, {
		method: 'POST',
		body: JSON.stringify({ ...(expiresAt === undefined ? {} : { expiresAt }), ...(change ? { access: change.access, ...(change.acknowledgeRestore ? { acknowledgeRestore: true } : {}) } : {}) }),
	})
}

export async function revokeAgent(ref: string): Promise<void> {
	await apiRequest(`/api/agent-access/${encodeURIComponent(ref)}`, { method: 'DELETE' })
}
