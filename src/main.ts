import { join, resolve } from 'node:path'
import { backends } from './backends'
import { embeddingBackend } from './embedding'
import { relevanceBackends, withFallback, type RelevanceBackend } from './relevance'
import { serve } from './server'
import { Zephyr } from './zephyr'

const env = process.env
const backendName = env.ZEPHYR_BACKEND ?? 'vllm'
const makeBackend = backends[backendName]
if (!makeBackend) throw new Error(`unknown ZEPHYR_BACKEND: ${backendName}`)
if (!env.DEEPSEEK_API_KEY) console.warn('[zephyr] DEEPSEEK_API_KEY is not set; runs will fail until it is')

const dataDir = resolve(env.ZEPHYR_DATA ?? './data')

/** embedding falls back to tfidf per call when the endpoint fails, and entirely when there is no key. */
function makeRelevance(name: string): RelevanceBackend {
  const tfidf = relevanceBackends.tfidf!()
  if (name === 'tfidf') return tfidf
  if (name !== 'embedding') throw new Error(`unknown ZEPHYR_RELEVANCE: ${name}; known: tfidf, embedding`)
  if (!env.DEEPSEEK_API_KEY) {
    console.warn('[zephyr] DEEPSEEK_API_KEY is not set; relevance uses tfidf')
    return tfidf
  }
  const embedding = embeddingBackend({
    baseUrl: env.ZEPHYR_VLLM_URL ?? 'https://llm.example.com/v1',
    model: env.ZEPHYR_EMBED_MODEL ?? 'embeddinggemma2',
    apiKey: env.DEEPSEEK_API_KEY,
    cacheDir: join(dataDir, 'embeddings'),
  })
  return withFallback(embedding, tfidf, { timeoutMs: 2_000, cooldownMs: 30_000 })
}

const zephyr = new Zephyr({ dataDir, backend: makeBackend(env), relevance: makeRelevance(env.ZEPHYR_RELEVANCE ?? 'embedding') })
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
