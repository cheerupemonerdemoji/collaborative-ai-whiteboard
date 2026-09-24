import { describe, expect, it } from 'vitest'
import { canvasActionsSchema, validateReferences, type CanvasObject } from '../shared/ai'
import { mockActions } from '../worker/ai'
const object: CanvasObject = { id: 'shape:existing', type: 'geo', text: 'Testing', x: 10, y: 20, width: 180, height: 80 }
describe('AI action boundary', () => {
	it('accepts multiple validated operations', () => { const actions = canvasActionsSchema.parse([{ tool: 'move_shape', id: object.id, x: 50, y: 60 }, { tool: 'update_text', id: object.id, text: 'Validation' }]); expect(validateReferences(actions, [object])).toHaveLength(2) })
	it('rejects invalid object IDs', () => { const actions = canvasActionsSchema.parse([{ tool: 'delete_shape', id: 'shape:missing' }]); expect(() => validateReferences(actions, [object])).toThrow(/Unknown object ID/) })
	it('rejects malformed coordinates and absurd dimensions', () => { expect(() => canvasActionsSchema.parse([{ tool: 'create_shape', id: 'shape:new', type: 'rectangle', text: 'X', x: Infinity, y: 0, width: 999999, height: 10 }])).toThrow() })
	it('rejects unexpected fields and tool names', () => { expect(() => canvasActionsSchema.parse([{ tool: 'run_javascript', code: 'alert(1)' }])).toThrow(); expect(() => canvasActionsSchema.parse([{ tool: 'delete_shape', id: object.id, surprise: true }])).toThrow() })
	it('mock parser produces a connected native workflow', () => { const actions = mockActions('Create three boxes labeled Research, Design, and Testing and connect them in that order.', []); expect(actions).toHaveLength(5); expect(actions.filter((a) => a.tool === 'connect_shapes')).toHaveLength(2); expect(validateReferences(canvasActionsSchema.parse(actions), [])).toHaveLength(5) })
	it('mock existing-board edit reuses the existing ID', () => { const design = { ...object, id: 'shape:design', text: 'Design', x: 200 }; const actions = mockActions('Rename Testing to Validation and move it below Design.', [object, design]); expect(actions.map((a) => a.id)).toEqual([object.id, object.id]) })
})
