import { apiRequest, ApiError } from '../auth'
import type { TelemetryView } from '../../shared/telemetry'

/*
 * Browser side of the read-only telemetry routes (server/telemetry-routes.ts). It only ever reads, and only through the
 * signed-in browser session: no token, key or credential of any kind exists on this side.
 */

export interface TelemetrySourceSummary { sourceId: string; machineName: string; simulated: boolean }

export type TelemetryFetchResult =
	| { kind: 'view'; view: TelemetryView }
	| { kind: 'not-found' }
	| { kind: 'failed' }

export async function fetchTelemetry(boardId: string, sourceId: string, signal?: AbortSignal): Promise<TelemetryFetchResult> {
	try {
		const view = await apiRequest<TelemetryView>(`/api/boards/${encodeURIComponent(boardId)}/telemetry/${encodeURIComponent(sourceId)}`, { signal })
		return { kind: 'view', view }
	} catch (error) {
		if (error instanceof ApiError && error.status === 404) return { kind: 'not-found' }
		return { kind: 'failed' }
	}
}

export async function listTelemetrySources(boardId: string): Promise<TelemetrySourceSummary[]> {
	const result = await apiRequest<{ sources: TelemetrySourceSummary[] }>(`/api/boards/${encodeURIComponent(boardId)}/telemetry`)
	return result.sources
}
