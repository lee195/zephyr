import type { AgentKind, Area, ChatMessage, SpacePins, TopicRef, View, ViewWrite, World } from '../domain'
import { areasOf, freeSlug } from './areas'
import { jsonPrompt } from './common'
import { topicsIn, usableTitle } from './organizer'

export const MAX_AREAS = 9
/** The most topics the prompt lists, most recently updated first; the rest go under Other without asking. */
export const MAX_MAP_TOPICS = 300
const OTHER = 'Other'
const MAP_SLUG = 'contents'
export const MAP_ID = `map/${MAP_SLUG}`

export const mapIn = (views: readonly View[]) => views.find((v) => v.id === MAP_ID)

export { areasOf }

const key = (t: TopicRef) => `${t.slug}\n${t.title}`

/** The map is stale when the topics it lists, by slug and title, are not exactly the current topics. */
export function mapStale(topics: readonly View[], map: View | undefined): boolean {
  const listed = areasOf(map).flatMap((a) => a.topics.map(key)).sort()
  const current = topics.map(key).sort()
  return listed.length !== current.length || listed.some((k, i) => k !== current[i])
}

/** A topic the map does not list under its current title, so a write of it changes the map. */
export function wantsMap(topic: View, own: readonly View[]): boolean {
  return !areasOf(mapIn(own)).some((a) => a.topics.some((t) => t.slug === topic.slug && t.title === topic.title))
}

export type AreasResult = { ok: true; areas: Area[]; dropped: string[] } | { ok: false; error: string }

/**
 * The reply's areas, each topic in exactly one. An area that names a current space keeps its slug; any other gets a
 * new one, stamped `now`. The person's pins win: a pinned title stays, and a pinned topic goes to its space, which is
 * made again if the reply left it out. Unknown and repeated slugs, areas left empty and changes against a pin are
 * dropped with a reason; topics the reply left out go under Other, so the map always lists every topic.
 */
export function parseAreas(json: unknown, topics: readonly View[], current: readonly Area[], pins: SpacePins = {}, now?: string): AreasResult {
  const raw = (json as { areas?: unknown } | null)?.areas
  if (!Array.isArray(raw)) return { ok: false, error: 'reply has no areas array' }
  if (raw.length > MAX_AREAS) return { ok: false, error: `reply has ${raw.length} areas, more than ${MAX_AREAS}` }
  const bySlug = new Map(topics.map((t) => [t.slug, t]))
  const was = new Map(current.map((a) => [a.slug, a]))
  const placed = new Set<string>()
  const taken = new Set<string>()
  const dropped: string[] = []
  let areas: Area[] = []
  for (const a of raw as { space?: unknown; title?: unknown; slugs?: unknown }[]) {
    const proposed = usableTitle(a?.title)
    if (!proposed) return { ok: false, error: 'an area has no usable title' }
    if (!Array.isArray(a.slugs)) return { ok: false, error: `area ${proposed} has no slugs array` }
    const known = typeof a.space === 'string' && was.has(a.space) && !taken.has(a.space) ? a.space : undefined
    const slug = known ?? freeSlug(proposed, new Set([...taken, ...was.keys()]))
    taken.add(slug)
    const pinned = pins.titles?.[slug]
    if (pinned && pinned !== proposed) dropped.push(`space ${slug}: title is pinned, ${JSON.stringify(proposed)} dropped`)
    const title = pinned ?? proposed
    const refs: TopicRef[] = []
    for (const s of a.slugs) {
      const topic = typeof s === 'string' ? bySlug.get(s) : undefined
      const home = topic && pins.placed?.[topic.slug]
      if (!topic) dropped.push(`area ${title}: unknown topic ${String(s)}`)
      else if (placed.has(topic.slug)) dropped.push(`area ${title}: topic ${topic.slug} is already in another area`)
      else if (home && home !== slug) dropped.push(`area ${title}: topic ${topic.slug} is pinned to space ${home}`)
      else {
        placed.add(topic.slug)
        refs.push({ slug: topic.slug, title: topic.title })
      }
    }
    const createdAt = known ? was.get(known)!.createdAt : now
    if (refs.length > 0) areas.push({ slug, title, topics: refs, ...(createdAt && { createdAt }) })
    else dropped.push(`area ${title}: no known topics, left out`)
  }
  for (const [topicSlug, home] of Object.entries(pins.placed ?? {})) {
    const topic = bySlug.get(topicSlug)
    if (!topic || placed.has(topicSlug)) continue
    placed.add(topicSlug)
    areas = placeIn(areas, { slug: topic.slug, title: topic.title }, home, pins.titles?.[home] ?? was.get(home)?.title ?? home)
  }
  const rest = topics.filter((t) => !placed.has(t.slug)).map((t) => ({ slug: t.slug, title: t.title }))
  return { ok: true, areas: addToOther(areas, rest), dropped }
}

