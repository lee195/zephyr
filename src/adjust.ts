import type { Adjustment, Entry, EntryId, Pins, Task, View, ViewWrite } from './domain'
import { sanitizeSlug } from './kinds/common'
import { appendSection, MAX_REWRITE_CHARS, rewriteChars, topicsIn, usableTitle } from './kinds/organizer'
import { currentTasks, MAX_DUE_LENGTH, tasksWrite } from './kinds/tasks'

/** The kind whose queue applies each op: the one that owns the views it writes. */
export const OWNER: Record<Adjustment['op'], string> = {
  renameTopic: 'organizer',
  mergeTopics: 'organizer',
  splitTopic: 'organizer',
  moveNote: 'organizer',
  detachNote: 'organizer',
  editNote: 'organizer',
  tombstoneNote: 'organizer',
  editTask: 'tasks',
  completeTask: 'tasks',
  deleteTask: 'tasks',
}

export type Parsed = { ok: true; adjustment: Adjustment } | { ok: false; error: string }

const str = (o: any, key: string) => (typeof o[key] === 'string' && o[key].trim() ? (o[key] as string) : undefined)

/** Checks an adjustment's shape. Whether its topics, notes and tasks exist is checked when it applies. */
export function parseAdjustment(json: unknown): Parsed {
  const o = json as any
  if (!o || typeof o !== 'object' || typeof o.op !== 'string' || !Object.hasOwn(OWNER, o.op))
    return { ok: false, error: `op must be one of ${Object.keys(OWNER).join(', ')}` }
  const need = (...keys: string[]): Parsed | null => {
    const missing = keys.filter((k) => !str(o, k))
    return missing.length ? { ok: false, error: `${o.op} needs non-empty strings: ${missing.join(', ')}` } : null
  }
  const op = o.op as Adjustment['op']
  switch (op) {
    case 'renameTopic':
      return need('slug', 'title') ?? { ok: true, adjustment: { op, slug: o.slug, title: o.title } }
    case 'mergeTopics':
      return need('from', 'into') ?? { ok: true, adjustment: { op, from: o.from, into: o.into } }
    case 'moveNote':
    case 'detachNote':
      return need('noteId', 'from', 'to') ?? { ok: true, adjustment: { op, noteId: o.noteId, from: o.from, to: o.to } }
    case 'splitTopic': {
      const missing = need('slug')
      if (missing) return missing
      if (!Array.isArray(o.noteIds) || o.noteIds.length === 0 || !o.noteIds.every((id: unknown) => typeof id === 'string'))
        return { ok: false, error: 'splitTopic needs noteIds, a non-empty array of note ids' }
      if (!o.into || !str(o.into, 'slug') || !str(o.into, 'title')) return { ok: false, error: 'splitTopic needs into: { slug, title }' }
      return { ok: true, adjustment: { op, slug: o.slug, noteIds: [...new Set<string>(o.noteIds)], into: { slug: o.into.slug, title: o.into.title } } }
    }
    case 'editNote':
      return need('noteId', 'text') ?? { ok: true, adjustment: { op, noteId: o.noteId, text: o.text } }
    case 'tombstoneNote':
      return need('noteId') ?? { ok: true, adjustment: { op, noteId: o.noteId } }
    case 'editTask': {
      const missing = need('taskId')
      if (missing) return missing
      if (o.text !== undefined && !str(o, 'text')) return { ok: false, error: 'editTask text must be a non-empty string' }
      if (o.due !== undefined && o.due !== null && (!str(o, 'due') || o.due.trim().length > MAX_DUE_LENGTH))
        return { ok: false, error: `editTask due must be null or a non-empty string of at most ${MAX_DUE_LENGTH} characters` }
      if (o.text === undefined && o.due === undefined) return { ok: false, error: 'editTask needs text or due' }
      return { ok: true, adjustment: { op, taskId: o.taskId, ...(o.text !== undefined && { text: o.text }), ...(o.due !== undefined && { due: o.due }) } }
    }
    case 'completeTask':
    case 'deleteTask':
      return need('taskId') ?? { ok: true, adjustment: { op, taskId: o.taskId } }
  }
}

/** Corrections over the raw entries, rebuilt from adjustments.jsonl on start. */
export interface Overlay {
  edits: Map<EntryId, string>
  tombstoned: Set<EntryId>
}

/** The entries every kind, hint and ranking reads: raw entries with edits applied and tombstoned ones left out. */
export function effectiveEntries(raw: readonly Entry[], overlay: Overlay): Entry[] {
  return raw.filter((e) => !overlay.tombstoned.has(e.id)).map((e) => (overlay.edits.has(e.id) ? { ...e, text: overlay.edits.get(e.id)! } : e))
}

