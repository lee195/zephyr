import type { Entry, EntryId, View } from './domain'
import { tokenize, type RelevanceBackend } from './relevance'

export interface Hint {
  entryId: EntryId
  text: string
  at: string
  score: number
  topic: { slug: string; title: string } | null
}

/**
 * The lowest score a hint may have, per backend, because each backend scores on its own scale. Measured with
 * scripts/measure-relevance.ts on the organizer fixture corpus, among top-5 hits:
 * - tfidf 0.14 keeps 28% of same-subject hits and 12% of other-subject ones (precision 36%). Realistic related
 *   drafts scored 0.147 and up, unrelated ones under 0.127.
 * - embeddinggemma2 0.80 keeps 25% of same-subject hits and 7% of other-subject ones (precision 76%). Related
 *   drafts scored 0.815 and up, unrelated ones 0.788 and under. Its scores sit in a narrow band (top-5 p25 0.76).
 * A backend missing here has no measured threshold, so it gives no hints.
 */
export const MIN_HINT_SCORE: Readonly<Record<string, number>> = { tfidf: 0.14, 'embedding-embeddinggemma2': 0.8 }
/** A longer draft is ranked on its first this-many characters. */
export const MAX_DRAFT_CHARS = 2000
const MIN_DRAFT_TOKENS = 2

/** Stored entries related to a draft, best first; never calls a model. */
export async function hintsFor(draft: string, limit: number, entries: readonly Entry[], views: readonly View[], relevance: RelevanceBackend): Promise<Hint[]> {
  const query = draft.slice(0, MAX_DRAFT_CHARS)
  if (tokenize(query).length < MIN_DRAFT_TOKENS) return []
  const same = draft.trim()
  const byId = new Map(entries.filter((e) => e.text.trim() !== same).map((e) => [e.id, e]))
  const topics = new Map<EntryId, View>()
  for (const v of views) if (v.kind === 'organizer') for (const id of v.sources) if (!topics.has(id)) topics.set(id, v)
  const { backend, scored } = await relevance.rank(query, [...byId.values()])
  const min = MIN_HINT_SCORE[backend] ?? Infinity
  return scored
    .filter((s) => s.score >= min)
    .slice(0, limit)
    .map(({ id, score }) => {
      const e = byId.get(id)!
      const topic = topics.get(id)
      return { entryId: id, text: e.text, at: e.at, score, topic: topic ? { slug: topic.slug, title: topic.title } : null }
    })
}
