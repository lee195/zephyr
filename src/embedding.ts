import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RelevanceBackend } from './relevance'

export interface EmbeddingOptions {
  baseUrl: string
  model: string
  apiKey: string
  /** Document vectors persist in `<cacheDir>/<backend id>.jsonl`. */
  cacheDir: string
  fetch?: typeof fetch
}

/** The endpoint accepted 1024 inputs in one request; 256 took 0.6 s, short enough for one hint request. */
const BATCH = 256
/** EmbeddingGemma reads 8192 tokens; this many characters stays under that for English and German prose. */
const MAX_CHARS = 16_000
const REQUEST_TIMEOUT_MS = 60_000

type Vector = Float32Array

const sha256 = (text: string) => new Bun.CryptoHasher('sha256').update(text).digest('hex')
const encode = (v: Vector) => Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64')
const decode = (b64: string): Vector => {
  const bytes = Buffer.from(b64, 'base64')
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
}

function cosine(a: Vector, b: Vector): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!
    na += a[i]! * a[i]!
    nb += b[i]! * b[i]!
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb)
}

/**
 * Cosine similarity of embeddings from an OpenAI-compatible /embeddings endpoint. Document vectors are cached
 * by model and the hash of the exact text sent, in memory and in an append-only file per backend id, so a doc
 * is embedded once across runs and restarts. Query vectors are never stored.
 */
export function embeddingBackend(opts: EmbeddingOptions): RelevanceBackend {
  const id = `embedding-${opts.model.replace(/[^\w.-]+/g, '_')}`
  const file = join(opts.cacheDir, `${id}.jsonl`)
  const doFetch = opts.fetch ?? fetch
  const keyOf = (text: string) => `${opts.model}:${sha256(text)}`
  const vectors = new Map<string, Vector>()
  /** Docs being embedded right now, so concurrent rankings never embed the same text twice. */
  const pending = new Map<string, Promise<Vector>>()
  let loaded: Promise<void> | null = null

  /** A line torn by a crash mid-append fails to parse and is skipped; its doc is embedded again on demand. */
  const load = async () => {
    const raw = await readFile(file, 'utf8').catch((err) => (err.code === 'ENOENT' ? '' : Promise.reject(err)))
    for (const line of raw.split('\n')) {
      try {
        const { key, v } = JSON.parse(line) as { key: string; v: string }
        if (key.startsWith(`${opts.model}:`)) vectors.set(key, decode(v))
      } catch {}
    }
  }

  const request = async (input: string[]): Promise<Vector[]> => {
    const res = await doFetch(`${opts.baseUrl}/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.apiKey}` },
      body: JSON.stringify({ model: opts.model, input }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`embeddings ${res.status}: ${(await res.text()).slice(0, 300)}`)
    const data = ((await res.json()) as { data?: { index: number; embedding: number[] }[] }).data
    if (!Array.isArray(data) || data.length !== input.length) throw new Error('embeddings reply does not match the input')
    return [...data].sort((a, b) => a.index - b.index).map((d) => Float32Array.from(d.embedding))
  }

  const embedMany = async (texts: string[]): Promise<Vector[]> => {
    const out: Vector[] = []
    for (let i = 0; i < texts.length; i += BATCH) out.push(...(await request(texts.slice(i, i + BATCH))))
    return out
  }

  /** Embeds every doc not cached or in flight, then persists them in one append. */
  const docVectors = async (texts: string[]): Promise<Vector[]> => {
    loaded ??= mkdir(opts.cacheDir, { recursive: true }).then(load)
    await loaded
    const keys = texts.map(keyOf)
    const missing = [...new Map(keys.map((k, i) => [k, texts[i]!])).entries()].filter(([k]) => !vectors.has(k) && !pending.has(k))
    if (missing.length > 0) {
      const batch = embedMany(missing.map(([, t]) => t)).then(async (vs) => {
        missing.forEach(([k], i) => vectors.set(k, vs[i]!))
        await appendFile(file, missing.map(([key], i) => JSON.stringify({ key, v: encode(vs[i]!) }) + '\n').join(''))
        return vs
      })
      missing.forEach(([k], i) => pending.set(k, batch.then((vs) => vs[i]!)))
      batch.finally(() => missing.forEach(([k]) => pending.delete(k))).catch(() => {})
    }
    return Promise.all(keys.map((k) => vectors.get(k) ?? pending.get(k)!))
  }

  return {
    async rank(query, docs) {
      const texts = docs.map((d) => d.text.slice(0, MAX_CHARS))
      const [[q], ds] = await Promise.all([request([query.slice(0, MAX_CHARS)]), docVectors(texts)])
      const scored = docs.map((d, i) => ({ id: d.id, score: cosine(q!, ds[i]!) }))
      return { backend: id, scored: scored.sort((a, b) => b.score - a.score) }
    },
  }
}
