/**
 * Measures a relevance backend on a subject-labelled corpus, offline and without a model.
 *
 *   bun scripts/measure-relevance.ts [corpus.json] [--backend tfidf|embedding] [--cache dir]
 *   wick exec --only vllm -- bun scripts/measure-relevance.ts --backend embedding
 *
 * Each note is ranked against every other note; a hit is relevant when it shares the note's subject.
 * Prints JSON: top-1 / recall@3 / recall@5 / MRR over all notes and over the notes that share no content word
 * with any other note of their subject, and how a score threshold splits the top-5 hits into same-subject and
 * other-subject ones, with the share of kept hits that are same-subject (precision). For embedding, also the
 * requests and tokens the run cost; --cache defaults to a fresh directory, so the count is for a cold cache.
 */
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { parseConfig } from '../src/config'
import { relevanceBackends, tokenize, type RelevanceName } from '../src/relevance'
import { CORPUS_PATH, loadCorpus } from './corpus'

interface Note {
  id: string
  subject: string
  text: string
}

const THRESHOLDS: Record<RelevanceName, number[]> = { tfidf: [0.1, 0.12, 0.14, 0.15, 0.2], embedding: [0.75, 0.78, 0.8, 0.82, 0.84, 0.86] }
const TOP_K = 5

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: { backend: { type: 'string', default: 'tfidf' }, cache: { type: 'string' } },
})
const corpusPath = positionals[0] ?? CORPUS_PATH
const cost = { requests: 0, inputs: 0, tokens: 0 }

const counting = (async (url: string, init: RequestInit) => {
  const res = await fetch(url, init)
  cost.requests++
  cost.inputs += (JSON.parse(String(init.body)) as { input: string[] }).input.length
  cost.tokens += ((await res.clone().json()) as { usage?: { prompt_tokens?: number } }).usage?.prompt_tokens ?? 0
  return res
}) as typeof fetch
const config = parseConfig({ ...process.env, ZEPHYR_RELEVANCE: values.backend })
const backend = relevanceBackends[config.relevance](config, {
  cacheDir: values.cache ?? join(tmpdir(), `zephyr-embeddings-${crypto.randomUUID()}`),
  fetch: counting,
})
const thresholds = THRESHOLDS[config.relevance]

const subjects = await loadCorpus(corpusPath)
const notes: Note[] = subjects.flatMap((s) => s.notes.map((text, i) => ({ id: `${s.slug}#${i}`, subject: s.slug, text })))
const subjectOf = new Map(notes.map((n) => [n.id, n.subject]))
const tokensOf = new Map(notes.map((n) => [n.id, new Set(tokenize(n.text))]))
/** Notes that share no content word with any other note of their subject: lexical matching cannot find their subject. */
const disjoint = new Set(
  notes.filter((q) => notes.every((n) => n === q || n.subject !== q.subject || ![...tokensOf.get(n.id)!].some((t) => tokensOf.get(q.id)!.has(t)))).map((n) => n.id),
)
let disjointTop1 = 0
let disjointAt5 = 0

let top1 = 0
let at3 = 0
let at5 = 0
let reciprocalRanks = 0
const sameScores: number[] = []
const otherScores: number[] = []
for (const q of notes) {
  const { scored: ranked } = await backend.rank(q.text, notes.filter((n) => n !== q))
  const firstHit = ranked.findIndex((r) => subjectOf.get(r.id) === q.subject)
  if (firstHit === 0) top1++
  if (firstHit >= 0 && firstHit < 3) at3++
  if (firstHit >= 0 && firstHit < 5) at5++
  if (firstHit >= 0) reciprocalRanks += 1 / (firstHit + 1)
  if (disjoint.has(q.id) && firstHit === 0) disjointTop1++
  if (disjoint.has(q.id) && firstHit >= 0 && firstHit < 5) disjointAt5++
  for (const r of ranked.slice(0, TOP_K)) (subjectOf.get(r.id) === q.subject ? sameScores : otherScores).push(r.score)
}

const quantile = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length === 0 ? null : round(s[Math.floor(p * (s.length - 1))]!)
}
const round = (x: number) => Math.round(x * 1000) / 1000

console.log(
  JSON.stringify(
    {
      corpus: corpusPath,
      backend: values.backend,
      notes: notes.length,
      subjects: subjects.length,
      top1: { hits: top1, rate: round(top1 / notes.length) },
      recallAt3: round(at3 / notes.length),
      recallAt5: round(at5 / notes.length),
      mrr: round(reciprocalRanks / notes.length),
      noSharedWord: { notes: disjoint.size, top1: disjointTop1, at5: disjointAt5 },
      top5Scores: {
        same: { n: sameScores.length, p25: quantile(sameScores, 0.25), p50: quantile(sameScores, 0.5), p75: quantile(sameScores, 0.75) },
        other: { n: otherScores.length, p50: quantile(otherScores, 0.5), p75: quantile(otherScores, 0.75), p90: quantile(otherScores, 0.9) },
      },
      thresholds: thresholds.map((t) => {
        const same = sameScores.filter((x) => x >= t).length
        const other = otherScores.filter((x) => x >= t).length
        return { threshold: t, keepsSame: round(same / sameScores.length), keepsOther: round(other / otherScores.length), precision: round(same / (same + other)) }
      }),
      ...(cost.requests > 0 && { cost }),
    },
    null,
    2,
  ),
)
