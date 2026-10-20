import type { AgentKind, Area, ChatMessage, TopicRef, View, World } from '../domain'
import { jsonPrompt } from './common'
import { topicsIn, usableTitle } from './organizer'

export const MAX_AREAS = 9
/** The most topics the prompt lists, most recently updated first; the rest go under Other without asking. */
export const MAX_MAP_TOPICS = 300
const OTHER = 'Other'
const MAP_SLUG = 'contents'

export const mapIn = (views: readonly View[]) => views.find((v) => v.kind === 'map' && v.slug === MAP_SLUG)

const key = (t: TopicRef) => `${t.slug}\n${t.title}`

/** The map is stale when the topics it lists, by slug and title, are not exactly the current topics. */
export function mapStale(topics: readonly View[], map: View | undefined): boolean {
  const listed = (map?.areas ?? []).flatMap((a) => a.topics.map(key)).sort()
  const current = topics.map(key).sort()
  return listed.length !== current.length || listed.some((k, i) => k !== current[i])
}

/** A topic the map does not list under its current title, so a write of it changes the map. */
export function wantsMap(topic: View, own: readonly View[]): boolean {
  const map = mapIn(own)
  return !map?.areas?.some((a) => a.topics.some((t) => t.slug === topic.slug && t.title === topic.title))
}

export type AreasResult = { ok: true; areas: Area[]; dropped: string[] } | { ok: false; error: string }

/**
 * The reply's areas, each topic in exactly one. Unknown and repeated slugs and areas left empty are dropped with a
 * reason; topics the reply left out go under Other, so the map always lists every topic.
 */
export function parseAreas(json: unknown, topics: readonly View[]): AreasResult {
  const raw = (json as { areas?: unknown } | null)?.areas
  if (!Array.isArray(raw)) return { ok: false, error: 'reply has no areas array' }
  if (raw.length > MAX_AREAS) return { ok: false, error: `reply has ${raw.length} areas, more than ${MAX_AREAS}` }
  const bySlug = new Map(topics.map((t) => [t.slug, t]))
  const placed = new Set<string>()
  const dropped: string[] = []
  const areas: Area[] = []
  for (const a of raw as { title?: unknown; slugs?: unknown }[]) {
    const title = usableTitle(a?.title)
    if (!title) return { ok: false, error: 'an area has no usable title' }
    if (!Array.isArray(a.slugs)) return { ok: false, error: `area ${title} has no slugs array` }
    const refs: TopicRef[] = []
    for (const slug of a.slugs) {
      const topic = typeof slug === 'string' ? bySlug.get(slug) : undefined
      if (!topic) dropped.push(`area ${title}: unknown topic ${String(slug)}`)
      else if (placed.has(topic.slug)) dropped.push(`area ${title}: topic ${topic.slug} is already in another area`)
      else {
        placed.add(topic.slug)
        refs.push({ slug: topic.slug, title: topic.title })
      }
    }
    if (refs.length > 0) areas.push({ title, topics: refs })
    else dropped.push(`area ${title}: no known topics, left out`)
  }
  const rest = topics.filter((t) => !placed.has(t.slug)).map((t) => ({ slug: t.slug, title: t.title }))
  return { ok: true, areas: addToOther(areas, rest), dropped }
}

/** Markdown with links a plain-file reader can follow from views/map/ to views/organizer/. */
export function renderMap(areas: readonly Area[]): string {
  return areas.map((a) => [`## ${a.title}`, ...a.topics.map((t) => `- [${t.title}](../organizer/${t.slug}.md)`)].join('\n')).join('\n\n')
}

const MAP_SYSTEM = `You keep the map of a person's note topics: a few areas, each grouping topics that belong together.
Reply with JSON only: {"areas":[{"title":string,"slugs":[string]}]}.
The input has currentAreas (the map as it is now, maybe empty) and topics (every topic, one line each: "slug | title | N notes").
- Put every topic in exactly one area, by its slug. Use only slugs from topics.
- At most ${MAX_AREAS} areas, fewer when there are few topics. Title each in a few words for what its topics share.
- Keep currentAreas where they still fit: the same titles and the same topics in them. Place new topics in an existing area; add an area only when a new topic fits none. Topics no longer listed are gone.`

export function mapMessages(topics: readonly View[], map: View | undefined): ChatMessage[] {
  return jsonPrompt(MAP_SYSTEM, {
    currentAreas: (map?.areas ?? []).map((a) => ({ title: a.title, slugs: a.topics.map((t) => t.slug) })),
    topics: topics.map((t) => `${t.slug} | ${t.title} | ${t.sources.length} notes`),
  })
}

export const map: AgentKind = {
  kind: 'map',
  trigger: { on: 'view', kind: 'organizer', wants: wantsMap },
  // Catches what no topic write announces: a topic merged away or deleted.
  sweep: (world) => (topicsIn(world.views).length > 0 && mapStale(topicsIn(world.views), mapIn(world.views)) ? [`map/${MAP_SLUG}`] : []),
  prune: (world) => (topicsIn(world.views).length === 0 && mapIn(world.views) ? [`map/${MAP_SLUG}`] : []),
  async plan(_run, world: World) {
    const topics = topicsIn(world.views)
    const current = mapIn(world.views)
    // Several topic writes queue several runs; the first brings the map up to date and the rest find nothing to do.
    if (topics.length === 0 || !mapStale(topics, current)) return null
    const shown = [...topics].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, MAX_MAP_TOPICS)
    return {
      messages: mapMessages(shown, current),
      settle(json) {
        const result = parseAreas(json, shown)
        if (!result.ok) return result
        const listed = new Set(shown.map((t) => t.slug))
        const unshown = topics.filter((t) => !listed.has(t.slug)).map((t) => ({ slug: t.slug, title: t.title }))
        const areas = addToOther(result.areas, unshown)
        return { ok: true, writes: [{ slug: MAP_SLUG, title: 'Map', format: 'md', body: renderMap(areas), areas, sources: [] }], dropped: result.dropped, covered: [] }
      },
    }
  },
}

function addToOther(areas: Area[], refs: TopicRef[]): Area[] {
  if (refs.length === 0) return areas
  const other = areas.find((a) => a.title === OTHER)
  return other ? areas.map((a) => (a === other ? { ...a, topics: [...a.topics, ...refs] } : a)) : [...areas, { title: OTHER, topics: refs }]
}
