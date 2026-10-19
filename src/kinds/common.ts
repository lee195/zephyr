import type { ChatMessage, Entry, EntryId, Question } from '../domain'

export function sanitizeSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}

/** The cited ids in entry order, so a view's sources read oldest first however they were collected. */
export function inEntryOrder(entries: readonly Entry[], cited: ReadonlySet<EntryId>): EntryId[] {
  return entries.filter((e) => cited.has(e.id)).map((e) => e.id)
}

/** Ids the model may cite: strings among the known ids, deduplicated. */
export function knownSources(raw: unknown[], known: ReadonlySet<EntryId>): EntryId[] {
  return [...new Set(raw.filter((s): s is string => typeof s === 'string' && known.has(s)))]
}

/** An entry as every kind shows it to the model. */
export const promptEntry = (e: Entry) => ({ id: e.id, at: e.at, text: e.text })

/** A kind's prompt: its rules as the system message, then the run's input as one JSON user message. */
export function jsonPrompt(system: string, payload: unknown): ChatMessage[] {
  return [
    { role: 'system', content: system },
    { role: 'user', content: JSON.stringify(payload) },
  ]
}

/**
 * Questions one run may raise. A run is usually one note, and a review is a conversation with the person: past two
 * doubts a run is guessing, not doubting, and its questions would bury the ones that matter.
 */
export const MAX_QUESTIONS = 2

/**
 * Parses a reply's `questions`, absent or null meaning none. The reply's ops apply whatever this finds, so nothing
 * here fails the run: an element `check` refuses, a second question about the same note, and every question past
 * the cap are dropped with a reason.
 */
export function parseQuestions(raw: unknown, check: (q: Record<string, any>) => Question | string): { questions: Question[]; dropped: string[] } {
  if (raw == null) return { questions: [], dropped: [] }
  if (!Array.isArray(raw)) return { questions: [], dropped: ['questions is not an array, so none were asked'] }
  const questions: Question[] = []
  const dropped: string[] = []
  for (const [i, q] of raw.entries()) {
    const checked = q && typeof q === 'object' && !Array.isArray(q) ? check(q) : 'not an object'
    if (typeof checked === 'string') dropped.push(`question ${i}: ${checked}`)
    else if (questions.some((other) => other.noteId === checked.noteId)) dropped.push(`question ${i}: note ${checked.noteId} was already asked about`)
    else if (questions.length >= MAX_QUESTIONS) dropped.push(`question ${i}: over the cap of ${MAX_QUESTIONS} questions per run`)
    else questions.push(checked)
  }
  return { questions, dropped }
}
