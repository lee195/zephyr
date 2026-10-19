import type { AgentKind, ChatMessage, Entry, EntryId, Plan, Run, View, ViewWrite, World } from '../domain'
import { rankAll, type RelevanceDoc } from '../relevance'
import { inEntryOrder, jsonPrompt, knownSources, promptEntry, sanitizeSlug } from './common'

const RECENT_CONTEXT = 30
/** Topics the model sees in full per run, picked by relevance to the run's entries; the rest are index lines. */
const OPEN_VIEWS = 3

/**
 * write replaces a topic's body (new slug, or an open one); append adds a section to an existing topic and,
 * with a title, renames it. The slug never changes: it is the view's id, file name and sources key.
 */
export type ViewOp =
  | { op: 'write'; slug: string; title: string; sources: EntryId[]; body: string }
  | { op: 'append'; slug: string; title?: string; sources: EntryId[]; body: string }

export type Validation = { ok: true; ops: ViewOp[]; dropped: string[] } | { ok: false; error: string }

/** What the model was shown: open topics in full, indexed topics as one line each. */
export interface ViewContext {
  open: View[]
  indexed: View[]
}

export interface ReplyContext {
  knownIds: ReadonlySet<EntryId>
  existingSlugs: ReadonlySet<string>
  openSlugs: ReadonlySet<string>
}

const MAX_TITLE_CHARS = 80

const LEADING_HEADING = /^\s*#{1,6}[ \t]+(.*?)[ \t]*#*[ \t]*(?:\r?\n|$)/

/** The viewer renders the title itself, so a leading heading that repeats it would show twice. */
function stripTitleHeading(body: string, title: string): string {
  const m = LEADING_HEADING.exec(body)
  if (!m || m[1]!.trim().toLowerCase() !== title.trim().toLowerCase()) return body
  return body.slice(m[0].length).replace(/^\s+/, '')
}

/**
 * Parses `{ ops: [...] }`. A malformed reply fails as a whole. A well-formed op the rules refuse is
 * dropped with a reason: a write to an existing topic the model did not see in full, an append to an
 * unknown topic, or an op left with no known sources. An append's unusable title is dropped alone; the append applies.
 */
export function validateOps(json: unknown, ctx: ReplyContext): Validation {
  const ops = (json as any)?.ops
  if (!Array.isArray(ops)) return { ok: false, error: 'reply has no ops array' }
  const existing = new Set(ctx.existingSlugs)
  const writable = new Set(ctx.openSlugs)
  const out: ViewOp[] = []
  const dropped: string[] = []
  for (const [i, o] of ops.entries()) {
    if (!o || typeof o !== 'object') return { ok: false, error: `op ${i} is not an object` }
    if (o.op !== 'write' && o.op !== 'append') return { ok: false, error: `op ${i} is neither write nor append` }
    if (typeof o.slug !== 'string') return { ok: false, error: `op ${i} has no slug` }
    if (typeof o.body !== 'string') return { ok: false, error: `op ${i} body is not a string` }
    if (!Array.isArray(o.sources)) return { ok: false, error: `op ${i} sources is not an array` }
    const slug = sanitizeSlug(o.slug)
    if (!slug) return { ok: false, error: `op ${i} slug is empty after sanitizing` }
    const sources = knownSources(o.sources, ctx.knownIds)
    if (sources.length === 0) {
      dropped.push(`${o.op} ${slug}: no known sources`)
      continue
    }
    if (o.op === 'append') {
      if (!existing.has(slug)) {
        dropped.push(`append ${slug}: no such topic`)
        continue
      }
      const title = typeof o.title === 'string' ? o.title.trim() : ''
      const usable = title.length > 0 && title.length <= MAX_TITLE_CHARS
      if (o.title != null && !usable) dropped.push(`append ${slug}: title dropped, not a non-empty string of at most ${MAX_TITLE_CHARS} characters`)
      out.push({ op: 'append', slug, ...(usable && { title }), sources, body: o.body })
      continue
    }
    if (existing.has(slug) && !writable.has(slug)) {
      dropped.push(`write ${slug}: topic exists but was not open`)
      continue
    }
    const title = typeof o.title === 'string' && o.title.trim() ? o.title.trim() : slug
    out.push({ op: 'write', slug, title, sources, body: stripTitleHeading(o.body, title) })
    existing.add(slug)
    writable.add(slug)
  }
  return { ok: true, ops: out, dropped }
}

