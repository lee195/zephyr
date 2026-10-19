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
 * On the organizer fixture corpus, tfidf hits that share only common words with the draft score around 0.10,
 * and 0.15 drops 91% of off-topic top-5 hits; realistic related drafts scored 0.157 and up, unrelated ones under 0.125.
 */
export const MIN_HINT_SCORE = 0.15
/** A longer draft is ranked on its first this-many characters. */
export const MAX_DRAFT_CHARS = 2000
const MIN_DRAFT_TOKENS = 2

/** Stored entries related to a draft, best first; never calls a model. */
export function hintsFor(draft: string, limit: number, entries: readonly Entry[], views: readonly View[], relevance: RelevanceBackend): Hint[] {
  const query = draft.slice(0, MAX_DRAFT_CHARS)
  if (tokenize(query).length < MIN_DRAFT_TOKENS) return []
  const same = draft.trim()
  const byId = new Map(entries.filter((e) => e.text.trim() !== same).map((e) => [e.id, e]))
  const topics = new Map<EntryId, View>()
  for (const v of views) if (v.kind === 'organizer') for (const id of v.sources) if (!topics.has(id)) topics.set(id, v)
  return relevance
    .rank(query, [...byId.values()])
    .filter((s) => s.score >= MIN_HINT_SCORE)
    .slice(0, limit)
    .map(({ id, score }) => {
      const e = byId.get(id)!
      const topic = topics.get(id)
      return { entryId: id, text: e.text, at: e.at, score, topic: topic ? { slug: topic.slug, title: topic.title } : null }
    })
}
