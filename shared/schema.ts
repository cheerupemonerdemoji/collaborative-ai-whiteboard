import { createTLSchema, defaultShapeSchemas } from '@tldraw/tlschema'
import { engineeringEntitySchema } from './entities'

/**
 * The one tldraw store schema for this application, consumed by the server's rooms and by
 * every store the browser creates (the live board and the read-only history viewer).
 *
 * Every store that can receive an `engineering_entity` record must be built from this schema.
 * A store built from tldraw's default schema throws `Missing definition for record type
 * engineering_entity` as soon as such a record arrives, which makes the board unloadable in
 * that client. Do not construct a separate schema for a new client path; import this one.
 *
 * `useSync` and `createTLStore` return a schema passed to them as-is, so the object the
 * server serializes in the sync handshake is the same shape the client sends back.
 */
export const syncSchema = createTLSchema({
	shapes: { ...defaultShapeSchemas },
	records: {
		engineering_entity: {
			scope: 'document',
			validator: { validate: (record: unknown) => engineeringEntitySchema.parse(record) },
		},
	},
})