const ORGANIZER_SYSTEM = `You organize a person's notes into topic pages.
Reply with JSON only: {"ops":[op, ...]} where op is one of
  {"op":"append","slug":string,"title"?:string,"sources":string[],"body":string}
  {"op":"write","slug":string,"title":string,"sources":string[],"body":string}
The input has openTopics (full pages) and topicIndex (every other topic, one line each: "slug | title | N sources").
- Put each new entry into exactly one topic. Use an existing topic, open or indexed, when the entry belongs there; create a topic only for a clearly different subject.
- append adds body as a new section at the end of an existing topic. Use it for indexed topics, and for open topics when the entry adds to the page without changing what it says.
- On append, set title only when the topic's current title no longer describes all of its notes, the new one included; otherwise leave it out. The slug stays the same.
- write replaces the whole page. Use it to create a topic, or to rewrite an open topic when the entry changes or corrects what the page says. Never write an indexed topic.
- sources lists the ids of the new entries the op covers.
- slug is lowercase kebab-case. body is markdown built only from the notes; do not add facts they do not contain, and do not repeat the title as a heading.`

export function organizerMessages(newEntries: Entry[], views: ViewContext, recentEntries: Entry[]): ChatMessage[] {
  return jsonPrompt(ORGANIZER_SYSTEM, {
    topicIndex: views.indexed.map((v) => `${v.slug} | ${v.title} | ${v.sources.length} sources`),
    openTopics: views.open.map((v) => ({ slug: v.slug, title: v.title, body: v.body })),
    recentEntries: recentEntries.map(promptEntry),
    newEntries: newEntries.map(promptEntry),
  })
}

/** The topic pages among all views. */
export const topicsIn = (views: readonly View[]): View[] => views.filter((v) => v.kind === 'organizer')

const topicDocs = (views: readonly View[]): RelevanceDoc[] => topicsIn(views).map((v) => ({ id: v.id, text: `${v.title}\n${v.body}` }))

/** Waits for every topic to be ranked: a topic left out could not open, and the model would then duplicate it. */
async function viewContext(world: World, own: View[], newEntries: Entry[]): Promise<ViewContext> {
  const query = newEntries.map((e) => e.text).join('\n')
  const { scored } = await rankAll(world.relevance, query, topicDocs(own))
  const openIds = new Set(scored.slice(0, OPEN_VIEWS).map((r) => r.id))
  const byId = new Map(own.map((v) => [v.id, v]))
  return {
    open: [...openIds].map((id) => byId.get(id)!),
    indexed: own.filter((v) => !openIds.has(v.id)),
  }
}

function appendSection(body: string, section: string): string {
  const [head, tail] = [body.trimEnd(), section.trim()]
  return head && tail ? `${head}\n\n${tail}` : head || tail
}

/** Folds the ops over the topics in order; validation guarantees an append targets a topic that exists by then. */
function applyOps(world: World, own: View[], ops: ViewOp[]): ViewWrite[] {
  const pages = new Map<string, ViewWrite>(own.map((v) => [v.slug, v]))
  const touched = new Set<string>()
  for (const op of ops) {
    const prior = pages.get(op.slug)
    // Union with prior sources: a page update should never silently orphan an entry it already cited.
    const cited = new Set([...(prior?.sources ?? []), ...op.sources])
    const page = op.op === 'write' ? { title: op.title, body: op.body } : { title: op.title ?? prior!.title, body: appendSection(prior!.body, op.body) }
    pages.set(op.slug, { slug: op.slug, ...page, sources: inEntryOrder(world.entries, cited), format: 'md' })
    touched.add(op.slug)
  }
  return [...touched].map((slug) => pages.get(slug)!)
}

/** A topic that has grown by this many appends in a row since it was last written reads as a log, and is rewritten. */
export const REWRITE_AFTER_APPENDS = 5
/**
 * Body plus note texts, about 8k tokens. A bigger topic is not rewritten: a rewrite from a cut page would lose
 * content that validation, which checks citations only, cannot see.
 */
export const MAX_REWRITE_CHARS = 32_000

/** What a rewrite shows the model: the page, and every note it cites, in full and in entry order. */
export interface RewriteInput {
  topic: View
  notes: Entry[]
}

/** The rewrite input for this topic, or null when it does not qualify: too few appends in a row, or too big to show in full. */
export function rewriteInput(topic: View, entries: readonly Entry[]): RewriteInput | null {
  if ((topic.appendsSinceWrite ?? 0) < REWRITE_AFTER_APPENDS) return null
  const cited = new Set(topic.sources)
  const notes = entries.filter((e) => cited.has(e.id))
  const chars = notes.reduce((n, e) => n + e.text.length, topic.body.length)
  return chars <= MAX_REWRITE_CHARS ? { topic, notes } : null
}

export type RewriteResult = { ok: true; write: ViewWrite; dropped: string[] } | { ok: false; error: string }

/**
 * A rewrite keeps the topic's slug and exactly its sources. It fails when malformed, for another slug, with an
 * empty body, with any of the page's sources left out, or with a body that only extends the current one. Extra
 * ids and an unusable title are dropped with a reason; the current title then stays.
 */
