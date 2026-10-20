import type { Adjustment, Area, Entry, EntryId, Pins, SpacePins, Task, View, ViewWrite } from './domain'
import { sanitizeSlug } from './kinds/common'
import { areasOf, mapIn, mapWrite, placeIn } from './kinds/map'
import { appendSection, MAX_REWRITE_CHARS, rewriteChars, topicsIn, usableTitle } from './kinds/organizer'
import { currentTasks, MAX_DUE_LENGTH, tasksWrite } from './kinds/tasks'

/** How a field is checked and stated: a non-empty string, optional or required; a due date; note ids; a new topic. */
type FieldKind = 'text' | 'optionalText' | 'due' | 'ids' | 'ref'

/** The kind a field's type in Adjustment must have, so the spec below cannot drift from the type. */
type KindOf<T> = [T] extends [string[]] ? 'ids' : [T] extends [{ slug: string; title: string }] ? 'ref' : null extends T ? 'due' : undefined extends T ? 'optionalText' : 'text'

type OpSpec<A> = {
  /** The kind whose queue applies the op: the one that owns the views it writes. Absent: every kind's, in turn. */
  owner?: string
  describe: string
  fields: { [K in Exclude<keyof A, 'op'>]-?: { kind: KindOf<A[K]>; describe: string } }
  /** At least one of these optional fields must be given. */
  needsOne?: readonly (keyof A & string)[]
  /** A rule across fields, checked once each field has its type; the reason when the op breaks it. */
  check?: (a: A) => string | undefined
}

/** An op's spec with its field names erased, as the generic code below reads it. */
type AnySpec = {
  describe: string
  fields: Record<string, { kind: FieldKind; describe: string }>
  needsOne?: readonly string[]
  check?: (a: Adjustment) => string | undefined
}

/** The confirmation a purge needs: a value a person types, which a model cannot produce by filling in a flag. */
export const purgeConfirmation = (noteId: string) => `purge ${noteId}`

/** Each op's fields, read by parseAdjustment and by the MCP tools' input schemas. */
export const OPS: { [Op in Adjustment['op']]: OpSpec<Extract<Adjustment, { op: Op }>> } = {
  renameTopic: {
    owner: 'organizer',
    describe: 'Set a topic title and pin it against later runs.',
    fields: { slug: { kind: 'text', describe: 'topic slug' }, title: { kind: 'text', describe: 'new title' } },
  },
  mergeTopics: {
    owner: 'organizer',
    describe: 'Merge topic `from` into topic `into`; `from` is deleted and its slug becomes an alias of `into`.',
    fields: { from: { kind: 'text', describe: 'slug of the topic merged away' }, into: { kind: 'text', describe: 'slug of the topic that stays' } },
  },
  splitTopic: {
    owner: 'organizer',
    describe: 'Move some, not all, of a topic\'s notes to a new topic with a pinned title.',
    fields: {
      slug: { kind: 'text', describe: 'slug of the topic split' },
      noteIds: { kind: 'ids', describe: 'ids of the notes that move' },
      into: { kind: 'ref', describe: 'the new topic' },
    },
  },
  moveNote: {
    owner: 'organizer',
    describe: 'Take a note off topic `from` and put it on topic `to`, which does not cite it yet.',
    fields: { noteId: { kind: 'text', describe: 'note id' }, from: { kind: 'text', describe: 'slug of the topic it leaves' }, to: { kind: 'text', describe: 'slug of the topic it joins' } },
  },
  detachNote: {
    owner: 'organizer',
    describe: 'Take a note off topic `from`; topic `to` already cites it and keeps it.',
    fields: { noteId: { kind: 'text', describe: 'note id' }, from: { kind: 'text', describe: 'slug of the topic it leaves' }, to: { kind: 'text', describe: 'slug of the topic that keeps it' } },
  },
  editNote: {
    owner: 'organizer',
    describe: 'Replace a note\'s text; the topics citing it are rewritten.',
    fields: { noteId: { kind: 'text', describe: 'note id' }, text: { kind: 'text', describe: 'new text' } },
  },
  tombstoneNote: {
    owner: 'organizer',
    describe: 'Remove a note from every topic, hint and ranking; a topic left with no notes is deleted.',
    fields: { noteId: { kind: 'text', describe: 'note id' } },
  },
  editTask: {
    owner: 'tasks',
    describe: 'Change a task\'s text or due date.',
    fields: {
      taskId: { kind: 'text', describe: 'task id' },
      text: { kind: 'optionalText', describe: 'new text' },
      due: { kind: 'due', describe: 'new due date as written, or null to clear it' },
    },
    needsOne: ['text', 'due'],
  },
  completeTask: { owner: 'tasks', describe: 'Mark a task done.', fields: { taskId: { kind: 'text', describe: 'task id' } } },
  deleteTask: { owner: 'tasks', describe: 'Delete a task.', fields: { taskId: { kind: 'text', describe: 'task id' } } },
  linkTopics: {
    owner: 'organizer',
    describe: 'Mark two topics as related but separate pages; each then lists the other. Apply a suggested link only after the person says yes.',
    fields: { a: { kind: 'text', describe: 'slug of one topic' }, b: { kind: 'text', describe: 'slug of the other topic' } },
  },
  unlinkTopics: {
    owner: 'organizer',
    describe: 'Take the related link between two topics off both.',
    fields: { a: { kind: 'text', describe: 'slug of one topic' }, b: { kind: 'text', describe: 'slug of the other topic' } },
  },
  moveTopicToSpace: {
    owner: 'map',
    describe: 'Put a topic in a space of the map, an existing one by its slug or a new one by its title, and pin it there against later map runs.',
    fields: { slug: { kind: 'text', describe: 'topic slug' }, space: { kind: 'text', describe: 'slug of an existing space, or the title of a new one' } },
  },
  renameSpace: {
    owner: 'map',
    describe: 'Set the title of a space of the map and pin it against later map runs.',
    fields: { space: { kind: 'text', describe: 'space slug' }, title: { kind: 'text', describe: 'new title' } },
  },
  purgeNote: {
    describe:
      "Remove a note and every copy of its words from Zephyr's data, for a pasted secret or something private; it cannot be undone. Call it only when the person explicitly asks to purge that note. The harness transcript keeps its own copy.",
    fields: {
      noteId: { kind: 'text', describe: 'note id' },
      confirm: { kind: 'text', describe: 'exactly "purge <noteId>", such as "purge abc123"' },
    },
    check: (a) => (a.confirm === purgeConfirmation(a.noteId) ? undefined : `purgeNote needs confirm to be exactly "${purgeConfirmation(a.noteId)}"`),
  },
}

