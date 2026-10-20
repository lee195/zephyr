import type { ChatMessage, Entry, View } from './domain'
import { jsonPrompt, promptEntry, sanitizeSlug } from './kinds/common'
import { topicDocs } from './kinds/organizer'
import { rankAll, type RelevanceBackend } from './relevance'

/**
 * Note characters one summary is shown: about 8k tokens, the budget a topic rewrite gets. One call then stays a
 * quick reply the model reads in full; past the cap the summary covers the newest notes and says how many it left out.
 */
export const MAX_SUMMARY_CHARS = 32_000

export interface SummaryInput {
  /** The newest notes whose texts fit the cap together, oldest first. */
  notes: Entry[]
  /** Older notes of the window left out to stay within the cap. */
  leftOut: number
}

/** `notes` are the window's notes, oldest first. */
export function summaryInput(notes: readonly Entry[]): SummaryInput {
  let start = notes.length
  let chars = 0
  while (start > 0 && chars + notes[start - 1]!.text.length <= MAX_SUMMARY_CHARS) chars += notes[--start]!.text.length
  return { notes: notes.slice(start), leftOut: start }
}

const SUMMARY_SYSTEM = `You summarize one session of a person's notes for them, after they took them.
Reply with JSON only: {"summary":string}
The input has sessionNotes, oldest first, each with the titles of the topics it was filed under.
- summary is markdown: a few short paragraphs or bullets on what the session was about, grouped by subject.
- Call something a decision, an open question or a thing to do only where a note says it is one. Add no heading or label of your own, such as "To do:" or "Open questions", and no section for a kind the notes do not have.
- Use only what the notes say; add nothing. Later notes correct earlier ones.`

export function summaryMessages(input: SummaryInput, topics: readonly View[]): ChatMessage[] {
  const filedUnder = (id: string) => topics.filter((t) => t.sources.includes(id)).map((t) => t.title)
  return jsonPrompt(SUMMARY_SYSTEM, { sessionNotes: input.notes.map((e) => ({ ...promptEntry(e), topics: filedUnder(e.id) })) })
}

export function parseSummary(json: unknown): { ok: true; summary: string } | { ok: false; error: string } {
  const summary = (json as any)?.summary
  return typeof summary === 'string' && summary.trim() ? { ok: true, summary: summary.trim() } : { ok: false, error: 'reply has no summary string' }
}

/**
 * Topics one link suggestion is shown, one index line each, the most recently updated first: at most about 6k
 * tokens of index. The rest are left out and counted.
 */
export const MAX_LINK_TOPICS = 200
/** Pairs one suggestion may return: each is a question the person has to answer. */
export const MAX_LINKS = 5
/** A reason is one line the person reads before saying yes. */
const MAX_REASON_CHARS = 200

export interface LinkIndex {
  topics: View[]
  leftOut: number
}

export function linkIndex(topics: readonly View[]): LinkIndex {
  const newest = [...topics].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  return { topics: newest.slice(0, MAX_LINK_TOPICS), leftOut: Math.max(0, newest.length - MAX_LINK_TOPICS) }
}

const LINKS_SYSTEM = `You find related topics among a person's topic pages of notes.
Reply with JSON only: {"links":[{"a":slug,"b":slug,"strength":"strong"|"weak","reason":string}, ...]}
The input has topics, one line each: "slug | title | N sources".
- A link joins two topics that are about related subjects, where a reader of one would want to know of the other, but that are different enough to stay separate pages.
- Do not link two topics that are about the same subject; those should be merged, not linked.
- reason is one short sentence saying how the two relate.
- strength is strong when a reader of one would clearly want the other, weak when the link is a stretch.
- At most ${MAX_LINKS} links, the strongest first. An empty list is fine.`

export function linkMessages(index: LinkIndex): ChatMessage[] {
  return jsonPrompt(LINKS_SYSTEM, { topics: index.topics.map((v) => `${v.slug} | ${v.title} | ${v.sources.length} sources`) })
}

/** How alike two topics' pages are, by the relevance backend, keyed by their slugs in sorted order. */
export interface LinkScores {
  backend: string
  scores: Map<string, number>
}

export const pairKey = (a: string, b: string) => [a, b].sort().join(' ')

/**
 * Scores each pair by the relevance backend, with the first topic's page as the query; one ranking per distinct first
 * topic. Null when the backend could not score them all, or switched backends midway, so no pair is judged on a
 * partial or mixed ranking.
 */
