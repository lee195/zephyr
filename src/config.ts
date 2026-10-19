import { resolve } from 'node:path'
import { backends, type ModelBackendName } from './backends'
import { relevanceBackends, type RelevanceName } from './relevance'

export type Env = Readonly<Record<string, string | undefined>>

export interface Config {
  /** OpenAI-compatible base URL that serves both the chat and the embedding model. */
  vllmUrl: string
  /** Absent: model runs fail until it is set, and relevance cannot use the endpoint. */
  apiKey?: string
  modelBackend: ModelBackendName
  chatModel: string
  embedModel: string
  relevance: RelevanceName
  dataDir: string
  port: number
  /** Minutes between cleanup sweeps; fractional values are allowed. */
  sweepMinutes: number
}

/** The only place that reads the environment; everything else takes the Config it returns. */
export function parseConfig(env: Env): Config {
  return {
    vllmUrl: env.ZEPHYR_VLLM_URL ?? 'https://llm.example.com/v1',
    apiKey: env.DEEPSEEK_API_KEY || undefined,
    modelBackend: registered('ZEPHYR_BACKEND', env.ZEPHYR_BACKEND ?? 'vllm', backends),
    chatModel: env.ZEPHYR_MODEL ?? 'deepseek-v4-flash-fast',
    embedModel: env.ZEPHYR_EMBED_MODEL ?? 'embeddinggemma2',
    relevance: registered('ZEPHYR_RELEVANCE', env.ZEPHYR_RELEVANCE ?? 'embedding', relevanceBackends),
    dataDir: resolve(env.ZEPHYR_DATA ?? './data'),
    port: Number(env.ZEPHYR_PORT ?? 7317),
    sweepMinutes: positive('ZEPHYR_SWEEP_MINUTES', env.ZEPHYR_SWEEP_MINUTES ?? '30'),
  }
}

function registered<K extends string>(variable: string, value: string, registry: Readonly<Record<K, unknown>>): K {
  if (Object.hasOwn(registry, value)) return value as K
  throw new Error(`unknown ${variable}: ${value}; registered: ${Object.keys(registry).join(', ')}`)
}

function positive(variable: string, value: string): number {
  const n = Number(value)
  if (Number.isFinite(n) && n > 0) return n
  throw new Error(`${variable} must be a positive number: ${value}`)
}
