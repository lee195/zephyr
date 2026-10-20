import type { AgentKind, ChatMessage, Entry, EntryId, Plan, Question, Run, View, ViewWrite, World } from '../domain'
import { rankAll, type RelevanceDoc } from '../relevance'
import { inEntryOrder, jsonPrompt, knownSources, parseQuestions, promptEntry, sanitizeSlug } from './common'

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
  /** Every existing topic by slug: its title, and what the person pinned on it. */
  topics: ReadonlyMap<string, Pick<View, 'title' | 'pins'>>
  openSlugs: ReadonlySet<string>
}

const MAX_TITLE_CHARS = 80
const TITLE_DROPPED = `title dropped, not a non-empty string of at most ${MAX_TITLE_CHARS} characters`

/** A title the model proposed, trimmed, or undefined when it is not a non-empty string of at most MAX_TITLE_CHARS. */
export function usableTitle(raw: unknown): string | undefined {
  const title = typeof raw === 'string' ? raw.trim() : ''
  return title.length > 0 && title.length <= MAX_TITLE_CHARS ? title : undefined
}

const LEADING_HEADING = /^\s*#{1,6}[ \t]+(.*?)[ \t]*#*[ \t]*(?:\r?\n|$)/

/** The viewer renders the title itself, so a leading heading that repeats it would show twice. */
function stripTitleHeading(body: string, title: string): string {
  const m = LEADING_HEADING.exec(body)
  if (!m || m[1]!.trim().toLowerCase() !== title.trim().toLowerCase()) return body
  return body.slice(m[0].length).replace(/^\s+/, '')
}

/** Each alias slug and the topic it was merged into. */
const aliasTargets = (topics: ReplyContext['topics']) =>
  new Map([...topics].flatMap(([slug, t]) => (t.pins?.aliases ?? []).map((alias) => [alias, slug] as const)))

/**
 * Parses `{ ops: [...] }`. A malformed reply fails as a whole. A well-formed op the rules refuse is
 * dropped with a reason: a write to an existing topic the model did not see in full, an append to an
 * unknown topic, or an op left with no known sources. An append's unusable title is dropped alone; the append applies.
 * Pins hold against every op, each with a reason: an op on a merged-away slug lands on its target as an append
 * without a title, a note excluded from a topic is not cited there again, and a pinned title does not change.
 */
export function validateOps(json: unknown, ctx: ReplyContext): Validation {
  const ops = (json as any)?.ops
  if (!Array.isArray(ops)) return { ok: false, error: 'reply has no ops array' }
  const titles = new Map([...ctx.topics].map(([slug, t]) => [slug, t.title]))
  const writable = new Set(ctx.openSlugs)
  const aliases = aliasTargets(ctx.topics)
  const out: ViewOp[] = []
  const dropped: string[] = []
  for (const [i, o] of ops.entries()) {
    if (!o || typeof o !== 'object') return { ok: false, error: `op ${i} is not an object` }
    if (o.op !== 'write' && o.op !== 'append') return { ok: false, error: `op ${i} is neither write nor append` }
    if (typeof o.slug !== 'string') return { ok: false, error: `op ${i} has no slug` }
    if (typeof o.body !== 'string') return { ok: false, error: `op ${i} body is not a string` }
    if (!Array.isArray(o.sources)) return { ok: false, error: `op ${i} sources is not an array` }
    const asked = sanitizeSlug(o.slug)
    if (!asked) return { ok: false, error: `op ${i} slug is empty after sanitizing` }
    const target = aliases.get(asked)
    if (target) dropped.push(`${o.op} ${asked}: merged into ${target}, so applied there as an append${o.title != null ? ' without its title' : ''}`)
    const slug = target ?? asked
    const op: 'write' | 'append' = target ? 'append' : o.op
    const pins = ctx.topics.get(slug)?.pins
    const known = knownSources(o.sources, ctx.knownIds)
    const excluded = known.filter((id) => pins?.excluded?.includes(id))
    const sources = known.filter((id) => !excluded.includes(id))
    if (excluded.length > 0) dropped.push(`${op} ${slug}: excluded from this topic: ${excluded.join(', ')}`)
    if (sources.length === 0) {
      if (excluded.length === 0) dropped.push(`${op} ${slug}: no known sources`)
      continue
    }
    if (op === 'append') {
      if (!titles.has(slug)) {
        dropped.push(`append ${slug}: no such topic`)
        continue
      }
      let title = target ? undefined : usableTitle(o.title)
      if (!target && o.title != null && !title) dropped.push(`append ${slug}: ${TITLE_DROPPED}`)
      if (title && pins?.title && title !== titles.get(slug)) {
        dropped.push(`append ${slug}: title is pinned, ${JSON.stringify(title)} dropped`)
        title = undefined
      }
      out.push({ op: 'append', slug, ...(title && { title }), sources, body: o.body })
      continue
    }
    if (titles.has(slug) && !writable.has(slug)) {
      dropped.push(`write ${slug}: topic exists but was not open`)
      continue
    }
    let title = typeof o.title === 'string' && o.title.trim() ? o.title.trim() : slug
    if (pins?.title && title !== titles.get(slug)) {
      dropped.push(`write ${slug}: title is pinned, ${JSON.stringify(title)} dropped`)
      title = titles.get(slug)!
    }
    out.push({ op: 'write', slug, title, sources, body: stripTitleHeading(o.body, title) })
    titles.set(slug, title)
    writable.add(slug)
  }
  return { ok: true, ops: out, dropped }
}