export async function linkPairScores(relevance: RelevanceBackend, pairs: readonly (readonly [View, View])[]): Promise<LinkScores | null> {
  const byFirst = new Map<string, { a: View; bs: View[] }>()
  for (const [a, b] of pairs) {
    const group = byFirst.get(a.id) ?? byFirst.set(a.id, { a, bs: [] }).get(a.id)!
    if (!group.bs.some((v) => v.id === b.id)) group.bs.push(b)
  }
  const scores = new Map<string, number>()
  let backend = ''
  for (const { a, bs } of byFirst.values()) {
    const docs = topicDocs(bs)
    const ranking = await rankAll(relevance, topicDocs([a])[0]!.text, docs)
    if (ranking.partial || ranking.scored.length < docs.length || (backend && ranking.backend !== backend)) return null
    backend = ranking.backend
    const slugOf = new Map(bs.map((b) => [b.id, b.slug]))
    for (const { id, score } of ranking.scored) {
      const key = pairKey(a.slug, slugOf.get(id)!)
      scores.set(key, Math.max(score, scores.get(key) ?? -Infinity))
    }
  }
  return { backend, scores }
}

/** The pairs a links reply names among the shown topics, before any check: the ones worth scoring. */
export function proposedPairs(json: unknown, shown: readonly View[]): [View, View][] {
  const bySlug = new Map(shown.map((v) => [v.slug, v]))
  const raw = (json as any)?.links
  if (!Array.isArray(raw)) return []
  return raw.flatMap((l: any) => {
    const [a, b] = [l?.a, l?.b].map((x) => (typeof x === 'string' ? bySlug.get(sanitizeSlug(x)) : undefined))
    return a && b && a.id !== b.id ? [[a, b] as [View, View]] : []
  })
}

export interface Link {
  a: { slug: string; title: string }
  b: { slug: string; title: string }
  reason: string
}

/**
 * Parses `{ links: [...] }`. A malformed reply fails as a whole. A link to a topic not shown, a topic linked to
 * itself, a pair already linked or already suggested, one the model called weak, one whose topics score below
 * MIN_LINK_SCORE in `scores`, a link with no usable reason and every link past the cap are dropped with a reason.
 */
/**
 * Per relevance backend, the pair score below which two topics are too unlike to link. Measured on the corpus by
 * scripts/measure-deeper.ts --item links; a backend without one gates nothing.
 */
export const MIN_LINK_SCORE = new Map([['embedding-embeddinggemma2', 0.73]])

export function validateLinks(json: unknown, shown: readonly View[], scores?: LinkScores | null): { ok: true; links: Link[]; dropped: string[] } | { ok: false; error: string } {
  const min = scores ? MIN_LINK_SCORE.get(scores.backend) : undefined
  const raw = (json as any)?.links
  if (!Array.isArray(raw)) return { ok: false, error: 'reply has no links array' }
  const bySlug = new Map(shown.map((v) => [v.slug, v]))
  const links: Link[] = []
  const dropped: string[] = []
  const seen = new Set<string>()
  const slug = (s: unknown) => (typeof s === 'string' ? sanitizeSlug(s) : '')
  const pair = (a: View, b: View) => [a.slug, b.slug].sort().join(' ')
  for (const [i, l] of raw.entries()) {
    const [a, b] = [bySlug.get(slug(l?.a)), bySlug.get(slug(l?.b))]
    const reason = typeof l?.reason === 'string' ? l.reason.trim().split('\n')[0]!.trim() : ''
    const refused = (): string | null => {
      if (!a || !b) return `no such topic: ${[l?.a, l?.b].filter((s) => !bySlug.has(slug(s))).map(String).join(', ')}`
      if (a.slug === b.slug) return 'a topic linked to itself'
      if (a.related?.includes(b.slug)) return 'already linked'
      if (seen.has(pair(a, b))) return 'suggested twice'
      if (l?.strength === 'weak') return 'the model called it weak'
      const score = scores?.scores.get(pairKey(a.slug, b.slug))
      if (min !== undefined && score !== undefined && score < min) return `topics too dissimilar (${score.toFixed(2)} < ${min})`
      if (!reason || reason.length > MAX_REASON_CHARS) return `reason is not one line of at most ${MAX_REASON_CHARS} characters`
      if (links.length >= MAX_LINKS) return `over the cap of ${MAX_LINKS} links`
      return null
    }
    const why = refused()
    if (why) {
      dropped.push(`link ${i}: ${why}`)
      continue
    }
    seen.add(pair(a!, b!))
    links.push({ a: { slug: a!.slug, title: a!.title }, b: { slug: b!.slug, title: b!.title }, reason })
  }
  return { ok: true, links, dropped }
}
