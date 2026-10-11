// Operator CLI for the machine-token store.
//
//   node scripts/manage-api-tokens.mjs create <client-name> <room[,room...]> [read|write|read-write|read-history|full] [--expires <Nd|Nh|ISO-8601 UTC>]
//   node scripts/manage-api-tokens.mjs revoke <client-name>
//   node scripts/manage-api-tokens.mjs list [--long]
//
// This file is argv parsing and printing only. Every destructive operation --
// locking, the pre-mutation backup, the atomic replace, metadata preservation
// -- lives in server/token-store.mjs, which the owner-only agent-access routes
// also call. Two writers with two copies of that logic is precisely how a
// production registration was destroyed once; there is now one copy.
//
// The shared module is plain JavaScript, so this script runs under a bare
// `node` with no TypeScript loader, no transpiler and no node_modules at all.
//
// The positional syntax, the usage strings and the output of every command
// WITHOUT the new flags are the operator-facing contract and are kept
// byte-identical to the pre-extraction version of this script. The two flags
// are purely additive:
//
//   --expires <value>   create only. The client stops authenticating at that
//                       instant. <value> is `30d` / `12h` (from now), or an
//                       absolute UTC timestamp such as 2027-01-31T00:00:00Z.
//                       Omit it and the client never expires, as before.
//   --long              list only. Appends createdAt, expiresAt and status
//                       columns. Plain `list` is unchanged.
//
// The argv checks duplicate the shared module's validation on purpose: the CLI
// owes the operator a usage message, while the module owes its callers a coded
// error. Both reject the same inputs.

import { ACCESS_MODES, createClient, describeClients, listClients, resolveStorePath, revokeClient } from '../server/token-store.mjs'

const CREATE_USAGE = 'Usage: create <client-name> <room[,room...]> [read|write|read-write|read-history|full]'
const CREATE_USAGE_WITH_EXPIRY = `${CREATE_USAGE} [--expires <Nd|Nh|ISO-8601 UTC>]`
const LIST_USAGE = 'Usage: list [--long]'

/**
 * Pull the two additive flags out of argv, leaving the positional arguments
 * exactly as they were. Anything else, including an unknown `--word`, stays
 * positional so existing inputs keep their existing behaviour.
 */
function splitArguments(raw) {
	const positional = []
	let expires
	let expiresWithoutValue = false
	let long = false
	for (let index = 0; index < raw.length; index += 1) {
		const argument = raw[index]
		if (argument === '--expires') {
			const value = raw[index + 1]
			if (value === undefined || value.startsWith('--')) expiresWithoutValue = true
			else {
				expires = value
				index += 1
			}
		} else if (argument.startsWith('--expires=')) {
			expires = argument.slice('--expires='.length)
		} else if (argument === '--long') {
			long = true
		} else {
			positional.push(argument)
		}
	}
	return { positional, expires, expiresWithoutValue, long }
}

/**
 * `30d` and `12h` are relative to now. Anything else must at least look like a UTC timestamp, otherwise the
 * operator gets the usage message; whether it is a real calendar date and lies in the future is the shared
 * module's call, and it answers with a coded error.
 */
function resolveExpiry(value) {
	const relative = /^(\d{1,4})([dh])$/.exec(value)
	if (relative) {
		const amount = Number(relative[1])
		if (amount < 1) throw new Error(CREATE_USAGE_WITH_EXPIRY)
		const unit = relative[2] === 'd' ? 86_400_000 : 3_600_000
		return new Date(Date.now() + amount * unit).toISOString()
	}
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) throw new Error(CREATE_USAGE_WITH_EXPIRY)
	return value
}

const file = resolveStorePath()
const { positional, expires, expiresWithoutValue, long } = splitArguments(process.argv.slice(2))
const [command, name, roomList, access = 'read-write'] = positional
const validName = (value) => /^[A-Za-z0-9_-]{1,64}$/.test(value ?? '')
const validRoom = (value) => /^[A-Za-z0-9_-]{1,80}$/.test(value)

if (command === 'create') {
	const rooms = roomList?.split(',') ?? []
	const usage = expires !== undefined || expiresWithoutValue ? CREATE_USAGE_WITH_EXPIRY : CREATE_USAGE
	if (long || expiresWithoutValue || !validName(name) || rooms.length < 1 || rooms.length > 50 || !rooms.every(validRoom) || !(access in ACCESS_MODES)) throw new Error(usage)
	const { token, expiresAt } = await createClient({ file, name, rooms, access, ...(expires === undefined ? {} : { expiresAt: resolveExpiry(expires) }) })
	console.log(`Token for ${name} (copy it now; only its hash is stored):\n${token}`)
	if (expiresAt !== undefined) console.log(`Expires ${expiresAt}`)
} else if (command === 'revoke') {
	if (expires !== undefined || expiresWithoutValue || long || !validName(name)) throw new Error('Usage: revoke <client-name>')
	await revokeClient(file, name)
	console.log(`Revoked ${name}`)
} else if (command === 'list') {
	if (expires !== undefined || expiresWithoutValue) throw new Error(LIST_USAGE)
	if (long) {
		for (const client of await describeClients(file)) {
			console.log([client.name, client.rooms.join(','), client.permissions.join(','), client.createdAt ?? '-', client.expiresAt ?? '-', client.status].join('\t'))
		}
	} else {
		for (const client of await listClients(file)) console.log(`${client.name}\t${client.rooms.join(',')}\t${client.permissions.join(',')}`)
	}
} else {
	throw new Error('Usage: node scripts/manage-api-tokens.mjs create|revoke|list ...')
}
