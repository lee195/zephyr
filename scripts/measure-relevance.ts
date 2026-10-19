/**
 * Measures a relevance backend on a subject-labelled corpus, offline and without a model.
 *
 *   bun scripts/measure-relevance.ts [corpus.json] [--backend tfidf]
 *
 * Each note is ranked against every other note; a hit is relevant when it shares the note's subject.
 * Prints JSON: top-1 / recall@3 / recall@5 / MRR over all notes, and how a score threshold splits the
 * top-5 hits into same-subject and other-subject ones, with the share of kept hits that are same-subject (precision).
 */
import { parseArgs } from 'node:util'
import { relevanceBackends } from '../src/relevance'

interface Note {
  id: string
  subject: string
  text: string
}

const THRESHOLDS = [0.1, 0.12, 0.14, 0.15, 0.2]
const TOP_K = 5

const { values, positionals } = parseArgs({ args: Bun.argv.slice(2), allowPositionals: true, options: { backend: { type: 'string', default: 'tfidf' } } })
const corpusPath = positionals[0] ?? new URL('./fixtures/organizer-corpus.json', import.meta.url).pathname
const makeBackend = relevanceBackends[values.backend!]
if (!makeBackend) throw new Error(`unknown backend ${values.backend}; known: ${Object.keys(relevanceBackends).join(', ')}`)
const backend = makeBackend()

const corpus = (await Bun.file(corpusPath).json()) as { subjects: { slug: string; notes: string[] }[] }
const notes: Note[] = corpus.subjects.flatMap((s) => s.notes.map((text, i) => ({ id: `${s.slug}#${i}`, subject: s.slug, text })))
const subjectOf = new Map(notes.map((n) => [n.id, n.subject]))

let top1 = 0
let at3 = 0
let at5 = 0
let reciprocalRanks = 0
const sameScores: number[] = []
const otherScores: number[] = []
for (const q of notes) {
  const ranked = backend.rank(q.text, notes.filter((n) => n !== q))
  const firstHit = ranked.findIndex((r) => subjectOf.get(r.id) === q.subject)
  if (firstHit === 0) top1++
  if (firstHit >= 0 && firstHit < 3) at3++
  if (firstHit >= 0 && firstHit < 5) at5++
  if (firstHit >= 0) reciprocalRanks += 1 / (firstHit + 1)
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
      subjects: corpus.subjects.length,
      top1: { hits: top1, rate: round(top1 / notes.length) },
      recallAt3: round(at3 / notes.length),
      recallAt5: round(at5 / notes.length),
      mrr: round(reciprocalRanks / notes.length),
      top5Scores: {
        same: { n: sameScores.length, p25: quantile(sameScores, 0.25), p50: quantile(sameScores, 0.5), p75: quantile(sameScores, 0.75) },
        other: { n: otherScores.length, p50: quantile(otherScores, 0.5), p75: quantile(otherScores, 0.75), p90: quantile(otherScores, 0.9) },
      },
      thresholds: THRESHOLDS.map((t) => {
        const same = sameScores.filter((x) => x >= t).length
        const other = otherScores.filter((x) => x >= t).length
        return { threshold: t, keepsSame: round(same / sameScores.length), keepsOther: round(other / otherScores.length), precision: round(same / (same + other)) }
      }),
    },
    null,
    2,
  ),
)