/** What an adjustment reads: the effective entries before it, the views, and which ids are tombstoned. */
export interface AdjustState {
  entries: readonly Entry[]
  views: readonly View[]
  tombstoned: ReadonlySet<EntryId>
}

/** A view an adjustment writes, with the server-owned fields it sets. */
export interface AdjustWrite {
  kind: string
  write: ViewWrite
  own: Pick<View, 'pins' | 'bodyStale'>
}

export type NoteChange = { edit: EntryId; text: string } | { tombstone: EntryId }

export type Outcome =
  | { ok: true; note?: NoteChange; writes: AdjustWrite[]; deletes: string[]; warnings: string[] }
  | { ok: false; error: string }

const fail = (error: string): Outcome => ({ ok: false, error })
const unchanged: Outcome = { ok: true, writes: [], deletes: [], warnings: [] }

/** The view as a kind would write it, without the fields the server owns. */
export function writeOf(v: View): ViewWrite {
  const { id, kind, updatedAt, createdAt, pastTitles, appendsSinceWrite, pins, bodyStale, ...write } = v
  return write
}

/** Pins with empty parts left out; undefined when nothing is pinned. */
function tidy(p: Pins): Pins | undefined {
  const out: Pins = {
    ...(p.title && { title: true as const }),
    ...(p.excluded?.length && { excluded: p.excluded }),
    ...(p.aliases?.length && { aliases: p.aliases }),
  }
  return Object.keys(out).length ? out : undefined
}

const union = <T>(a: readonly T[] = [], b: readonly T[] = []) => [...new Set([...a, ...b])]
const minus = <T>(a: readonly T[] = [], b: readonly T[] = []) => a.filter((x) => !b.includes(x))

/** Reads organizer topics by slug, and turns a changed topic into a write that is stale unless too big to rewrite. */
class Topics {
  private bySlug: Map<string, View>
  readonly warnings: string[] = []
  constructor(private s: AdjustState, private entries: readonly Entry[] = s.entries) {
    this.bySlug = new Map(topicsIn(s.views).map((v) => [v.slug, v]))
  }
  get(slug: string) {
    return this.bySlug.get(sanitizeSlug(slug))
  }
  /** The topic a merged-away slug now lives in. */
  mergedInto(slug: string) {
    return [...this.bySlug.values()].find((t) => t.pins?.aliases?.includes(sanitizeSlug(slug)))
  }
  missing(slug: string) {
    const into = this.mergedInto(slug)
    return fail(into ? `topic ${slug} was merged into ${into.slug}` : `no topic ${slug}`)
  }
  inOrder(ids: Iterable<EntryId>) {
    const set = new Set(ids)
    return this.s.entries.filter((e) => set.has(e.id)).map((e) => e.id)
  }
  /** A topic whose notes or body changed: its body is marked stale for a rewrite, or a warning says it cannot be. */
  changed(prior: Pick<View, 'slug' | 'title' | 'pins'> & Partial<View>, next: Partial<ViewWrite> & { pins?: Pins }): AdjustWrite {
    const write: ViewWrite = { slug: prior.slug, title: next.title ?? prior.title, sources: next.sources ?? prior.sources!, format: 'md', body: next.body ?? prior.body! }
    const fits = rewriteChars(write, this.entries) <= MAX_REWRITE_CHARS
    if (!fits) this.warnings.push(`topic ${write.slug} is over the ${MAX_REWRITE_CHARS}-character rewrite cap, so its body was not rewritten and may still say what its notes no longer do`)
    const pins = tidy(next.pins ?? prior.pins ?? {})
    return { kind: 'organizer', write, own: { ...(pins && { pins }), ...(fits && { bodyStale: true as const }) } }
  }
}

const live = (s: AdjustState, id: EntryId) => s.entries.find((e) => e.id === id)

function renameTopic(a: Extract<Adjustment, { op: 'renameTopic' }>, s: AdjustState): Outcome {
  const t = new Topics(s)
  const topic = t.get(a.slug)
  if (!topic) return t.missing(a.slug)
  const title = usableTitle(a.title)
  if (!title) return fail('title must be a non-empty string of at most 80 characters')
  if (topic.title === title && topic.pins?.title) return unchanged
  const write = { ...writeOf(topic), title }
  return { ok: true, writes: [{ kind: 'organizer', write, own: { pins: { ...topic.pins, title: true }, ...(topic.bodyStale && { bodyStale: true }) } }], deletes: [], warnings: [] }
}

