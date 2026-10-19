import type { AgentKind, EntryId, Validation, ViewUpsert } from './domain'

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

/** Parses `{ upserts: [{ slug, title, sources, body }] }`; drops unknown sources and upserts left with none. */
export function validateUpserts(json: unknown, knownIds: ReadonlySet<EntryId>): Validation {
  const upserts = (json as any)?.upserts
  if (!Array.isArray(upserts)) return { ok: false, error: 'reply has no upserts array' }
  const out = new Map<string, ViewUpsert>()
  for (const [i, u] of upserts.entries()) {
    if (!u || typeof u !== 'object') return { ok: false, error: `upsert ${i} is not an object` }
    if (typeof u.slug !== 'string') return { ok: false, error: `upsert ${i} has no slug` }
    if (typeof u.body !== 'string') return { ok: false, error: `upsert ${i} body is not a string` }
    if (!Array.isArray(u.sources)) return { ok: false, error: `upsert ${i} sources is not an array` }
    const slug = sanitizeSlug(u.slug)
    if (!slug) return { ok: false, error: `upsert ${i} slug is empty after sanitizing` }
    const sources: EntryId[] = [...new Set<EntryId>(u.sources.filter((s: unknown): s is string => typeof s === 'string' && knownIds.has(s)))]
    if (sources.length === 0) continue
    const title = typeof u.title === 'string' && u.title.trim() ? u.title.trim() : slug
    out.set(slug, { slug, title, sources, body: stripTitleHeading(u.body, title) })
  }
  return { ok: true, upserts: [...out.values()] }
}

const ORGANIZER_SYSTEM = `You organize a person's notes into topic pages.
Reply with JSON only: {"upserts":[{"slug":string,"title":string,"sources":string[],"body":string}]}.
- Put each new entry into exactly one topic. Reuse an existing topic's slug when the entry belongs there; create a new topic only for a clearly different subject.
- Return only topics you create or change. For a changed topic, return its full rewritten page.
- sources lists the ids of ALL entries on that topic, including ones already listed on the existing page.
- slug is lowercase kebab-case. body is markdown that summarizes the topic's notes; do not add facts the notes do not contain, and do not repeat the title as a heading.`

const organizer: AgentKind = {
  kind: 'organizer',
  format: 'md',
  buildMessages(newEntries, ownViews, recentEntries) {
    const payload = {
      existingTopics: ownViews.map((v) => ({ slug: v.slug, title: v.title, sources: v.sources, body: v.body })),
      recentEntries: recentEntries.map((e) => ({ id: e.id, at: e.at, text: e.text })),
      newEntries: newEntries.map((e) => ({ id: e.id, at: e.at, text: e.text })),
    }
    return [
      { role: 'system', content: ORGANIZER_SYSTEM },
      { role: 'user', content: JSON.stringify(payload) },
    ]
  },
  validate: validateUpserts,
}

export const kinds: Record<string, AgentKind> = { [organizer.kind]: organizer }
