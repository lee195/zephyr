import type { Entry, EntryId, TopicRef, View } from './domain'
import { topicsIn } from './kinds/organizer'
import { tokenize, type RelevanceBackend } from './relevance'

export interface Hint {
  entryId: EntryId
  text: string
  at: string
  score: number
  /** Every topic that cites the note, in view order; empty when none does. */
  topics: TopicRef[]
}

/** Each note's topics: every organizer view that cites it, in view order. */
export function topicsByNote(views: readonly View[]): Map<EntryId, TopicRef[]> {
  const byNote = new Map<EntryId, TopicRef[]>()
  for (const v of topicsIn(views)) for (const id of v.sources) byNote.set(id, [...(byNote.get(id) ?? []), { slug: v.slug, title: v.title }])
  return byNote
}

/** A longer draft is ranked on its first this-many characters. */
export const MAX_DRAFT_CHARS = 2000
/** The most hints one request may ask for: the band shows 3, a lookup lists up to this many. */
export const MAX_HINT_LIMIT = 10
const MIN_DRAFT_TOKENS = 2

export interface HintReply {
  hints: Hint[]
  /** The backend that ranked, or null when the draft was too short to rank. */
  backend: string | null
  /** Some entries were not ranked because the backend was not ready for them yet. */
  partial: boolean
}

/**
 * Stored entries related to a draft, best first, cut at the answering backend's minRelatedScore; never calls a
 * model and never waits on embedding entries.
 */
export async function hintsFor(draft: string, limit: number, entries: readonly Entry[], views: readonly View[], relevance: RelevanceBackend): Promise<HintReply> {
  const query = draft.slice(0, MAX_DRAFT_CHARS)
  if (tokenize(query).length < MIN_DRAFT_TOKENS) return { hints: [], backend: null, partial: false }
  const same = draft.trim()
  const byId = new Map(entries.filter((e) => e.text.trim() !== same).map((e) => [e.id, e]))
  const topics = topicsByNote(views)
  const { backend, scored, partial, minRelatedScore } = await relevance.rank(query, [...byId.values()])
  const hints = scored
    .filter((s) => s.score >= minRelatedScore)
    .slice(0, limit)
    .map(({ id, score }) => {
      const e = byId.get(id)!
      return { entryId: id, text: e.text, at: e.at, score, topics: topics.get(id) ?? [] }
    })
  return { hints, backend, partial: partial === true }
}
