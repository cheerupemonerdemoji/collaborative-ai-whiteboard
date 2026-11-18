import { afterEach, describe, expect, it } from 'vitest'
import { createAcceptanceFixture, type AcceptanceFixture } from './helpers/acceptance-fixture'

let fixture: AcceptanceFixture | undefined
afterEach(async () => { await fixture?.cleanup(); fixture = undefined })

describe('page creation on an existing board', () => {
	it('lets editors create pages, refuses viewers and outsiders, and records the change in History', async () => {
		const f = fixture = await createAcceptanceFixture()
		const url = `/api/rooms/${f.boardId}/pages`
		const body = { id: 'page:lessons', name: 'Lessons learned' }
		expect((await f.viewer.post(url, body)).statusCode).toBe(403)
		expect((await f.nonmember.post(url, body)).statusCode).toBe(404)
		expect((await f.anonymous.post(url, body)).statusCode).toBe(401)
		const created = await f.editor.post(url, body)
		expect(created.statusCode, created.body).toBe(200)
		expect(created.json()).toMatchObject({ pageId: body.id, name: body.name, created: true })
		const canvas = await f.owner.get(`/api/rooms/${f.boardId}/canvas?pageId=page%3Alessons`)
		expect(canvas.statusCode, canvas.body).toBe(200)
		expect(canvas.json().pages).toContainEqual(body)
		const history = await f.owner.get(`/api/boards/${f.boardId}/history`)
		expect(history.statusCode, history.body).toBe(200)
		expect(history.json().events.some((event: { entityId: string }) => event.entityId === body.id)).toBe(true)
	})
})
