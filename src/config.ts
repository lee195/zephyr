import { resolve } from 'node:path'
import { backends, type ModelBackendName } from './backends'
import { relevanceBackends, type RelevanceName } from './relevance'

export type Env = Readonly<Record<string, string | undefined>>

/** An OpenAI-compatible endpoint and the model it serves. */
export interface Endpoint {
  url: string
  model: string
  /** The variable that holds the key, such as DEEPSEEK_API_KEY; named in errors, never the key itself. */
  keyVar: string
  /** Absent when that variable is unset or empty: calls fail until it is set. */
  apiKey?: string
}

export interface Config {
  modelBackend: ModelBackendName
  /** The chat endpoint, for the `vllm` backend. */
  chat?: Endpoint
  relevance: RelevanceName
  /** The embedding endpoint, for `embedding` relevance only. */
  embed?: Endpoint
  dataDir: string
  port: number
  /** Minutes between cleanup sweeps; fractional values are allowed. */
  sweepMinutes: number
}

/** Variables renamed when chat and embeddings got their own endpoints; a leftover one would be silently ignored. */
const RENAMED: Record<string, string> = { ZEPHYR_VLLM_URL: 'ZEPHYR_CHAT_URL and ZEPHYR_EMBED_URL', ZEPHYR_MODEL: 'ZEPHYR_CHAT_MODEL' }

/**
 * The only place that reads the environment; everything else takes the Config it returns. The LLM settings have no
 * defaults here: they come from `.env`, which Bun loads from the working directory, and `.env.example` lists them.
 */
export function parseConfig(env: Env): Config {
  for (const [old, now] of Object.entries(RENAMED)) if (env[old] !== undefined) throw new Error(`${old} was renamed; set ${now} instead (see .env.example)`)
  const modelBackend = registered('ZEPHYR_BACKEND', env.ZEPHYR_BACKEND ?? 'vllm', backends)
  const relevance = registered('ZEPHYR_RELEVANCE', env.ZEPHYR_RELEVANCE ?? 'embedding', relevanceBackends)
  return {
    modelBackend,
    ...(modelBackend === 'vllm' && { chat: endpoint(env, 'CHAT') }),
    relevance,
    ...(relevance === 'embedding' && { embed: endpoint(env, 'EMBED') }),
    dataDir: resolve(env.ZEPHYR_DATA ?? './data'),
    port: Number(env.ZEPHYR_PORT ?? 7317),
    sweepMinutes: positive('ZEPHYR_SWEEP_MINUTES', env.ZEPHYR_SWEEP_MINUTES ?? '30'),
  }
}

function endpoint(env: Env, which: 'CHAT' | 'EMBED'): Endpoint {
  const keyVar = required(env, `ZEPHYR_${which}_KEY_VAR`)
  return { url: required(env, `ZEPHYR_${which}_URL`), model: required(env, `ZEPHYR_${which}_MODEL`), keyVar, ...(env[keyVar] && { apiKey: env[keyVar] }) }
}

function required(env: Env, variable: string): string {
  const value = env[variable]
  if (value) return value
  throw new Error(`${variable} is not set; copy .env.example to .env in the folder you start from`)
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
