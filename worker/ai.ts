import OpenAI from 'openai'
import { aiRequestSchema, canvasActionsSchema, validateReferences, type CanvasAction, type CanvasObject } from '../shared/ai'
const jsonHeaders = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
const stringProp = () => ({ type: 'string', minLength: 1, maxLength: 500 } as const)
const numberProp = () => ({ type: 'number', minimum: -100000, maximum: 100000 } as const)
const dimensionProp = () => ({ type: 'number', minimum: 10, maximum: 5000 } as const)
const idProp = () => ({ type: 'string', pattern: '^shape:[A-Za-z0-9_-]{1,80}$' } as const)
function tool(name: string, description: string, properties: Record<string, object>) { return { type: 'function' as const, name, description, strict: true, parameters: { type: 'object' as const, properties, required: Object.keys(properties), additionalProperties: false } } }
const toolDefinitions = [
	tool('create_shape', 'Create a native rectangle with text.', { id: idProp(), type: { type: 'string', enum: ['rectangle'] }, text: stringProp(), x: numberProp(), y: numberProp(), width: dimensionProp(), height: dimensionProp() }),
	tool('create_text', 'Create native text.', { id: idProp(), text: stringProp(), x: numberProp(), y: numberProp() }),
	tool('create_arrow', 'Create an unbound native arrow.', { id: idProp(), x: numberProp(), y: numberProp(), endX: numberProp(), endY: numberProp() }),
	tool('update_text', 'Change text on an existing object.', { id: idProp(), text: stringProp() }), tool('move_shape', 'Move an existing object.', { id: idProp(), x: numberProp(), y: numberProp() }),
	tool('resize_shape', 'Resize an existing object.', { id: idProp(), width: dimensionProp(), height: dimensionProp() }), tool('delete_shape', 'Delete an existing object.', { id: idProp() }),
	tool('connect_shapes', 'Connect two existing objects with a native arrow.', { id: idProp(), fromId: idProp(), toId: idProp() }),
] as const
type AiEnv = Env & { OPENAI_API_KEY?: string; OPENAI_MODEL?: string }
export async function handleAiRequest(request: Request, env: AiEnv): Promise<Response> {
	if (Number(request.headers.get('content-length') ?? 0) > 150_000) return Response.json({ error: 'Request too large' }, { status: 413, headers: jsonHeaders })
	let raw: unknown
	try { raw = await request.json() } catch { return Response.json({ error: 'Invalid JSON' }, { status: 400, headers: jsonHeaders }) }
	const parsed = aiRequestSchema.safeParse(raw)
	if (!parsed.success) return Response.json({ error: 'Invalid request', details: parsed.error.issues }, { status: 400, headers: jsonHeaders })
	const subject = request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for') ?? 'local'
	if (!await env.TLDRAW_DURABLE_OBJECT.getByName(parsed.data.roomId).checkAiRateLimit(subject)) return Response.json({ error: 'AI rate limit exceeded; retry in one minute' }, { status: 429, headers: { ...jsonHeaders, 'retry-after': '60' } })
	try {
		const apiKey = env.OPENAI_API_KEY
		const useMock = parsed.data.mode === 'mock' || !apiKey
		const actions = useMock ? mockActions(parsed.data.prompt, parsed.data.objects) : await openAiActions(apiKey, env.OPENAI_MODEL || 'gpt-5.6-luna', parsed.data.prompt, parsed.data.objects)
		return Response.json({ actions: validateReferences(canvasActionsSchema.parse(actions), parsed.data.objects), adapter: useMock ? 'mock' : 'openai' }, { headers: jsonHeaders })
	} catch (error) { return Response.json({ error: error instanceof Error ? error.message : 'AI request failed' }, { status: 422, headers: jsonHeaders }) }
}
async function openAiActions(apiKey: string, model: string, prompt: string, objects: CanvasObject[]): Promise<CanvasAction[]> {
	const client = new OpenAI({ apiKey })
	const response = await client.responses.create({ model, instructions: 'You edit a shared tldraw canvas. Call only supplied tools. Use existing IDs for edits and shape:ai_<unique> for new IDs. Prefer connect_shapes. Never emit code.', input: `Canvas objects:\n${JSON.stringify(objects)}\n\nUser request:\n${prompt}`, tools: [...toolDefinitions], tool_choice: 'required', parallel_tool_calls: false, max_output_tokens: 3000 })
	return response.output.flatMap((item) => item.type === 'function_call' ? [{ tool: item.name, ...JSON.parse(item.arguments) }] : []) as CanvasAction[]
}
export function mockActions(prompt: string, objects: CanvasObject[]): CanvasAction[] {
	const lower = prompt.toLowerCase(); const find = (label: string) => objects.find((object) => object.text.toLowerCase() === label.toLowerCase())
	if (lower.includes('research') && lower.includes('design') && lower.includes('testing')) return [
		{ tool: 'create_shape', id: 'shape:ai_research', type: 'rectangle', text: 'Research', x: 120, y: 180, width: 180, height: 80 }, { tool: 'create_shape', id: 'shape:ai_design', type: 'rectangle', text: 'Design', x: 400, y: 180, width: 180, height: 80 }, { tool: 'create_shape', id: 'shape:ai_testing', type: 'rectangle', text: 'Testing', x: 680, y: 180, width: 180, height: 80 }, { tool: 'connect_shapes', id: 'shape:ai_arrow_research_design', fromId: 'shape:ai_research', toId: 'shape:ai_design' }, { tool: 'connect_shapes', id: 'shape:ai_arrow_design_testing', fromId: 'shape:ai_design', toId: 'shape:ai_testing' }]
	if (lower.includes('rename testing') && lower.includes('validation')) { const testing = find('Testing'); const design = find('Design'); if (!testing || !design) throw new Error('Testing and Design must exist'); return [{ tool: 'update_text', id: testing.id, text: 'Validation' }, { tool: 'move_shape', id: testing.id, x: design.x, y: design.y + 180 }] }
	const match = prompt.match(/add (?:a |an )?(?:box|rectangle)(?: labeled| named)?[ “"]*([^”".]+)[”"]*/i)
	if (match) return [{ tool: 'create_shape', id: `shape:ai_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`, type: 'rectangle', text: match[1].trim(), x: 320, y: 240, width: 200, height: 90 }]
	throw new Error('Mock mode supports the documented acceptance prompts and “Add a box labeled …”. Add OPENAI_API_KEY for natural-language commands.')
}