export function validateRewrite(json: unknown, topic: View, knownIds: ReadonlySet<EntryId>): RewriteResult {
  const r = json as any
  if (!r || typeof r !== 'object' || typeof r.slug !== 'string' || typeof r.body !== 'string' || !Array.isArray(r.sources))
    return { ok: false, error: 'reply needs slug and body strings and a sources array' }
  if (sanitizeSlug(r.slug) !== topic.slug) return { ok: false, error: `slug ${r.slug} is not the topic's slug ${topic.slug}` }
  const dropped: string[] = []
  const proposed = typeof r.title === 'string' ? r.title.trim() : ''
  const usable = proposed.length > 0 && proposed.length <= MAX_TITLE_CHARS
  if (!usable) dropped.push(`rewrite ${topic.slug}: title dropped, not a non-empty string of at most ${MAX_TITLE_CHARS} characters`)
  const title = usable ? proposed : topic.title
  const body = stripTitleHeading(r.body, title)
  if (!body.trim()) return { ok: false, error: 'body is empty' }
  const cited = new Set<EntryId>(r.sources.filter((s: unknown) => typeof s === 'string'))
  const missing = topic.sources.filter((id) => !cited.has(id))
  if (missing.length > 0) return { ok: false, error: `sources left out: ${missing.join(', ')}` }
  const head = topic.body.trimEnd()
  if (body.startsWith(head)) return { ok: false, error: 'body only extends the current page' }
  const onPage = new Set(topic.sources)
  const extra = [...cited].filter((id) => !onPage.has(id))
  const unknown = extra.filter((id) => !knownIds.has(id))
  const elsewhere = extra.filter((id) => knownIds.has(id))
  if (unknown.length > 0) dropped.push(`rewrite ${topic.slug}: unknown sources dropped: ${unknown.join(', ')}`)
  if (elsewhere.length > 0) dropped.push(`rewrite ${topic.slug}: sources not on the page dropped: ${elsewhere.join(', ')}`)
  return { ok: true, write: { slug: topic.slug, title, sources: topic.sources, format: 'md', body }, dropped }
}

const REWRITE_SYSTEM = `You rewrite one topic page of a person's notes. The page grew by appending a section per note and now reads like a log.
Reply with JSON only: {"slug":string,"title":string,"sources":string[],"body":string}
The input has the page's slug, title and body, and notes: every note the page cites, oldest first.
- body is the whole page rewritten as one coherent page: group related points, merge repeats, and state a later correction in place of what it corrects. Keep every fact the notes contain; add none they do not contain.
- sources lists the id of every note in notes; none may be left out.
- slug stays exactly as given.
- title describes the whole page; keep the current one when it still does.
- body is markdown; do not repeat the title as a heading.`

export function rewriteMessages({ topic, notes }: RewriteInput): ChatMessage[] {
  return jsonPrompt(REWRITE_SYSTEM, { slug: topic.slug, title: topic.title, body: topic.body, notes: notes.map(promptEntry) })
}

/** Re-checks at run time: a topic written or rewritten since the work was queued no longer qualifies, and makes no call. */
function rewritePlan(viewId: string, world: World): Plan | null {
  const topic = world.views.find((v) => v.id === viewId)
  const input = topic && rewriteInput(topic, world.entries)
  if (!input) return null
  const knownIds = new Set(world.entries.map((e) => e.id))
  return {
    messages: rewriteMessages(input),
    settle(json) {
      const result = validateRewrite(json, input.topic, knownIds)
      if (!result.ok) return result
      return { ok: true, writes: [result.write], dropped: result.dropped, covered: [] }
    },
  }
}

async function organizePlan(run: Run, world: World): Promise<Plan> {
  const runIds = new Set(run.entryIds)
  const newEntries = world.entries.filter((e) => runIds.has(e.id))
  const recent = world.entries.filter((e) => !runIds.has(e.id)).slice(-RECENT_CONTEXT)
  const own = topicsIn(world.views)
  const views = await viewContext(world, own, newEntries)
  const ctx: ReplyContext = {
    knownIds: new Set(world.entries.map((e) => e.id)),
    existingSlugs: new Set(own.map((v) => v.slug)),
    openSlugs: new Set(views.open.map((v) => v.slug)),
  }
  return {
    messages: organizerMessages(newEntries, views, recent),
    settle(json) {
      const result = validateOps(json, ctx)
      if (!result.ok) return result
      // An entry is organized only once an applied op cites it; one the reply skipped, or cited only in a dropped op, is not.
      const cited = new Set(result.ops.flatMap((o) => o.sources))
      return { ok: true, writes: applyOps(world, own, result.ops), dropped: result.dropped, covered: run.entryIds.filter((id) => cited.has(id)) }
    },
  }
}

export const organizer: AgentKind = {
  kind: 'organizer',
  trigger: { on: 'entry' },
  relevanceDocs: topicDocs,
  sweep: (world) => topicsIn(world.views).filter((t) => rewriteInput(t, world.entries)).map((t) => t.id),
  /** Work keyed by one of its topics is a rewrite of that topic; any other work files new entries. */
  async plan(run: Run, world: World) {
    return run.viewIds ? rewritePlan(run.viewIds[0]!, world) : organizePlan(run, world)
  },
}
