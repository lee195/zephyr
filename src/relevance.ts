export interface RelevanceDoc {
  id: string
  text: string
}

export interface Scored {
  id: string
  score: number
}

/** Ranks docs by relevance to a query, best first. Every doc appears once in the result. */
export interface RelevanceBackend {
  rank(query: string, docs: RelevanceDoc[]): Scored[]
}

const MIN_TOKEN_LENGTH = 3

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= MIN_TOKEN_LENGTH)
}

function termCounts(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1)
  return counts
}

/** Cosine similarity of sublinear-tf, smoothed-idf vectors; idf comes from the docs alone. */
function tfidf(): RelevanceBackend {
  return {
    rank(query, docs) {
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
      return scored.sort((a, b) => b.score - a.score)
    },
  }
}

export const relevanceBackends: Record<string, () => RelevanceBackend> = { tfidf }
