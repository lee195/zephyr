import { join, resolve } from 'node:path'
import { backends } from './backends'
import { parseConfig } from './config'
import { relevanceBackends, withFallback, type RelevanceBackend } from './relevance'
import { serve } from './server'
import { Zephyr } from './zephyr'

const config = parseConfig(process.env)
if (config.chat && !config.chat.apiKey) console.warn(`[zephyr] ${config.chat.keyVar} is not set; runs will fail until it is`)
console.log(`[zephyr] model: ${config.chat ? `${config.chat.model} at ${config.chat.url}` : `${config.modelBackend}${config.harness.model ? ` (${config.harness.model})` : ', its default model'}`}`)

/**
 * tfidf answers whenever the chosen backend cannot be built (no key), fails, or is slow. With tfidf chosen it
 * never has to.
 */
function serverRelevance(): RelevanceBackend {
  const fallback = relevanceBackends.tfidf()
  try {
    const chosen = relevanceBackends[config.relevance](config, { cacheDir: join(config.dataDir, 'embeddings') })
    return withFallback(chosen, fallback, { timeoutMs: 2_000, cooldownMs: 30_000 })
  } catch (err) {
    console.warn(`[zephyr] ${(err as Error).message}; relevance uses tfidf`)
    return fallback
  }
}

const zephyr = new Zephyr({ dataDir: config.dataDir, backend: backends[config.modelBackend](config), relevance: serverRelevance(), sweepMs: config.sweepMinutes * 60_000 })
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
