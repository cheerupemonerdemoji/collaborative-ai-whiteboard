import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const file = process.env.CANVAS_API_TOKENS_FILE ?? join(homedir(), '.config', 'collaborative-ai-canvas', 'api-tokens.json')
const [command, name, roomList, access = 'read-write'] = process.argv.slice(2)
const validName = (value) => /^[A-Za-z0-9_-]{1,64}$/.test(value ?? '')
const validRoom = (value) => /^[A-Za-z0-9_-]{1,80}$/.test(value)
const accessModes = {
	read: ['read'],
	write: ['write'],
	'read-write': ['read', 'write'],
	'read-history': ['read', 'history'],
	full: ['read', 'write', 'history', 'restore'],
}

async function load() {
	try {
		const parsed = JSON.parse(await readFile(file, 'utf8'))
		if (!Array.isArray(parsed.clients)) throw new Error('Invalid token file')
		return parsed
	} catch (error) {
		if (error?.code === 'ENOENT') return { clients: [] }
		throw error
	}
}
async function save(data) {
	await mkdir(dirname(file), { recursive: true, mode: 0o700 })
	const temporary = `${file}.${randomUUID()}.tmp`
	await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
	await rename(temporary, file)
	await chmod(file, 0o600)
}

const data = await load()
if (command === 'create') {
	const rooms = roomList?.split(',') ?? []
	if (!validName(name) || rooms.length < 1 || rooms.length > 50 || !rooms.every(validRoom) || !(access in accessModes)) throw new Error('Usage: create <client-name> <room[,room...]> [read|write|read-write|read-history|full]')
	if (data.clients.some((client) => client.name === name)) throw new Error(`Client ${name} already exists; revoke it first to rotate the token`)
	const token = randomBytes(32).toString('base64url')
	data.clients.push({ name, tokenHash: createHash('sha256').update(token).digest('hex'), rooms, permissions: accessModes[access] })
	await save(data)
	console.log(`Token for ${name} (copy it now; only its hash is stored):\n${token}`)
} else if (command === 'revoke') {
	if (!validName(name)) throw new Error('Usage: revoke <client-name>')
	const before = data.clients.length
	data.clients = data.clients.filter((client) => client.name !== name)
	if (data.clients.length === before) throw new Error(`Client ${name} not found`)
	await save(data)
	console.log(`Revoked ${name}`)
} else if (command === 'list') {
	for (const client of data.clients) console.log(`${client.name}\t${client.rooms.join(',')}\t${client.permissions.join(',')}`)
} else {
	throw new Error('Usage: node scripts/manage-api-tokens.mjs create|revoke|list ...')
}
