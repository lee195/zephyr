import { computed, nextTick, reactive, ref } from 'vue'
import type { Entry, Run, View, ZephyrEvent } from '../../src/domain'
import { areasOf } from '../../src/kinds/areas'

export const state = reactive({
  views: new Map<string, View>(),
  entries: new Map<string, Entry>(),
  runs: new Map<string, Run>(),
  connected: false,
})

/** Views derived from another view, such as a topic's diagram, keyed by that view's id; they show inside its card. */
export const derivedBySource = computed(() => {
  const bySource = new Map<string, View[]>()
  for (const v of state.views.values()) {
    if (!v.derivedFrom || !state.views.has(v.derivedFrom.id)) continue
    bySource.set(v.derivedFrom.id, [...(bySource.get(v.derivedFrom.id) ?? []), v])
  }
  return bySource
})

/** The topic cards that cite each entry, by entry id, in title order. */
export const topicsByEntry = computed(() => {
  const byEntry = new Map<string, View[]>()
  const topics = [...state.views.values()].filter((v) => v.kind === 'organizer').sort((a, b) => a.title.localeCompare(b.title))
  for (const t of topics) for (const id of t.sources) byEntry.set(id, [...(byEntry.get(id) ?? []), t])
  return byEntry
})

export const taskList = computed(() => [...state.views.values()].find((v) => v.tasks))

export const topicMap = computed(() => [...state.views.values()].find((v) => v.areas))

/** A space is one area of the map, as a page of its own, named by the area's slug. */
export interface Space {
  slug: string
  title: string
  topics: View[]
}

export const spaces = computed<Space[]>(() =>
  areasOf(topicMap.value).map((a) => ({ slug: a.slug, title: a.title, topics: a.topics.flatMap((t) => state.views.get(`organizer/${t.slug}`) ?? []) })),
)

export const allTopics = computed(() => [...state.views.values()].filter((v) => v.kind === 'organizer').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)))

/** Topics the map does not list yet, such as one written since its last run; they show under All topics. */
export const unplaced = computed(() => {
  const placed = new Set(spaces.value.flatMap((s) => s.topics.map((t) => t.id)))
  return allTopics.value.filter((t) => !placed.has(t.id))
})

export type Route = { page: 'space'; slug: string } | { page: 'tasks' } | { page: 'activity' } | { page: 'summaries' } | { page: 'all' }

export function parseRoute(hash: string): Route | null {
  const space = /^#\/space\/([a-z0-9-]+)$/.exec(hash)
  if (space) return { page: 'space', slug: space[1]! }
  if (hash === '#/tasks') return { page: 'tasks' }
  if (hash === '#/activity') return { page: 'activity' }
  if (hash === '#/summaries') return { page: 'summaries' }
  if (hash === '#/all') return { page: 'all' }
  return null
}

export const hrefOf = (r: Route) => (r.page === 'space' ? `#/space/${r.slug}` : `#/${r.page}`)

// Set by connect(), so importing this module touches no browser global; the strip's tests import it under Bun.
const hashRoute = ref<Route | null>(null)

/** The page shown: the one the hash names while it exists, else the first space, else all topics. */
export const route = computed<Route>(() => {
  const r = hashRoute.value
  if (r && (r.page !== 'space' || spaces.value.some((s) => s.slug === r.slug))) return r
  return spaces.value.length > 0 ? { page: 'space', slug: spaces.value[0]!.slug } : { page: 'all' }
})

/** The space a topic is in, by its view id; undefined while the map does not list it. */
export const spaceOf = (topicId: string) => spaces.value.find((s) => s.topics.some((t) => t.id === topicId))

/** The note opened inside a topic card, as `${topicId}:${entryId}`; one at a time across the page. */
export const openSource = ref<string | null>(null)

