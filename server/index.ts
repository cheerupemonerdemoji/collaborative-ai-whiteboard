import { buildApp } from './app'

const app = await buildApp()
await app.listen({ host: process.env.HOST ?? '127.0.0.1', port: Number(process.env.PORT ?? 8787) })

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
	process.once(signal, () => { void app.close().then(() => process.exit(0)) })
}
