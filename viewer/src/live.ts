import { computed, reactive } from 'vue'
import type { Entry, Run, View, ZephyrEvent } from '../../src/domain'

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

/** Every view that is its own card: not the task list, and not a view shown inside its source's card. */
export const viewsByKind = computed(() => {
  const groups = new Map<string, View[]>()
  for (const v of state.views.values()) {
    if (v.tasks || (v.derivedFrom && state.views.has(v.derivedFrom.id))) continue
    const list = groups.get(v.kind) ?? []
    list.push(v)
    groups.set(v.kind, list)
  }
  for (const list of groups.values()) list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  return groups
})

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

export async function connect() {
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
}
