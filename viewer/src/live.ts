import { computed, reactive } from 'vue'
import type { Entry, Run, View } from '../../src/domain'

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

async function load<T>(path: string): Promise<T[]> {
  const res = await fetch(path)
  return res.ok ? res.json() : []
}

export async function connect() {
  const [views, entries, runs] = await Promise.all([
    load<View>('/api/views'),
    load<Entry>('/api/entries'),
    load<Run>('/api/runs'),
  ])
  for (const v of views) state.views.set(v.id, v)
  for (const e of entries) state.entries.set(e.id, e)
  for (const r of runs) state.runs.set(r.id, r)

  const es = new EventSource('/events')
  es.onopen = () => (state.connected = true)
  es.onerror = () => (state.connected = false)
  es.addEventListener('view', (m) => {
    const v: View = JSON.parse(m.data)
    state.views.set(v.id, v)
  })
  es.addEventListener('entry', (m) => {
    const e: Entry = JSON.parse(m.data)
    state.entries.set(e.id, e)
  })
  es.addEventListener('run', (m) => {
    const r: Run = JSON.parse(m.data)
    state.runs.set(r.id, r)
  })
}
