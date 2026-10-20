import type { Adjustment, Entry, EntryId, Task, TaskId, View } from './domain'
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
 * Finds and removes a purged note's words in any text. It matches each of the note's texts whole, and words of
 * them, compound or part, that no remaining note contains: a page is built only from notes, so such a word on a page
 * that cited the note came from it. Matching ignores case and stops at word edges.
 */
export interface Scrubber {
  hits(text: string): boolean
  scrub(text: string): string
  /** A slug is a view's id and file name, so it is reported, never rewritten. */
  slugHits(slug: string): boolean
}

/**
 * full: the note's texts and every distinctive word, for what cited the note, where a plain word can only have come
 * from it. wide: the note's texts and its token-like words only, for everything else, where the same plain word may
 * have come from the model or a note since deleted, and replacing it would garble an unrelated page.
 */
export interface Scrubbers {
  full: Scrubber
  wide: Scrubber
}

/**
 * A word with an inner joiner other than a hyphen, or with letters and digits mixed: a key, URL, address or id. A
 * plain number or a hyphenated word such as follow-up is not; prose is full of both.
 */
const TOKEN_LIKE = /[\p{L}\p{N}][_.@+/:=][\p{L}\p{N}]|\p{L}.*\p{N}|\p{N}.*\p{L}/u

export function scrubbersFor(given: readonly string[], remaining: readonly Entry[]): Scrubbers {
  // A purge cut short may have scrubbed some texts already; the marker it left is not the note's.
  const texts = given.map((t) => t.split(PURGED).join(' '))
  const elsewhere = new Set(remaining.flatMap((e) => [...compounds(e.text), ...tokenize(e.text)]))
  const unshared = (w: string) => [...w].length >= MIN_WORD && !elsewhere.has(w)
  // A token such as zk-77.qq is distinctive though no part of it is a word tokenize keeps.
  const tokens = new Set(texts.flatMap(compounds).filter((w) => unshared(w) && TOKEN_LIKE.test(w)))
  const words = new Set([...texts.flatMap((t) => [...compounds(t), ...tokenize(t)]).filter((w) => unshared(w) && tokenize(w).length > 0), ...tokens])
  const phrases = new Set(texts.map((t) => t.trim()).filter(Boolean))
  return { full: scrubberOf(phrases, words), wide: scrubberOf(phrases, tokens) }
}

function scrubberOf(phrases: ReadonlySet<string>, words: ReadonlySet<string>): Scrubber {
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

/** The view cites the note: as a source, an excluded note, or a task's source. */
export const citesNote = (v: View, noteId: EntryId) =>
  v.sources.includes(noteId) || !!v.pins?.excluded?.includes(noteId) || !!v.tasks?.some((t) => t.sources.includes(noteId))

/**
 * What a purge matches with the full scrubber. views: ids of the views that cite the note, of the topics it was moved,
 * detached or split off, followed through later merges, and of the diagrams drawn from any of them. history: every
 * `kind/slug` whose archived versions may hold the note's text, merged-away slugs included, and for each such topic
 * slug the same slug under every kind in derivedKinds, whose views are drawn from topics.
 */
export interface PurgeScope {
  views: string[]
  history: string[]
}

export function purgeScope(views: readonly View[], noteId: EntryId, adjustments: readonly Adjustment[], derivedKinds: readonly string[] = []): PurgeScope {
  const slugs = new Set<string>()
  for (const a of adjustments) {
    if ((a.op === 'moveNote' || a.op === 'detachNote') && a.noteId === noteId) slugs.add(a.from)
    else if (a.op === 'splitTopic' && a.noteIds.includes(noteId)) slugs.add(a.slug)
    else if (a.op === 'mergeTopics' && slugs.has(a.from)) slugs.add(a.into)
  }
  const topics = views.filter((v) => v.kind === 'organizer')
  const inScope = new Set(views.filter((v) => citesNote(v, noteId)).map((v) => v.id))
  for (const t of topics) if ([t.slug, ...(t.pins?.aliases ?? [])].some((s) => slugs.has(s))) inScope.add(t.id)
  for (const v of views) if (v.derivedFrom && inScope.has(v.derivedFrom.id)) inScope.add(v.id)
  const history = new Set([...slugs].map((s) => `organizer/${s}`))
  for (const v of views) {
    if (!inScope.has(v.id)) continue
    history.add(`${v.kind}/${v.slug}`)
    for (const alias of v.pins?.aliases ?? []) history.add(`${v.kind}/${alias}`)
  }
  // A diagram shares its topic's slug, and its archive outlives a topic merged or deleted away.
  for (const h of [...history]) if (h.startsWith('organizer/')) for (const k of derivedKinds) history.add(`${k}/${h.slice('organizer/'.length)}`)
  return { views: [...inScope].sort(), history: [...history].sort() }
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
  const cites = citesNote(v, noteId)
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