/** The old body goes onto the target as a section under the old title, and a rewrite then makes one page of it. */
function mergeTopics(a: Extract<Adjustment, { op: 'mergeTopics' }>, s: AdjustState): Outcome {
  const t = new Topics(s)
  const into = t.get(a.into)
  if (!into) return t.missing(a.into)
  const from = t.get(a.from)
  const fromSlug = sanitizeSlug(a.from)
  const merged = into.pins?.aliases?.includes(fromSlug)
  if (!from) return merged ? unchanged : t.missing(a.from)
  if (from.id === into.id) return fail('a topic cannot be merged into itself')
  const deletes = [from.id]
  if (merged) return { ok: true, writes: [], deletes, warnings: [] }
  const sources = t.inOrder(union(into.sources, from.sources))
  const pins: Pins = {
    ...into.pins,
    aliases: union(into.pins?.aliases, [from.slug, ...(from.pins?.aliases ?? [])]),
    excluded: minus(union(into.pins?.excluded, from.pins?.excluded), sources),
  }
  const write = t.changed(into, { sources, body: appendSection(into.body, `## ${from.title}\n\n${from.body}`), pins })
  return { ok: true, writes: [write], deletes, warnings: t.warnings }
}

/** Shared by move and detach: the note leaves `from` and is excluded there; `to` gains it unless it cites it. */
function relocate(a: Extract<Adjustment, { op: 'moveNote' | 'detachNote' }>, s: AdjustState): Outcome {
  const t = new Topics(s)
  const from = t.get(a.from)
  if (!from) return t.missing(a.from)
  const to = t.get(a.to)
  if (!to) return t.missing(a.to)
  if (from.id === to.id) return fail('from and to are the same topic')
  const note = live(s, a.noteId)
  if (!note) return fail(`no note ${a.noteId}`)
  const onFrom = from.sources.includes(note.id)
  const onTo = to.sources.includes(note.id)
  if (!onFrom && onTo && from.pins?.excluded?.includes(note.id)) return unchanged
  if (!onFrom) return fail(`topic ${from.slug} does not cite note ${note.id}`)
  if (a.op === 'moveNote' && onTo) return fail(`topic ${to.slug} already cites note ${note.id}; detachNote takes it off ${from.slug}`)
  if (a.op === 'detachNote' && !onTo) return fail(`topic ${to.slug} does not cite note ${note.id}; moveNote puts it there`)
  if (from.sources.length === 1) return fail(`note ${note.id} is the only note on ${from.slug}; merge ${from.slug} into ${to.slug} instead`)
  const writes = [t.changed(from, { sources: minus(from.sources, [note.id]), pins: { ...from.pins, excluded: union(from.pins?.excluded, [note.id]) } })]
  if (!onTo)
    writes.push(t.changed(to, { sources: t.inOrder([...to.sources, note.id]), body: appendSection(to.body, note.text), pins: { ...to.pins, excluded: minus(to.pins?.excluded, [note.id]) } }))
  return { ok: true, writes, deletes: [], warnings: t.warnings }
}

function splitTopic(a: Extract<Adjustment, { op: 'splitTopic' }>, s: AdjustState): Outcome {
  const t = new Topics(s)
  const topic = t.get(a.slug)
  if (!topic) return t.missing(a.slug)
  const slug = sanitizeSlug(a.into.slug)
  if (!slug) return fail('into.slug is empty after sanitizing')
  const title = usableTitle(a.into.title)
  if (!title) return fail('into.title must be a non-empty string of at most 80 characters')
  const existing = t.get(slug)
  const moved = a.noteIds
  if (existing && moved.every((id) => existing.sources.includes(id) && !topic.sources.includes(id))) return unchanged
  if (existing) return fail(`topic ${slug} already exists`)
  if (t.mergedInto(slug)) return fail(`slug ${slug} was merged into ${t.mergedInto(slug)!.slug}; pick another`)
  const notOn = moved.filter((id) => !topic.sources.includes(id))
  if (notOn.length > 0) return fail(`topic ${topic.slug} does not cite ${notOn.join(', ')}`)
  if (moved.length === topic.sources.length) return fail(`that is every note on ${topic.slug}; renameTopic renames it`)
  const sources = t.inOrder(moved)
  const body = sources.map((id) => live(s, id)!.text.trim()).join('\n\n')
  const writes = [
    t.changed(topic, { sources: minus(topic.sources, moved), pins: { ...topic.pins, excluded: union(topic.pins?.excluded, moved) } }),
    t.changed({ slug, title }, { sources, body, pins: { title: true } }),
  ]
  return { ok: true, writes, deletes: [], warnings: t.warnings }
}

