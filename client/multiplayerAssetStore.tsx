import { TLAssetStore, uniqueId } from 'tldraw'

function resolveAsset(asset: Parameters<NonNullable<TLAssetStore['resolve']>>[0]) {
	// Resolve already-stored source URLs unchanged; server authorization controls access.
	return asset.props.src
}

/** Read-only resolver retained for historical snapshots and older imports. */
export const multiplayerAssetStore: TLAssetStore = {
	async upload() {
		throw new Error('A board is required before an asset can be uploaded.')
	},
	resolve: resolveAsset,
}

/** Uploads through the authenticated board route while storing the stable legacy read URL. */
export function createMultiplayerAssetStore(boardId: string): TLAssetStore {
	const encodedBoardId = encodeURIComponent(boardId)
	return {
		async upload(_asset, file) {
			const objectName = `${uniqueId()}-${file.name}`.replace(/[^a-zA-Z0-9._-]/g, '-')
			const uploadUrl = `/api/boards/${encodedBoardId}/uploads/${encodeURIComponent(objectName)}`
			const src = `/api/boards/${encodedBoardId}/assets/${encodeURIComponent(objectName)}`
			const response = await fetch(uploadUrl, {
				method: 'POST',
				body: file,
				credentials: 'same-origin',
				headers: { 'Content-Type': file.type || 'application/octet-stream' },
			})
			if (!response.ok) throw new Error(`Failed to upload asset (${response.status})`)
			return { src }
		},
		resolve: resolveAsset,
	}
}
