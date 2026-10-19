import { join, resolve } from 'node:path'
import { backends } from './backends'
import { parseConfig } from './config'
import { embeddingBackend } from './embedding'
import { relevanceBackends, withFallback, type RelevanceBackend } from './relevance'
import { serve } from './server'
import { Zephyr } from './zephyr'

const config = parseConfig(process.env)
if (!config.apiKey) console.warn('[zephyr] DEEPSEEK_API_KEY is not set; runs will fail until it is')

/** embedding falls back to tfidf per call when the endpoint fails, and entirely when there is no key. */
function makeRelevance(name: string): RelevanceBackend {
  const tfidf = relevanceBackends.tfidf!()
  if (name === 'tfidf') return tfidf
  if (name !== 'embedding') throw new Error(`unknown ZEPHYR_RELEVANCE: ${name}; known: tfidf, embedding`)
  if (!config.apiKey) {
    console.warn('[zephyr] DEEPSEEK_API_KEY is not set; relevance uses tfidf')
    return tfidf
  }
  const embedding = embeddingBackend({
    baseUrl: config.vllmUrl,
    model: config.embedModel,
    apiKey: config.apiKey,
    cacheDir: join(config.dataDir, 'embeddings'),
  })
  return withFallback(embedding, tfidf, { timeoutMs: 2_000, cooldownMs: 30_000 })
}

const zephyr = new Zephyr({ dataDir: config.dataDir, backend: backends[config.modelBackend](config), relevance: makeRelevance(config.relevance) })
await zephyr.start()
const server = serve(zephyr, {
  port: config.port,
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
