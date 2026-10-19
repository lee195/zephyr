<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref } from 'vue'
import type { Run, Task, View } from '../../src/domain'
import { connect, derivedBySource, type FailedGroup, state, strip, taskList, topicsByEntry, viewsByKind } from './live'
import ViewBody from './ViewBody.vue'

const openSource = ref<string | null>(null)
const openHistory = reactive(new Set<string>())
const toggleHistory = (id: string) => (openHistory.has(id) ? openHistory.delete(id) : openHistory.add(id))
const newestFirst = (v: View) => [...(v.pastTitles ?? [])].reverse()
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const entries = computed(() => [...state.entries.values()].slice(-20).reverse())

function toggleSource(viewId: string, entryId: string) {
  const key = `${viewId}:${entryId}`
  openSource.value = openSource.value === key ? null : key
}

/** The other topics citing an entry this topic cites; a note may belong to several, and showing them makes a wrong one easy to spot. */
const otherTopics = (v: View, entryId: string) =>
  v.kind === 'organizer' ? (topicsByEntry.value.get(entryId) ?? []).filter((t) => t.id !== v.id) : []

/** Opens the entry inside that topic's card and brings the card into view. */
async function showIn(topicId: string, entryId: string) {
  openSource.value = `${topicId}:${entryId}`
  await nextTick()
  document.getElementById(topicId)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

const time = (iso?: string) => (iso ? new Date(iso).toLocaleTimeString() : '')

const tasks = computed(() => taskList.value?.tasks ?? [])
const openTasks = computed(() => tasks.value.filter((t) => !t.done))
const doneTasks = computed(() => tasks.value.filter((t) => t.done))

/** An ISO due date reads as a day; words the model could not resolve show as written. */
const due = (d: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(`${d}T00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) : d

const taskSources = (t: Task) => t.sources.map((id) => state.entries.get(id)?.text ?? id).join('\n')

const runSubject = (r: Run) => (r.viewIds ? r.viewIds.map((id) => id.split('/').at(-1)).join(', ') : r.entryIds.length)
const runDetail = (r: Run) => [r.error, ...(r.dropped ?? []).map((d) => `dropped: ${d}`), r.uncovered && `not covered: ${r.uncovered.length} notes`].filter(Boolean).join('\n')
const failedDetail = (g: FailedGroup) =>
  [`${g.count} failed, latest at ${time(g.latest.endedAt)}`, g.recoveredAt && `done since ${time(g.recoveredAt)}`, runDetail(g.latest)].filter(Boolean).join('\n')

onMounted(connect)
</script>

<template>
  <header>
    <h1>Zephyr</h1>
    <span class="dot" :class="{ on: state.connected }" :title="state.connected ? 'live' : 'disconnected'" />
  </header>

  <section class="activity" aria-label="Runs">
    <span v-if="strip.runs.length + strip.failed.length === 0" class="muted">No runs yet</span>
    <span v-for="r in strip.runs" :key="r.id" class="run" :class="[r.status, { dropped: r.dropped?.length }]" :title="runDetail(r)">
      {{ r.kind }} · {{ runSubject(r) }} · {{ r.status }}
    </span>
    <span
      v-for="g in strip.failed"
      :key="g.kind"
      class="run failed"
      :class="{ dropped: g.latest.dropped?.length, recovered: g.recoveredAt }"
      :title="failedDetail(g)"
    >
      {{ g.kind }} · {{ g.count }} failed
    </span>
  </section>

  <main>
    <div class="views">
      <p v-if="viewsByKind.size === 0 && !taskList" class="muted">No views yet. Type a note in your harness.</p>
      <section v-if="taskList" class="kind" aria-label="Tasks">
        <h2>Tasks</h2>
        <article class="card">
          <p v-if="openTasks.length === 0" class="muted">Nothing open</p>
          <ul class="tasks">
            <li v-for="t in openTasks" :key="t.id" :title="taskSources(t)">
              <span>{{ t.text }}</span>
              <span v-if="t.due" class="due">{{ due(t.due) }}</span>
            </li>
          </ul>
          <details v-if="doneTasks.length > 0">
            <summary class="muted">{{ doneTasks.length }} done</summary>
            <ul class="tasks done">
              <li v-for="t in doneTasks" :key="t.id" :title="taskSources(t)">{{ t.text }}</li>
            </ul>
          </details>
        </article>
      </section>
      <section v-for="[kind, views] in viewsByKind" :key="kind" class="kind">
        <h2>{{ kind }}</h2>
        <article v-for="v in views" :id="v.id" :key="v.id" class="card">
          <h3 v-if="!v.pastTitles?.length">{{ v.title }}</h3>
          <template v-else>
            <h3>
              <button
                class="title-toggle"
                :aria-expanded="openHistory.has(v.id)"
                :aria-controls="`${v.id}:titles`"
                @click="toggleHistory(v.id)"
              >
                {{ v.title }}
                <span class="history-mark muted"><span aria-hidden="true">↺</span> {{ v.pastTitles.length }}<span class="sr-only"> earlier titles</span></span>
              </button>
            </h3>
            <ol v-if="openHistory.has(v.id)" :id="`${v.id}:titles`" class="past-titles" aria-label="earlier titles">
              <li v-for="p in newestFirst(v)" :key="p.until">
                <span>{{ p.title }}</span>
                <time class="muted" :datetime="p.until">{{ when(p.until) }}</time>
              </li>
            </ol>
          </template>
          <ViewBody :view="v" />
          <ViewBody v-for="d in derivedBySource.get(v.id) ?? []" :key="d.id" :view="d" class="derived" />
          <footer>
            <span class="muted">{{ v.sources.length }} source{{ v.sources.length === 1 ? '' : 's' }}</span>
            <button
              v-for="(id, i) in v.sources"
              :key="id"
              class="chip"
              :class="{ active: openSource === `${v.id}:${id}`, shared: otherTopics(v, id).length > 0 }"
              :title="otherTopics(v, id).length > 0 ? `also in: ${otherTopics(v, id).map((t) => t.title).join(', ')}` : undefined"
              @click="toggleSource(v.id, id)"
            >
              {{ i + 1 }}<span v-if="otherTopics(v, id).length > 0" class="shared-mark" aria-hidden="true">⧉</span>
            </button>
          </footer>
          <template v-for="id in v.sources" :key="id">
            <blockquote v-if="openSource === `${v.id}:${id}`" class="source">
              {{ state.entries.get(id)?.text ?? 'entry not loaded' }}
              <small class="muted">{{ time(state.entries.get(id)?.at) }}</small>
              <small v-if="otherTopics(v, id).length > 0" class="also">
                <span class="shared-mark" aria-hidden="true">⧉</span> also in:
                <template v-for="(t, j) in otherTopics(v, id)" :key="t.id">
                  <template v-if="j > 0">, </template>
                  <a :href="`#${t.id}`" @click.prevent="showIn(t.id, id)">{{ t.title }}</a>
                </template>
              </small>
            </blockquote>
          </template>
        </article>
      </section>
    </div>

    <aside class="entries">
      <h2>Entries</h2>
      <p v-if="entries.length === 0" class="muted">None yet</p>
      <ol>
        <li v-for="e in entries" :key="e.id">
          <small class="muted">{{ time(e.at) }}</small>
          {{ e.text }}
          <small v-if="topicsByEntry.has(e.id)" class="topics">
            <span v-if="topicsByEntry.get(e.id)!.length > 1" class="shared-mark" aria-hidden="true">⧉</span>
            <template v-for="(t, j) in topicsByEntry.get(e.id)" :key="t.id">
              <template v-if="j > 0"> · </template>
              <a :href="`#${t.id}`" @click.prevent="showIn(t.id, e.id)">{{ t.title }}</a>
            </template>
          </small>
        </li>
      </ol>
    </aside>
  </main>
</template>