/** Tasks are not re-run on the new text: the person edits them directly. */
function editNote(a: Extract<Adjustment, { op: 'editNote' }>, s: AdjustState): Outcome {
  const note = live(s, a.noteId)
  if (!note) return fail(`no note ${a.noteId}`)
  const text = a.text.trim()
  if (note.text === text) return unchanged
  const t = new Topics(s, s.entries.map((e) => (e.id === note.id ? { ...e, text } : e)))
  // A page too big to rewrite keeps its body, so there is nothing to write; the warning says so.
  const writes = topicsIn(s.views).filter((v) => v.sources.includes(note.id)).map((v) => t.changed(v, {})).filter((w) => w.own.bodyStale)
  return { ok: true, note: { edit: note.id, text }, writes, deletes: [], warnings: t.warnings }
}

/** The note leaves every topic; a topic it was the only note of is deleted. Other kinds' views are reconciled after. */
function tombstoneNote(a: Extract<Adjustment, { op: 'tombstoneNote' }>, s: AdjustState): Outcome {
  if (s.tombstoned.has(a.noteId)) return unchanged
  const note = live(s, a.noteId)
  if (!note) return fail(`no note ${a.noteId}`)
  const t = new Topics(s, s.entries.filter((e) => e.id !== note.id))
  const citing = topicsIn(s.views).filter((v) => v.sources.includes(note.id))
  const deletes = citing.filter((v) => v.sources.length === 1).map((v) => v.id)
  const writes = citing.filter((v) => v.sources.length > 1).map((v) => t.changed(v, { sources: minus(v.sources, [note.id]), pins: { ...v.pins, excluded: minus(v.pins?.excluded, [note.id]) } }))
  const tasks = currentTasks(s.views).filter((task) => task.sources.length === 1 && task.sources[0] === note.id)
  const warnings = [...t.warnings, ...tasks.map((task) => `task ${task.id} came only from this note and stays; deleteTask removes it`)]
  return { ok: true, note: { tombstone: note.id }, writes, deletes, warnings }
}

function changeTask(s: AdjustState, taskId: string, change: (task: Task) => Task | null): Outcome {
  const tasks = currentTasks(s.views)
  const task = tasks.find((x) => x.id === taskId)
  if (!task) return fail(`no task ${taskId}`)
  const next = change(task)
  if (next && next.text === task.text && next.due === task.due && next.done === task.done) return unchanged
  const list = next ? tasks.map((x) => (x.id === taskId ? next : x)) : tasks.filter((x) => x.id !== taskId)
  return { ok: true, writes: [{ kind: 'tasks', write: tasksWrite(list, s.entries), own: {} }], deletes: [], warnings: [] }
}

/** The new state of the views an adjustment touches, computed from the state before it; no I/O. */
export function planAdjustment(a: Adjustment, s: AdjustState): Outcome {
  switch (a.op) {
    case 'renameTopic':
      return renameTopic(a, s)
    case 'mergeTopics':
      return mergeTopics(a, s)
    case 'splitTopic':
      return splitTopic(a, s)
    case 'moveNote':
    case 'detachNote':
      return relocate(a, s)
    case 'editNote':
      return editNote(a, s)
    case 'tombstoneNote':
      return tombstoneNote(a, s)
    case 'editTask':
      return changeTask(s, a.taskId, (task) => {
        const { due, ...rest } = task
        const nextDue = a.due === undefined ? due : (a.due?.trim() ?? undefined)
        return { ...rest, ...(a.text && { text: a.text.trim() }), ...(nextDue && { due: nextDue }) }
      })
    case 'completeTask':
      return changeTask(s, a.taskId, (task) => ({ ...task, done: true }))
    case 'deleteTask':
      return changeTask(s, a.taskId, () => null)
  }
}

/** The view without the tombstoned ids among its sources and its tasks' sources, or null when it cites none. */
export function withoutTombstoned(v: View, tombstoned: ReadonlySet<EntryId>): ViewWrite | null {
  const keep = (ids: EntryId[]) => ids.filter((id) => !tombstoned.has(id))
  const cites = v.sources.some((id) => tombstoned.has(id)) || v.tasks?.some((task) => task.sources.some((id) => tombstoned.has(id)))
  if (!cites) return null
  const write = writeOf(v)
  return { ...write, sources: keep(write.sources), ...(write.tasks && { tasks: write.tasks.map((task) => ({ ...task, sources: keep(task.sources) })) }) }
}