/** The areas with the topic in space `space` only; the space is made, last and under `title`, when it does not exist. */
export function placeIn(areas: readonly Area[], topic: TopicRef, space: string, title: string): Area[] {
  const without = areas.map((a) => ({ ...a, topics: a.topics.filter((t) => t.slug !== topic.slug) }))
  const target = without.find((a) => a.slug === space)
  const next = target ? without.map((a) => (a === target ? { ...a, topics: [...a.topics, topic] } : a)) : [...without, { slug: space, title, topics: [topic] }]
  return next.filter((a) => a.topics.length > 0)
}

/** Markdown with links a plain-file reader can follow from views/map/ to views/organizer/. */
export function renderMap(areas: readonly Area[]): string {
  return areas.map((a) => [`## ${a.title}`, ...a.topics.map((t) => `- [${t.title}](../organizer/${t.slug}.md)`)].join('\n')).join('\n\n')
}

/** The map view holding these areas. */
export function mapWrite(areas: Area[]): ViewWrite {
  return { slug: MAP_SLUG, title: 'Map', format: 'md', body: renderMap(areas), areas, sources: [] }
}

const MAP_SYSTEM = `You keep the map of a person's note topics: a few areas, each grouping topics that belong together.
Reply with JSON only: {"areas":[{"space":string,"title":string,"slugs":[string]}]}.
The input has currentAreas (the map as it is now, maybe empty, each with its space id) and topics (every topic, one line each: "slug | title | N notes").
- Put every topic in exactly one area, by its slug. Use only slugs from topics.
- At most ${MAX_AREAS} areas, fewer when there are few topics. Title each in a few words for what its topics share.
- Keep currentAreas where they still fit: the same space id, title and topics. Place new topics in an existing area; add an area, with no space id, only when a new topic fits none. Topics no longer listed are gone.`

export function mapMessages(topics: readonly View[], current: readonly Area[]): ChatMessage[] {
  return jsonPrompt(MAP_SYSTEM, {
    currentAreas: current.map((a) => ({ space: a.slug, title: a.title, slugs: a.topics.map((t) => t.slug) })),
    topics: topics.map((t) => `${t.slug} | ${t.title} | ${t.sources.length} notes`),
  })
}

export const map: AgentKind = {
  kind: 'map',
  trigger: { on: 'view', kind: 'organizer', wants: wantsMap },
  // Catches what no topic write announces: a topic merged away or deleted.
  sweep: (world) => (topicsIn(world.views).length > 0 && mapStale(topicsIn(world.views), mapIn(world.views)) ? [MAP_ID] : []),
  prune: (world) => (topicsIn(world.views).length === 0 && mapIn(world.views) ? [MAP_ID] : []),
  async plan(_run, world: World) {
    const topics = topicsIn(world.views)
    const view = mapIn(world.views)
    // Several topic writes queue several runs; the first brings the map up to date and the rest find nothing to do.
    if (topics.length === 0 || !mapStale(topics, view)) return null
    const current = areasOf(view)
    const shown = [...topics].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, MAX_MAP_TOPICS)
    const now = new Date().toISOString()
    return {
      messages: mapMessages(shown, current),
      settle(json) {
        const result = parseAreas(json, shown, current, view?.pins?.spaces, now)
        if (!result.ok) return result
        const listed = new Set(shown.map((t) => t.slug))
        const unshown = topics.filter((t) => !listed.has(t.slug)).map((t) => ({ slug: t.slug, title: t.title }))
        return { ok: true, writes: [mapWrite(addToOther(result.areas, unshown))], dropped: result.dropped, covered: [] }
      },
    }
  },
}

function addToOther(areas: Area[], refs: TopicRef[]): Area[] {
  if (refs.length === 0) return areas
  const other = areas.find((a) => a.title === OTHER)
  if (other) return areas.map((a) => (a === other ? { ...a, topics: [...a.topics, ...refs] } : a))
  return [...areas, { slug: freeSlug(OTHER, new Set(areas.map((a) => a.slug))), title: OTHER, topics: refs }]
}
