import type { Config } from './config'
import { embeddingBackend } from './embedding'

export interface RelevanceDoc {
  id: string
  text: string
}

export interface Scored {
  id: string
  score: number
}

/** Scores are only comparable within one backend, so a ranking names the backend that produced it. */
export interface Ranking {
  backend: string
  /** Best first; every doc appears once, except docs a partial ranking could not score yet. */
  scored: Scored[]
  /** Some docs were left out because the backend was not ready to score them. */
  partial?: true
  /** A doc scored below this is not related to the query; Infinity when the backend has no measured threshold. */
  minRelatedScore: number
  /**
   * Two topic pages scoring below this, one ranked with the other's page as the query, are too unlike to link;
   * Infinity when the backend has no measured threshold, which gates no link.
   */
  minLinkScore: number
}

export interface RelevanceBackend {
  rank(query: string, docs: RelevanceDoc[]): Promise<Ranking>
  /** Readies docs so a later rank scores all of them. Absent when rank always can. */
  prepare?(docs: RelevanceDoc[]): Promise<void>
  /** Docs being readied right now. */
  pending?(): number
  /** Drops what the backend keeps on disk for any doc not in live. Absent when it keeps nothing on disk. */
  compact?(live: RelevanceDoc[]): Promise<Compaction>
}

export interface FileSize {
  lines: number
  bytes: number
}

export interface Compaction {
  before: FileSize
  after: FileSize
}

/** Every doc ranked, waiting for the backend to ready them first; for background callers that can afford the wait. */
export async function rankAll(backend: RelevanceBackend, query: string, docs: RelevanceDoc[]): Promise<Ranking> {
  await backend.prepare?.(docs).catch(() => {})
  return backend.rank(query, docs)
}

const MIN_TOKEN_LENGTH = 3

/**
 * Function words, which otherwise carry most of the weight between two short notes on unrelated subjects.
 * Words under MIN_TOKEN_LENGTH are dropped anyway. The German part leaves out words that are also English
 * content words (die, man, war, hat, bin, den, rest, gift, dir).
 */
const STOPWORDS = new Set([
  // English
  'the', 'and', 'for', 'with', 'but', 'about', 'from', 'was', 'that', 'out', 'not', 'after', 'than', 'still', 'only',
  'before', 'just', 'now', 'then', 'too', 'them', 'are', 'should', 'when', 'had', 'more', 'this', 'all', 'because',
  'which', 'they', 'again', 'over', 'have', 'each', 'were', 'until', 'into', 'around', 'without', 'maybe', 'its',
  'his', 'her', 'hers', 'him', 'she', 'you', 'your', 'yours', 'our', 'ours', 'their', 'theirs', 'who', 'whom',
  'whose', 'what', 'where', 'why', 'how', 'these', 'those', 'there', 'here', 'has', 'having', 'been', 'being', 'does',
  'did', 'doing', 'done', 'can', 'could', 'would', 'shall', 'might', 'must', 'will', 'any', 'some', 'such',
  'own', 'same', 'other', 'both', 'few', 'most', 'very', 'also', 'even', 'yet', 'nor', 'off', 'onto', 'upon', 'via',
  'per', 'under', 'above', 'below', 'between', 'through', 'during', 'while', 'since', 'though', 'although', 'unless',
  'whether', 'against', 'among', 'within', 'across', 'along', 'behind', 'beyond', 'toward', 'towards',
  'once', 'ever', 'never', 'always', 'often', 'already', 'quite', 'rather', 'much', 'many', 'lot', 'got', 'get',
  'gets', 'let', 'lets', 'myself', 'yourself', 'himself', 'herself', 'itself', 'ourselves', 'themselves',
  'isn', 'aren', 'wasn', 'weren', 'don', 'doesn', 'didn', 'couldn', 'wouldn', 'shouldn', 'haven',
  'hasn', 'hadn',
  // German
  'und', 'der', 'das', 'ist', 'nicht', 'mit', 'für', 'auf', 'sich', 'ein', 'eine', 'einen', 'einem', 'einer', 'eines',
  'dem', 'des', 'von', 'auch', 'noch', 'nur', 'wie', 'wenn', 'dann', 'aber', 'oder', 'sind', 'wird', 'werden',
  'wurde', 'habe', 'haben', 'ich', 'wir', 'sie', 'ihr', 'mir', 'mich', 'uns', 'bei', 'nach', 'aus', 'über',
  'unter', 'vor', 'schon', 'sehr', 'kein', 'keine', 'dass', 'weil', 'doch', 'mal', 'hier', 'dort', 'jetzt', 'sein',
  'seine', 'ihre', 'ihren', 'diese', 'dieser', 'dieses', 'zum', 'zur', 'vom', 'beim', 'ins', 'durch', 'gegen',
  'ohne', 'bis', 'seit', 'kann', 'muss', 'soll', 'wäre', 'hatte', 'hätte', 'etwas', 'immer', 'wieder',
])

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= MIN_TOKEN_LENGTH && !STOPWORDS.has(t))
}