const ORGANIZER_SYSTEM = `You organize a person's notes into topic pages.
Reply with JSON only: {"ops":[op, ...],"questions"?:[question, ...]} where op is one of
  {"op":"append","slug":string,"title"?:string,"sources":string[],"body":string}
  {"op":"write","slug":string,"title":string,"sources":string[],"body":string}
and question is {"kind":"whichTopic","noteId":string,"chosen":slug,"alternatives":slug[]}
The input has openTopics (full pages) and topicIndex (every other topic, one line each: "slug | title | N sources").
- Put each new entry into exactly one topic. Use an existing topic, open or indexed, when the entry belongs there; create a topic only for a clearly different subject.
- append adds body as a new section at the end of an existing topic. Use it for indexed topics, and for open topics when the entry adds to the page without changing what it says.
- On append, set title only when the topic's current title no longer describes all of its notes, the new one included; otherwise leave it out. The slug stays the same.
- write replaces the whole page. Use it to create a topic, or to rewrite an open topic when the entry changes or corrects what the page says. Never write an indexed topic.
- sources lists the ids of the new entries the op covers.
- slug is lowercase kebab-case. body is markdown built only from the notes; do not add facts they do not contain, and do not repeat the title as a heading.
- When an entry fits two or more existing topics about equally, file it on one and add a question: chosen is that topic, alternatives the others it fits. At most 2 questions; usually none.`

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

