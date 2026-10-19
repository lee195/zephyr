import type { AgentKind, ChatMessage, Entry, EntryId, Run, View, ViewWrite, World } from '../domain'
import { inEntryOrder, knownSources, sanitizeSlug } from './common'

const RECENT_CONTEXT = 30
/** Topics the model sees in full per run, picked by relevance to the run's entries; the rest are index lines. */
const OPEN_VIEWS = 3

/** write replaces a topic's body (new slug, or an open one); append adds a section to an existing topic. */
export type ViewOp =
  | { op: 'write'; slug: string; title: string; sources: EntryId[]; body: string }
  | { op: 'append'; slug: string; sources: EntryId[]; body: string }

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
 * unknown topic, or an op left with no known sources.
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
      if (!existing.has(slug)) dropped.push(`append ${slug}: no such topic`)
      else out.push({ op: 'append', slug, sources, body: o.body })
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
  {"op":"append","slug":string,"sources":string[],"body":string}
  {"op":"write","slug":string,"title":string,"sources":string[],"body":string}
The input has openTopics (full pages) and topicIndex (every other topic, one line each: "slug | title | N sources").
- Put each new entry into exactly one topic. Use an existing topic, open or indexed, when the entry belongs there; create a topic only for a clearly different subject.
- append adds body as a new section at the end of an existing topic. Use it for indexed topics, and for open topics when the entry adds to the page without changing what it says.
- write replaces the whole page. Use it to create a topic, or to rewrite an open topic when the entry changes or corrects what the page says. Never write an indexed topic.
- sources lists the ids of the new entries the op covers.
- slug is lowercase kebab-case. body is markdown built only from the notes; do not add facts they do not contain, and do not repeat the title as a heading.`

export function organizerMessages(newEntries: Entry[], views: ViewContext, recentEntries: Entry[]): ChatMessage[] {
  const payload = {
    topicIndex: views.indexed.map((v) => `${v.slug} | ${v.title} | ${v.sources.length} sources`),
    openTopics: views.open.map((v) => ({ slug: v.slug, title: v.title, body: v.body })),
    recentEntries: recentEntries.map((e) => ({ id: e.id, at: e.at, text: e.text })),
    newEntries: newEntries.map((e) => ({ id: e.id, at: e.at, text: e.text })),
  }
  return [
    { role: 'system', content: ORGANIZER_SYSTEM },
    { role: 'user', content: JSON.stringify(payload) },
  ]
}

async function viewContext(world: World, own: View[], newEntries: Entry[]): Promise<ViewContext> {
  const query = newEntries.map((e) => e.text).join('\n')
  const { scored } = await world.relevance.rank(query, own.map((v) => ({ id: v.id, text: `${v.title}\n${v.body}` })))
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
    const page = op.op === 'write' ? { title: op.title, body: op.body } : { title: prior!.title, body: appendSection(prior!.body, op.body) }
    pages.set(op.slug, { slug: op.slug, ...page, sources: inEntryOrder(world.entries, cited), format: 'md' })
    touched.add(op.slug)
  }
  return [...touched].map((slug) => pages.get(slug)!)
}

export const organizer: AgentKind = {
  kind: 'organizer',
  trigger: { on: 'entry' },
  async plan(run: Run, world: World) {
    const runIds = new Set(run.entryIds)
    const newEntries = world.entries.filter((e) => runIds.has(e.id))
    const recent = world.entries.filter((e) => !runIds.has(e.id)).slice(-RECENT_CONTEXT)
    const own = world.views.filter((v) => v.kind === 'organizer')
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
        return { ok: true, writes: applyOps(world, own, result.ops), dropped: result.dropped }
      },
    }
  },
}
