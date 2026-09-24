import { createHash, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { z } from 'zod'

const clientSchema = z.object({
	name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
	tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
	rooms: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,80}$/)).min(1).max(50),
	permissions: z.array(z.enum(['read', 'write', 'history', 'restore'])).min(1).max(4),
}).strict()
const tokenFileSchema = z.object({ clients: z.array(clientSchema).max(100) }).strict()

export type ApiPermission = 'read' | 'write' | 'history' | 'restore'

export function authorizeApiToken(header: string | undefined, roomId: string, permission: ApiPermission): string | null {
	const match = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(header ?? '')
	if (!match) return null
	const file = process.env.CANVAS_API_TOKENS_FILE
	if (!file) return null
	let clients: z.infer<typeof clientSchema>[]
	try { clients = tokenFileSchema.parse(JSON.parse(readFileSync(file, 'utf8'))).clients }
	catch { return null }
	const digest = createHash('sha256').update(match[1]).digest()
	for (const client of clients) {
		const stored = Buffer.from(client.tokenHash, 'hex')
		if (timingSafeEqual(digest, stored) && client.rooms.includes(roomId) && client.permissions.includes(permission)) return client.name
	}
	return null
}
