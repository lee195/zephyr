import { resolve } from 'node:path'
import { backends } from './backends'
import { serve } from './server'
import { Zephyr } from './zephyr'

const env = process.env
const backendName = env.ZEPHYR_BACKEND ?? 'vllm'
const makeBackend = backends[backendName]
if (!makeBackend) throw new Error(`unknown ZEPHYR_BACKEND: ${backendName}`)
if (!env.DEEPSEEK_API_KEY) console.warn('[zephyr] DEEPSEEK_API_KEY is not set; runs will fail until it is')

const zephyr = new Zephyr({ dataDir: resolve(env.ZEPHYR_DATA ?? './data'), backend: makeBackend(env) })
await zephyr.start()
const server = serve(zephyr, {
  port: Number(env.ZEPHYR_PORT ?? 7317),
  distDir: resolve(import.meta.dir, '../viewer/dist'),
})
console.log(`[zephyr] listening on http://${server.hostname}:${server.port} data=${zephyr.store.dir}`)

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    zephyr.stop()
    server.stop(true)
    process.exit(0)
  })
}
