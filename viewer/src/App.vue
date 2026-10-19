<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { Run, Task } from '../../src/domain'
import { connect, derivedBySource, state, taskList, viewsByKind } from './live'
import ViewBody from './ViewBody.vue'

const openSource = ref<string | null>(null)
const runs = computed(() => [...state.runs.values()].slice(-12).reverse())
const entries = computed(() => [...state.entries.values()].slice(-20).reverse())

function toggleSource(viewId: string, entryId: string) {
  const key = `${viewId}:${entryId}`
  openSource.value = openSource.value === key ? null : key
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
const runDetail = (r: Run) => [r.error, ...(r.dropped ?? []).map((d) => `dropped: ${d}`)].filter(Boolean).join('\n')

onMounted(connect)
</script>

<template>
  <header>
    <h1>Zephyr</h1>
    <span class="dot" :class="{ on: state.connected }" :title="state.connected ? 'live' : 'disconnected'" />
  </header>

  <section class="activity" aria-label="Runs">
    <span v-if="runs.length === 0" class="muted">No runs yet</span>
    <span v-for="r in runs" :key="r.id" class="run" :class="[r.status, { dropped: r.dropped?.length }]" :title="runDetail(r)">
      {{ r.kind }} · {{ runSubject(r) }} · {{ r.status }}
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
        <article v-for="v in views" :key="v.id" class="card">
          <h3>{{ v.title }}</h3>
          <ViewBody :view="v" />
          <ViewBody v-for="d in derivedBySource.get(v.id) ?? []" :key="d.id" :view="d" class="derived" />
          <footer>
            <span class="muted">{{ v.sources.length }} source{{ v.sources.length === 1 ? '' : 's' }}</span>
            <button
              v-for="(id, i) in v.sources"
              :key="id"
              class="chip"
              :class="{ active: openSource === `${v.id}:${id}` }"
              @click="toggleSource(v.id, id)"
            >
              {{ i + 1 }}
            </button>
          </footer>
          <template v-for="id in v.sources" :key="id">
            <blockquote v-if="openSource === `${v.id}:${id}`" class="source">
              {{ state.entries.get(id)?.text ?? 'entry not loaded' }}
              <small class="muted">{{ time(state.entries.get(id)?.at) }}</small>
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
        </li>
      </ol>
    </aside>
  </main>
</template>