export type Parsed = { ok: true; adjustment: Adjustment } | { ok: false; error: string }

const isText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''

/** Checks an adjustment's shape against OPS. Whether its topics, notes and tasks exist is checked when it applies. */
export function parseAdjustment(json: unknown): Parsed {
  const o = json as any
  const refuse = (error: string): Parsed => ({ ok: false, error })
  if (!o || typeof o !== 'object' || typeof o.op !== 'string' || !Object.hasOwn(OPS, o.op)) return refuse(`op must be one of ${Object.keys(OPS).join(', ')}`)
  const op = o.op as Adjustment['op']
  const spec = OPS[op] as AnySpec
  const fields = Object.entries(spec.fields)
  const missing = fields.filter(([key, f]) => f.kind === 'text' && !isText(o[key])).map(([key]) => key)
  if (missing.length) return refuse(`${op} needs non-empty strings: ${missing.join(', ')}`)
  const out: Record<string, unknown> = { op }
  for (const [key, { kind }] of fields) {
    const v = o[key]
    if (v === undefined && (kind === 'optionalText' || kind === 'due')) continue
    if (kind === 'optionalText' && !isText(v)) return refuse(`${op} ${key} must be a non-empty string`)
    if (kind === 'due' && v !== null && (!isText(v) || v.trim().length > MAX_DUE_LENGTH))
      return refuse(`${op} ${key} must be null or a non-empty string of at most ${MAX_DUE_LENGTH} characters`)
    if (kind === 'ids' && (!Array.isArray(v) || v.length === 0 || !v.every((id) => typeof id === 'string')))
      return refuse(`${op} needs ${key}, a non-empty array of note ids`)
    if (kind === 'ref' && (!v || typeof v !== 'object' || !isText(v.slug) || !isText(v.title))) return refuse(`${op} needs ${key}: { slug, title }`)
    out[key] = kind === 'ids' ? [...new Set<string>(v)] : kind === 'ref' ? { slug: v.slug, title: v.title } : v
  }
  if (spec.needsOne?.every((key) => out[key] === undefined)) return refuse(`${op} needs ${spec.needsOne.join(' or ')}`)
  const broken = spec.check?.(out as Adjustment)
  if (broken) return refuse(broken)
  return { ok: true, adjustment: out as Adjustment }
}