export function appendSection(body: string, section: string): string {
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

/** What a rewrite of this topic would show the model, in characters: its body and every note it cites. */
export function rewriteChars(topic: Pick<View, 'body' | 'sources'>, entries: readonly Entry[]): number {
  const cited = new Set(topic.sources)
  return entries.reduce((n, e) => (cited.has(e.id) ? n + e.text.length : n), topic.body.length)
}

/** Stale, or grown by enough appends in a row to read as a log. */
const rewriteDue = (topic: View) => topic.bodyStale || (topic.appendsSinceWrite ?? 0) >= REWRITE_AFTER_APPENDS

/** Topics due for a rewrite that the cap keeps from ever getting one. */
export const overCapTopics = (views: readonly View[], entries: readonly Entry[]) =>
  topicsIn(views).filter((t) => rewriteDue(t) && rewriteChars(t, entries) > MAX_REWRITE_CHARS)

/**
 * The rewrite input for this topic, or null when it does not qualify: neither stale nor grown by enough appends in
 * a row, or too big to show in full.
 */
export function rewriteInput(topic: View, entries: readonly Entry[]): RewriteInput | null {
  if (!rewriteDue(topic) || rewriteChars(topic, entries) > MAX_REWRITE_CHARS) return null
  const cited = new Set(topic.sources)
  return { topic, notes: entries.filter((e) => cited.has(e.id)) }
}

export type RewriteResult = { ok: true; write: ViewWrite; dropped: string[] } | { ok: false; error: string }

/**
 * A rewrite keeps the topic's slug and exactly its sources. It fails when malformed, for another slug, with an
 * empty body, with any of the page's sources left out, or with a body that only extends the current one. A stale
 * page may come back unchanged: the model was told the notes are the truth, and found the page already agrees with
 * them. Extra ids, an unusable title and a change to a pinned title are dropped with a reason; the current title
 * then stays.
 */
export function validateRewrite(json: unknown, topic: View, knownIds: ReadonlySet<EntryId>): RewriteResult {
  const r = json as any
  if (!r || typeof r !== 'object' || typeof r.slug !== 'string' || typeof r.body !== 'string' || !Array.isArray(r.sources))
    return { ok: false, error: 'reply needs slug and body strings and a sources array' }
  if (sanitizeSlug(r.slug) !== topic.slug) return { ok: false, error: `slug ${r.slug} is not the topic's slug ${topic.slug}` }
  const dropped: string[] = []
  const proposed = usableTitle(r.title)
  if (!proposed) dropped.push(`rewrite ${topic.slug}: ${TITLE_DROPPED}`)
  else if (topic.pins?.title && proposed !== topic.title) dropped.push(`rewrite ${topic.slug}: title is pinned, ${JSON.stringify(proposed)} dropped`)
  const title = topic.pins?.title ? topic.title : (proposed ?? topic.title)
  const body = stripTitleHeading(r.body, title)
  if (!body.trim()) return { ok: false, error: 'body is empty' }
  const cited = new Set<EntryId>(r.sources.filter((s: unknown) => typeof s === 'string'))
  const missing = topic.sources.filter((id) => !cited.has(id))
  if (missing.length > 0) return { ok: false, error: `sources left out: ${missing.join(', ')}` }
  const head = topic.body.trimEnd()
  const unchanged = topic.bodyStale && body.trimEnd() === head
  if (body.startsWith(head) && !unchanged) return { ok: false, error: 'body only extends the current page' }
  const onPage = new Set(topic.sources)
  const extra = [...cited].filter((id) => !onPage.has(id))
  const unknown = extra.filter((id) => !knownIds.has(id))
  const elsewhere = extra.filter((id) => knownIds.has(id))
  if (unknown.length > 0) dropped.push(`rewrite ${topic.slug}: unknown sources dropped: ${unknown.join(', ')}`)
  if (elsewhere.length > 0) dropped.push(`rewrite ${topic.slug}: sources not on the page dropped: ${elsewhere.join(', ')}`)
  return { ok: true, write: { slug: topic.slug, title, sources: topic.sources, format: 'md', body }, dropped }
}

const REWRITE_REASON = {
  log: 'The page grew by appending a section per note and now reads like a log.',
  stale: "The person changed the page's notes, or asked for the page to be rewritten from them: some may have been moved to another page, edited, removed, or merged in from another page. The body may still say what the notes no longer support.",
}

const rewriteSystem = (reason: string) => `You rewrite one topic page of a person's notes. ${reason}
Reply with JSON only: {"slug":string,"title":string,"sources":string[],"body":string}
The input has the page's slug, title and body, and notes: every note the page cites, oldest first. The notes are the truth; where the body disagrees with them or says what none of them says, follow the notes.
- body is the whole page rewritten as one coherent page: group related points, merge repeats, and state a later correction in place of what it corrects. Keep every fact the notes contain; add none they do not contain.
- sources lists the id of every note in notes; none may be left out.
- slug stays exactly as given.
- title describes the whole page; keep the current one when it still does.
- body is markdown; do not repeat the title as a heading.`

export function rewriteMessages({ topic, notes }: RewriteInput): ChatMessage[] {
  return jsonPrompt(rewriteSystem(topic.bodyStale ? REWRITE_REASON.stale : REWRITE_REASON.log), { slug: topic.slug, title: topic.title, body: topic.body, notes: notes.map(promptEntry) })
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

/**
 * Checks a whichTopic question against the topics as the reply leaves them: its note is one of the run's, filed on
 * `chosen`, and every alternative is a topic. Slugs are sanitized and a merged-away slug reads as its target.
 */
function whichTopic(runIds: ReadonlySet<EntryId>, sources: ReadonlyMap<string, readonly EntryId[]>, aliases: ReadonlyMap<string, string>) {
  const slug = (raw: unknown) => {
    const s = typeof raw === 'string' ? sanitizeSlug(raw) : ''
    return aliases.get(s) ?? s
  }
  return (q: Record<string, any>): Question | string => {
    if (q.kind !== 'whichTopic') return 'kind is not whichTopic'
    if (typeof q.noteId !== 'string' || !runIds.has(q.noteId)) return `note ${String(q.noteId)} is not a new entry of this run`
    const chosen = slug(q.chosen)
    if (!sources.get(chosen)?.includes(q.noteId)) return `note ${q.noteId} is not on topic ${String(q.chosen)}`
    if (!Array.isArray(q.alternatives)) return 'alternatives is not an array'
    const unknown = q.alternatives.filter((raw) => !sources.has(slug(raw)))
    if (unknown.length > 0) return `no such topic: ${unknown.map(String).join(', ')}`
    const alternatives = [...new Set(q.alternatives.map(slug))].filter((s) => s !== chosen)
    if (alternatives.length === 0) return 'no alternative besides chosen'
    return { kind: 'whichTopic', noteId: q.noteId, chosen, alternatives }
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
    topics: new Map(own.map((v) => [v.slug, v])),
    openSlugs: new Set(views.open.map((v) => v.slug)),
  }
  return {
    messages: organizerMessages(newEntries, views, recent),
    settle(json) {
      const result = validateOps(json, ctx)
      if (!result.ok) return result
      // An entry is organized only once an applied op cites it; one the reply skipped, or cited only in a dropped op, is not.
      const cited = new Set(result.ops.flatMap((o) => o.sources))
      const writes = applyOps(world, own, result.ops)
      const sources = new Map([...own, ...writes].map((v) => [v.slug, v.sources]))
      const asked = parseQuestions((json as any).questions, whichTopic(runIds, sources, aliasTargets(ctx.topics)))
      const dropped = [...result.dropped, ...asked.dropped]
      return { ok: true, writes, dropped, covered: run.entryIds.filter((id) => cited.has(id)), questions: asked.questions }
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
