import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FileSize, RelevanceBackend, RelevanceDoc, Scored } from './relevance'

export interface EmbeddingOptions {
  baseUrl: string
  model: string
  apiKey: string
  /** Document vectors persist in `<cacheDir>/<backend id>.jsonl`. */
  cacheDir: string
  fetch?: typeof fetch
}

/** The endpoint accepted 1024 inputs in one request; 256 took 0.6 s. */
const BATCH = 256
/** EmbeddingGemma reads 8192 tokens; this many characters stays under that for English and German prose. */
const MAX_CHARS = 16_000
const REQUEST_TIMEOUT_MS = 60_000

/**
 * The score below which a doc is not related, per model, since each model scores on its own scale. Measured with
 * scripts/measure-relevance.ts on the organizer fixture corpus, among top-5 hits: embeddinggemma2 0.80 keeps 25% of
 * same-subject hits and 7% of other-subject ones (precision 76%). Related drafts scored 0.815 and up, unrelated
 * ones 0.788 and under. Its scores sit in a narrow band (top-5 p25 0.76).
 */
const MIN_RELATED_SCORE = new Map([['embeddinggemma2', 0.8]])

type Vector = Float32Array

const sha256 = (text: string) => new Bun.CryptoHasher('sha256').update(text).digest('hex')
const encode = (v: Vector) => Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64')
const decode = (b64: string): Vector => {
  const bytes = Buffer.from(b64, 'base64')
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
}

const sizeOf = (text: string): FileSize => ({ lines: text.split('\n').filter(Boolean).length, bytes: Buffer.byteLength(text) })

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
 *
 * rank never waits on doc embedding: it scores the docs already cached, marks the ranking partial when some
 * were not, and starts embedding those. prepare is the call that waits until docs are cached.
 */
export function embeddingBackend(opts: EmbeddingOptions): RelevanceBackend {
  const id = `embedding-${opts.model.replace(/[^\w.-]+/g, '_')}`
  const minRelatedScore = MIN_RELATED_SCORE.get(opts.model) ?? Infinity
  if (minRelatedScore === Infinity) {
    console.warn(`[zephyr] relevance: embedding model ${opts.model} has no measured threshold; hints are off until one is measured with scripts/measure-relevance.ts`)
  }
  const file = join(opts.cacheDir, `${id}.jsonl`)
  const doFetch = opts.fetch ?? fetch
  const keyOf = (text: string) => `${opts.model}:${sha256(text)}`
  const vectors = new Map<string, Vector>()
  /** Docs being embedded right now, keyed like vectors, so concurrent callers never embed the same text twice. */
  const pending = new Map<string, Promise<void>>()
  let loaded: Promise<void> | null = null
  let fileBusy: Promise<unknown> = Promise.resolve()

  /** The file's one exclusive section: an append and a compaction never touch the file at the same moment. */
  const withFile = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = fileBusy.then(fn)
    fileBusy = run.catch(() => {})
    return run
  }

  const readCache = () => readFile(file, 'utf8').catch((err) => (err.code === 'ENOENT' ? '' : Promise.reject(err)))

  /** A line torn by a crash mid-append fails to parse and is skipped; its doc is embedded again on demand. */
  const parseLines = (raw: string) =>
    raw.split('\n').flatMap((line) => {
      try {
        const { key, v } = JSON.parse(line) as { key: string; v: string }
        return key.startsWith(`${opts.model}:`) ? [{ key, v }] : []
      } catch {
        return []
      }
    })
  const keysIn = (raw: string) => parseLines(raw).map((l) => l.key)

  const load = async () => {
    await mkdir(opts.cacheDir, { recursive: true })
    for (const { key, v } of parseLines(await readCache())) vectors.set(key, decode(v))
  }

  const line = (key: string, v: Vector) => JSON.stringify({ key, v: encode(v) }) + '\n'

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

  /**
   * Embeds every doc not cached or in flight, one batch at a time, each batch cached and persisted as it lands
   * so a ranking can use it before the rest are done. Resolves when all of docs are cached, including any another
   * caller had in flight; a failed batch fails the batches queued behind it.
   */
  const prepare = async (docs: RelevanceDoc[]) => {
    await (loaded ??= load())
    const texts = new Map(docs.map((d) => d.text.slice(0, MAX_CHARS)).map((t) => [keyOf(t), t]))
    const missing = [...texts].filter(([k]) => !vectors.has(k) && !pending.has(k))
    let previous: Promise<void> = Promise.resolve()
    for (let i = 0; i < missing.length; i += BATCH) {
      const batch = missing.slice(i, i + BATCH)
      const done = previous.then(async () => {
        const vs = await request(batch.map(([, t]) => t))
        batch.forEach(([k], j) => vectors.set(k, vs[j]!))
        await withFile(() => appendFile(file, batch.map(([key], j) => line(key, vs[j]!)).join('')))
      })
      batch.forEach(([k]) => pending.set(k, done))
      done.finally(() => batch.forEach(([k]) => pending.delete(k))).catch(() => {})
      previous = done
    }
    await Promise.all([...texts.keys()].map((k) => pending.get(k)))
  }

  /**
   * Rewrites the file to hold one line per live doc it already holds, with the latest vector, through a tmp file
   * and a rename, and leaves the in-memory vectors alone. A batch whose append is still queued appends after the
   * rename, into the new file, so it is left to that append. Writes nothing when the content would not change, so
   * a repeat is a no-op.
   */
  const compact = async (live: RelevanceDoc[]) => {
    await (loaded ??= load())
    const keep = new Set(live.map((d) => keyOf(d.text.slice(0, MAX_CHARS))))
    return withFile(async () => {
      const current = await readCache()
      const onDisk = new Set(keysIn(current))
      const next = [...vectors].filter(([key]) => keep.has(key) && onDisk.has(key)).map(([key, v]) => line(key, v)).join('')
      if (next === current) return { before: sizeOf(current), after: sizeOf(current) }
      const tmp = `${file}.tmp-${process.pid}`
      await writeFile(tmp, next)
      await rename(tmp, file)
      return { before: sizeOf(current), after: sizeOf(next) }
    })
  }

  return {
    prepare,
    compact,
    pending: () => pending.size,
    async rank(query, docs) {
      await (loaded ??= load())
      const keys = docs.map((d) => keyOf(d.text.slice(0, MAX_CHARS)))
      const uncached = docs.filter((_, i) => !vectors.has(keys[i]!))
      if (uncached.length > 0) prepare(uncached).catch(() => {})
      const [q] = await request([query.slice(0, MAX_CHARS)])
      const scored: Scored[] = []
      docs.forEach((d, i) => {
        const v = vectors.get(keys[i]!)
        if (v) scored.push({ id: d.id, score: cosine(q!, v) })
      })
      return { backend: id, scored: scored.sort((a, b) => b.score - a.score), minRelatedScore, ...(scored.length < docs.length && { partial: true as const }) }
    },
  }
}