/** Opens the page holding the topic, optionally with one of its notes open, and scrolls its card into view. */
export async function goToTopic(topicId: string, entryId?: string) {
  if (entryId) openSource.value = `${topicId}:${entryId}`
  const space = spaceOf(topicId)
  const target = space ? hrefOf({ page: 'space', slug: space.slug }) : '#/all'
  if (location.hash !== target) location.hash = target
  await nextTick()
  document.getElementById(topicId)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

/** A kind's failed runs as one chip. `recoveredAt` is set when a run of that kind finished done after its latest failure. */
export interface FailedGroup {
  kind: string
  count: number
  latest: Run
  recoveredAt?: string
}

const DONE_SHOWN = 3

/** The activity strip: in-flight runs, then the newest done runs that called the model, then one group per failing kind, current failures before recovered ones. */
export function stripOf(all: readonly Run[]): { runs: Run[]; failed: FailedGroup[] } {
  const inFlight = all.filter((r) => r.status === 'queued' || r.status === 'running').reverse()
  const done = all.filter((r) => r.status === 'done' && !r.noCall)
  const lastDone = new Map<string, string>()
  for (const r of done) if (r.endedAt && r.endedAt > (lastDone.get(r.kind) ?? '')) lastDone.set(r.kind, r.endedAt)
  const groups = new Map<string, FailedGroup>()
  for (const r of all) {
    if (r.status !== 'failed') continue
    const g = groups.get(r.kind)
    if (!g) groups.set(r.kind, { kind: r.kind, count: 1, latest: r })
    else {
      g.count++
      if ((r.endedAt ?? '') >= (g.latest.endedAt ?? '')) g.latest = r
    }
  }
  for (const g of groups.values()) {
    const at = lastDone.get(g.kind)
    if (at && at > (g.latest.endedAt ?? '')) g.recoveredAt = at
  }
  const failed = [...groups.values()].sort(
    (a, b) => Number(!!a.recoveredAt) - Number(!!b.recoveredAt) || (b.latest.endedAt ?? '').localeCompare(a.latest.endedAt ?? ''),
  )
  return { runs: [...inFlight, ...done.slice(-DONE_SHOWN).reverse()], failed }
}

export const strip = computed(() => stripOf([...state.runs.values()]))

/** What a run worked on: its notes, its own view, or the view of another kind it was derived from. */
export function runSubject(r: Run): string {
  const id = r.viewIds?.[0]
  if (!id) return `${r.entryIds.length} ${r.entryIds.length === 1 ? 'note' : 'notes'}`
  const slug = id.split('/').at(-1)
  return id.startsWith(`${r.kind}/`) ? `${slug}` : `from ${slug}`
}
export const runDetail = (r: Run) =>
  [r.error, ...(r.dropped ?? []).map((d) => `dropped: ${d}`), r.uncovered && `not covered: ${r.uncovered.length} notes`].filter(Boolean).join('\n')

/** Each live collection: the path that loads it and the server event that updates it, both keyed by id. */
const feeds: { path: string; event: ZephyrEvent['type']; map: Map<string, { id: string }> }[] = [
  { path: '/api/views', event: 'view', map: state.views },
  { path: '/api/entries', event: 'entry', map: state.entries },
  { path: '/api/runs', event: 'run', map: state.runs },
]

async function load(path: string): Promise<{ id: string }[]> {
  const res = await fetch(path)
  return res.ok ? res.json() : []
}

/** A JSON read the page shows once, such as a view's archived versions; null when the server has none or is unreachable. */
export async function fetchJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(path)
    return res.ok ? ((await res.json()) as T) : null
  } catch {
    return null
  }
}

export async function connect() {
  hashRoute.value = parseRoute(location.hash)
  window.addEventListener('hashchange', () => (hashRoute.value = parseRoute(location.hash)))
  const loaded = await Promise.all(feeds.map((f) => load(f.path)))
  feeds.forEach((f, i) => {
    for (const item of loaded[i]!) f.map.set(item.id, item)
  })

  const es = new EventSource('/events')
  es.onopen = () => (state.connected = true)
  es.onerror = () => (state.connected = false)
  for (const f of feeds) {
    es.addEventListener(f.event, (m) => {
      const item: { id: string } = JSON.parse(m.data)
      f.map.set(item.id, item)
    })
  }
  es.addEventListener('removed', (m) => {
    const { of, id }: Extract<ZephyrEvent, { type: 'removed' }>['data'] = JSON.parse(m.data)
    ;(of === 'view' ? state.views : state.entries).delete(id)
  })
}
