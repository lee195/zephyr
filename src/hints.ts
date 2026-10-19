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
 * Measured with scripts/measure-relevance.ts on the organizer fixture corpus: among top-5 hits, 0.14 keeps 28% of
 * same-subject hits and 12% of other-subject ones (36% of kept hits are same-subject); 0.15 keeps 21% for the same
 * 37% precision. Realistic related drafts scored 0.147 and up, unrelated ones under 0.127.
 */
export const MIN_HINT_SCORE = 0.14
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
  const { scored } = await relevance.rank(query, [...byId.values()])
  return scored
    .filter((s) => s.score >= MIN_HINT_SCORE)
    .slice(0, limit)
    .map(({ id, score }) => {
      const e = byId.get(id)!
      const topic = topics.get(id)
      return { entryId: id, text: e.text, at: e.at, score, topic: topic ? { slug: topic.slug, title: topic.title } : null }
    })
}
