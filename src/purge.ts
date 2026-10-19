import type { Entry, EntryId, Task, TaskId, View } from './domain'
import { MAX_REWRITE_CHARS, rewriteChars } from './kinds/organizer'
import { tasksWrite } from './kinds/tasks'
import { sanitizeSlug } from './kinds/common'
import { tokenize } from './relevance'

export const PURGED = '[purged]'
/** Shorter words are too common to be what a purge is for, and too likely to hit unrelated text. */
const MIN_WORD = 4
/** A word with its inner joiners kept, so `sk-ab.12` or a URL is one word as well as its parts. */
const COMPOUND = /[\p{L}\p{N}](?:[\p{L}\p{N}_.\-@+/:=]*[\p{L}\p{N}])?/gu
const SYNTAX = /[\\^$.*+?()[\]{}|/]/g

const compounds = (text: string) => (text.match(COMPOUND) ?? []).map((w) => w.toLowerCase())

/**
 * Finds and removes a purged note's words in any text. It matches each of the note's texts whole, and each word of
 * them, compound or part, that no remaining note contains: a page is built only from notes, so such a word on a
 * page came from the purged one. Matching ignores case and stops at word edges.
 */
export interface Scrubber {
  hits(text: string): boolean
  scrub(text: string): string
  /** A slug is a view's id and file name, so it is reported, never rewritten. */
  slugHits(slug: string): boolean
}

export function scrubberFor(given: readonly string[], remaining: readonly Entry[]): Scrubber {
  // A purge cut short may have scrubbed some texts already; the marker it left is not the note's.
  const texts = given.map((t) => t.split(PURGED).join(' '))
  const elsewhere = new Set(remaining.flatMap((e) => [...compounds(e.text), ...tokenize(e.text)]))
  const words = new Set(texts.flatMap((t) => [...compounds(t), ...tokenize(t)]).filter((w) => [...w].length >= MIN_WORD && !elsewhere.has(w) && tokenize(w).length > 0))
  const phrases = new Set(texts.map((t) => t.trim()).filter(Boolean))
  const alternatives = [...phrases, ...words].sort((a, b) => b.length - a.length).map((s) => s.replace(SYNTAX, '\\$&'))
  if (alternatives.length === 0) return { hits: () => false, scrub: (t) => t, slugHits: () => false }
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alternatives.join('|')})(?![\\p{L}\\p{N}_])`, 'giu')
  const slugWords = [...words].map(sanitizeSlug).filter((w) => w.length >= MIN_WORD)
  return {
    hits: (text) => text.search(pattern) !== -1,
    scrub: (text) => text.replace(pattern, PURGED),
    slugHits: (slug) => slugWords.some((w) => `-${slug}-`.includes(`-${w}-`)),
  }
}

/** Every string inside value scrubbed, the rest of it as it was. */
export function scrubDeep<T>(value: T, s: Scrubber): T {
  if (typeof value === 'string') return s.scrub(value) as T
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, s)) as T
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubDeep(v, s)])) as T
  return value
}

export type ViewPurge =
  | { op: 'keep' }
  | { op: 'drop' }
  /** rewrite: the topic is marked stale and queued for a rewrite; false on a topic over the rewrite cap. */
  | { op: 'write'; view: View; rewrite: boolean; tasksDeleted: TaskId[] }

/**
 * What a purge does to one view, from the view and the remaining entries; no I/O. A view that neither cites the note
 * nor holds its words is kept. A topic is dropped when the note was its only source, else it loses the note and its
 * words, and is rewritten unless too big. On the task list, a task that came only from the note is deleted, since
 * nothing else supports it and a scrubbed husk could still say what the note said; other tasks lose the note and its
 * words. Any other view, such as a diagram, is dropped: it is drawn from a page, and is drawn again from the scrubbed one.
 */
export function purgeView(v: View, noteId: EntryId, s: Scrubber, entries: readonly Entry[]): ViewPurge {
  const cites = v.sources.includes(noteId) || v.pins?.excluded?.includes(noteId) || v.tasks?.some((t) => t.sources.includes(noteId))
  const holds = [v.title, v.body, ...(v.pastTitles ?? []).map((p) => p.title), ...(v.tasks ?? []).flatMap((t) => [t.text, t.due ?? ''])].some(s.hits)
  if (!cites && !holds) return { op: 'keep' }
  const without = (ids: EntryId[]) => ids.filter((id) => id !== noteId)
  if (v.kind === 'organizer') {
    const sources = without(v.sources)
    if (v.sources.includes(noteId) && sources.length === 0) return { op: 'drop' }
    const excluded = without(v.pins?.excluded ?? [])
    const { excluded: _, ...pins } = v.pins ?? {}
    const nextPins = { ...pins, ...(excluded.length > 0 && { excluded }) }
    const { bodyStale, pastTitles, pins: __, ...rest } = v
    const body = s.scrub(v.body)
    const rewrite = rewriteChars({ body, sources }, entries) <= MAX_REWRITE_CHARS
    const view: View = {
      ...rest,
      title: s.scrub(v.title),
      sources,
      body,
      ...(pastTitles && { pastTitles: pastTitles.map((p) => ({ ...p, title: s.scrub(p.title) })) }),
      ...(Object.keys(nextPins).length > 0 && { pins: nextPins }),
      ...((rewrite || bodyStale) && { bodyStale: true as const }),
    }
    return { op: 'write', view, rewrite, tasksDeleted: [] }
  }
  if (v.kind === 'tasks' && v.tasks) {
    const only = (t: Task) => t.sources.length > 0 && t.sources.every((id) => id === noteId)
    const kept = v.tasks.filter((t) => !only(t)).map((t) => ({ ...t, text: s.scrub(t.text), ...(t.due && { due: s.scrub(t.due) }), sources: without(t.sources) }))
    return { op: 'write', view: { ...v, ...tasksWrite(kept, entries) }, rewrite: false, tasksDeleted: v.tasks.filter(only).map((t) => t.id) }
  }
  return { op: 'drop' }
}
