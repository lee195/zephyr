import type { AgentKind, EntryId, ReplyContext, Validation, ViewOp } from './domain'

export function sanitizeSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
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
    const sources: EntryId[] = [...new Set<EntryId>(o.sources.filter((s: unknown): s is string => typeof s === 'string' && ctx.knownIds.has(s)))]
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

const organizer: AgentKind = {
  kind: 'organizer',
  format: 'md',
  buildMessages(newEntries, views, recentEntries) {
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
  },
  validate: validateOps,
}

export const kinds: Record<string, AgentKind> = { [organizer.kind]: organizer }