function termCounts(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1)
  return counts
}

/**
 * Measured with scripts/measure-relevance.ts on the organizer fixture corpus, among top-5 hits: 0.14 keeps 28% of
 * same-subject hits and 12% of other-subject ones (precision 36%). Realistic related drafts scored 0.147 and up,
 * unrelated ones under 0.127.
 */
const TFIDF_MIN_RELATED_SCORE = 0.14

/** Cosine similarity of sublinear-tf, smoothed-idf vectors; idf comes from the docs alone. */
function tfidf(): RelevanceBackend {
  return {
    async rank(query, docs) {
      const docCounts = docs.map((d) => termCounts(tokenize(d.text)))
      const df = new Map<string, number>()
      for (const counts of docCounts) for (const t of counts.keys()) df.set(t, (df.get(t) ?? 0) + 1)
      const idf = (t: string) => Math.log((docs.length + 1) / ((df.get(t) ?? 0) + 1)) + 1
      const vector = (counts: Map<string, number>) => {
        const v = new Map<string, number>()
        let norm = 0
        for (const [t, n] of counts) {
          const w = (1 + Math.log(n)) * idf(t)
          v.set(t, w)
          norm += w * w
        }
        return { v, norm: Math.sqrt(norm) }
      }
      const q = vector(termCounts(tokenize(query)))
      const scored = docs.map((d, i) => {
        const doc = vector(docCounts[i]!)
        let dot = 0
        for (const [t, w] of q.v) dot += w * (doc.v.get(t) ?? 0)
        const denom = q.norm * doc.norm
        return { id: d.id, score: denom === 0 ? 0 : dot / denom }
      })
      // Not measured for links: pair scores on the corpus put a clearly related pair at rank 112 of 780.
      return { backend: 'tfidf', scored: scored.sort((a, b) => b.score - a.score), minRelatedScore: TFIDF_MIN_RELATED_SCORE, minLinkScore: Infinity }
    },
  }
}

export interface RelevanceDeps {
  /** Where a backend that keeps per-doc state on disk keeps it. */
  cacheDir: string
  fetch?: typeof fetch
}

/** Throws when config lacks what the backend needs, so a caller decides whether to fall back or fail. */
export const relevanceBackends = {
  tfidf,
  embedding(config, deps) {
    const embed = config.embed
    if (!embed) throw new Error('embedding relevance needs ZEPHYR_EMBED_URL, ZEPHYR_EMBED_MODEL and ZEPHYR_EMBED_KEY_VAR')
    if (!embed.apiKey) throw new Error(`${embed.keyVar} is not set; embedding relevance needs it in the server's environment`)
    return embeddingBackend({ baseUrl: embed.url, model: embed.model, apiKey: embed.apiKey, ...deps })
  },
} satisfies Record<string, (config: Config, deps: RelevanceDeps) => RelevanceBackend>

export type RelevanceName = keyof typeof relevanceBackends

export interface FallbackOptions {
  timeoutMs: number
  /** How long after a failure every call goes straight to the fallback. */
  cooldownMs: number
  now?: () => number
}

/**
 * Answers from primary, or from fallback when primary fails or takes longer than timeoutMs. After a failure it
 * skips primary for cooldownMs, so a down endpoint costs one timeout, not one per request. A primary call that
 * timed out keeps running and still fills primary's caches. prepare has no timeout, since its callers chose to
 * wait, but a failed prepare counts as a failure.
 */
export function withFallback(primary: RelevanceBackend, fallback: RelevanceBackend, opts: FallbackOptions): RelevanceBackend {
  const now = opts.now ?? Date.now
  let degradedUntil = 0
  const degrade = (err: unknown) => {
    degradedUntil = now() + opts.cooldownMs
    console.warn(`[zephyr] relevance: ${(err as Error).message}; using the fallback for ${opts.cooldownMs / 1000} s`)
  }
  return {
    pending: () => primary.pending?.() ?? 0,
    // Local file work that needs no endpoint, so it is never degraded.
    ...(primary.compact && { compact: primary.compact }),
    async prepare(docs) {
      if (now() < degradedUntil) return
      try {
        await primary.prepare?.(docs)
      } catch (err) {
        degrade(err)
        throw err
      }
    },
    async rank(query, docs) {
      if (now() < degradedUntil) return fallback.rank(query, docs)
      const answer = primary.rank(query, docs)
      answer.catch(() => {})
      let timer: Timer | undefined
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer in ${opts.timeoutMs} ms`)), opts.timeoutMs)
      })
      try {
        return await Promise.race([answer, timeout])
      } catch (err) {
        degrade(err)
        return fallback.rank(query, docs)
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