const text = { type: 'string', minLength: 1 }
const SCHEMA: Record<FieldKind, object> = {
  text,
  optionalText: text,
  due: { type: ['string', 'null'], maxLength: MAX_DUE_LENGTH },
  ids: { type: 'array', items: { type: 'string' }, minItems: 1 },
  ref: { type: 'object', properties: { slug: text, title: text }, required: ['slug', 'title'], additionalProperties: false },
}

/** The JSON Schema of an op's fields, as parseAdjustment checks them. */
export function inputSchema(op: Adjustment['op']) {
  const fields = Object.entries((OPS[op] as AnySpec).fields)
  return {
    type: 'object',
    properties: Object.fromEntries(fields.map(([key, f]) => [key, { ...SCHEMA[f.kind], description: f.describe }])),
    required: fields.filter(([, f]) => f.kind === 'text' || f.kind === 'ids' || f.kind === 'ref').map(([key]) => key),
    additionalProperties: false,
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
  own: Pick<View, 'pins' | 'bodyStale' | 'mergedTitles'>
}

export type NoteChange = { edit: EntryId; text: string } | { tombstone: EntryId }

/** A view's new related list; a change to it alone is not a change to the page, so it is not a write. */
export interface RelatedChange {
  id: string
  related: string[]
}

export type Outcome =
  | { ok: true; note?: NoteChange; writes: AdjustWrite[]; deletes: string[]; warnings: string[]; related?: RelatedChange[] }
  | { ok: false; error: string }

const fail = (error: string): Outcome => ({ ok: false, error })
const unchanged: Outcome = { ok: true, writes: [], deletes: [], warnings: [] }

/** The view as a kind would write it, without the fields the server owns. */
export function writeOf(v: View): ViewWrite {
  const { id, kind, updatedAt, createdAt, createdByPerson, pastTitles, appendsSinceWrite, pins, bodyStale, mergedTitles, related, ...write } = v
  return write
}

/** Pins with empty parts left out; undefined when nothing is pinned. */
function tidy(p: Pins): Pins | undefined {
  const out: Pins = {
    ...(p.title && { title: true as const }),
    ...(p.excluded?.length && { excluded: p.excluded }),
    ...(p.aliases?.length && { aliases: p.aliases }),
    ...(p.spaces && (Object.keys(p.spaces.titles ?? {}).length > 0 || Object.keys(p.spaces.placed ?? {}).length > 0) && { spaces: p.spaces }),
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
  changed(prior: Pick<View, 'slug' | 'title' | 'pins'> & Partial<View>, next: Partial<ViewWrite> & { pins?: Pins; mergedTitles?: string[] }): AdjustWrite {
    const write: ViewWrite = { slug: prior.slug, title: next.title ?? prior.title, sources: next.sources ?? prior.sources!, format: 'md', body: next.body ?? prior.body! }
    const fits = rewriteChars(write, this.entries) <= MAX_REWRITE_CHARS
    if (!fits) this.warnings.push(`topic ${write.slug} is over the ${MAX_REWRITE_CHARS}-character rewrite cap, so its body was not rewritten and may still say what its notes no longer do`)
    const pins = tidy(next.pins ?? prior.pins ?? {})
    // Titles merged in since the last rewrite stay for the rewrite this one queues; with no rewrite, none is told them.
    const mergedTitles = next.mergedTitles ?? prior.mergedTitles
    return { kind: 'organizer', write, own: { ...(pins && { pins }), ...(fits && { bodyStale: true as const, ...(mergedTitles?.length && { mergedTitles }) }) } }
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
  return { ok: true, writes: [{ kind: 'organizer', write, own: { pins: { ...topic.pins, title: true }, ...(topic.bodyStale && { bodyStale: true, ...(topic.mergedTitles && { mergedTitles: topic.mergedTitles }) }) } }], deletes: [], warnings: [] }
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
  const mergedTitles = union(into.mergedTitles, [from.title, ...(from.mergedTitles ?? [])])
  const write = t.changed(into, { sources, body: appendSection(into.body, `## ${from.title}\n\n${from.body}`), pins, mergedTitles })
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

/** Each topic marked stale, so a rewrite run rewrites its body from its notes; one too big to rewrite gets a warning instead. */
export function planRewrites(topics: readonly View[], s: AdjustState): Extract<Outcome, { ok: true }> {
  const t = new Topics(s)
  return { ok: true, writes: topics.map((v) => t.changed(v, {})).filter((w) => w.own.bodyStale), deletes: [], warnings: t.warnings }
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

const sameList = (a: readonly string[], b: readonly string[] = []) => a.length === b.length && a.every((x, i) => x === b[i])

function link(a: Extract<Adjustment, { op: 'linkTopics' | 'unlinkTopics' }>, s: AdjustState): Outcome {
  const t = new Topics(s)
  const x = t.get(a.a)
  if (!x) return t.missing(a.a)
  const y = t.get(a.b)
  if (!y) return t.missing(a.b)
  if (x.id === y.id) return fail('a topic cannot be linked to itself')
  const next = (v: View, other: string) => (a.op === 'linkTopics' ? union(v.related, [other]).sort() : minus(v.related, [other]))
  const related = [
    { id: x.id, related: next(x, y.slug), prior: x.related },
    { id: y.id, related: next(y, x.slug), prior: y.related },
  ].flatMap(({ prior, ...change }) => (sameList(change.related, prior) ? [] : [change]))
  return { ok: true, writes: [], deletes: [], warnings: [], related }
}

/**
 * The related lists of one kind's views brought in line with its views: a slug merged away is replaced by its
 * target, a slug of no view leaves, a link on one side only is put on the other, and every list is sorted. Only the
 * views whose list changes are returned, so a second pass returns none.
 */
export function relatedFixes(views: readonly View[]): RelatedChange[] {
  const live = new Set(views.map((v) => v.slug))
  const aliasOf = new Map(views.flatMap((v) => (v.pins?.aliases ?? []).map((alias) => [alias, v.slug] as const)))
  const next = new Map(views.map((v) => [v.slug, new Set<string>()]))
  for (const v of views) {
    for (const slug of v.related ?? []) {
      const other = live.has(slug) ? slug : aliasOf.get(slug)
      if (!other || other === v.slug) continue
      next.get(v.slug)!.add(other)
      next.get(other)!.add(v.slug)
    }
  }
  return views.flatMap((v) => {
    const related = [...next.get(v.slug)!].sort()
    return sameList(related, v.related) ? [] : [{ id: v.id, related }]
  })
}

/** The map with these areas and space pins, as the person's write. */
function mapChange(map: View, areas: Area[], spaces: SpacePins): Outcome {
  return { ok: true, writes: [{ kind: 'map', write: mapWrite(areas), own: { pins: tidy({ ...map.pins, spaces }) } }], deletes: [], warnings: [] }
}

function moveTopicToSpace(a: Extract<Adjustment, { op: 'moveTopicToSpace' }>, s: AdjustState): Outcome {
  const map = mapIn(s.views)
  if (!map) return fail('the map has not been drawn yet')
  const topics = new Topics(s)
  const topic = topics.get(a.slug)
  if (!topic) return topics.missing(a.slug)
  const areas = areasOf(map)
  const existing = areas.find((x) => x.slug === sanitizeSlug(a.space))
  const title = usableTitle(a.space)
  if (!existing && !title) return fail(`no space ${a.space}, and it is not usable as a new space's title`)
  const pins = map.pins?.spaces ?? {}
  const space = existing?.slug ?? (sanitizeSlug(title!) || 'space')
  const next = placeIn(areas, { slug: topic.slug, title: topic.title }, space, existing?.title ?? title!)
  const titles = existing ? pins.titles : { ...pins.titles, [space]: title! }
  return mapChange(map, next, { ...(titles && { titles }), placed: { ...pins.placed, [topic.slug]: space } })
}

function renameSpace(a: Extract<Adjustment, { op: 'renameSpace' }>, s: AdjustState): Outcome {
  const map = mapIn(s.views)
  const areas = areasOf(map)
  const space = areas.find((x) => x.slug === sanitizeSlug(a.space))
  if (!map || !space) return fail(`no space ${a.space}`)
  const title = usableTitle(a.title)
  if (!title) return fail('title is not usable')
  const pins = map.pins?.spaces ?? {}
  return mapChange(map, areas.map((x) => (x === space ? { ...x, title } : x)), { ...pins, titles: { ...pins.titles, [space.slug]: title } })
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
    case 'linkTopics':
    case 'unlinkTopics':
      return link(a, s)
    case 'moveTopicToSpace':
      return moveTopicToSpace(a, s)
    case 'renameSpace':
      return renameSpace(a, s)
    case 'purgeNote':
      return fail('purgeNote rewrites files, so the server applies it, not a plan')
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
