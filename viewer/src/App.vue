<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { Entry, View } from '../../src/domain'
import ActivityPage from './ActivityPage.vue'
import { allTopics, connect, type FailedGroup, goToTopic, route, runDetail, runSubject, spaces, state, strip, topicsByEntry } from './live'
import Sidebar from './Sidebar.vue'
import SummariesPage from './SummariesPage.vue'
import TasksPage from './TasksPage.vue'
import TopicCard from './TopicCard.vue'

const RECENT_NOTES = 20

const drawerOpen = ref(false)
const time = (iso?: string) => (iso ? new Date(iso).toLocaleTimeString() : '')
const newestFirst = (views: View[]) => [...views].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
const failedDetail = (g: FailedGroup) =>
  [`${g.count} failed, latest at ${time(g.latest.endedAt)}`, g.recoveredAt && `done since ${time(g.recoveredAt)}`, runDetail(g.latest)].filter(Boolean).join('\n')

const space = computed(() => {
  const r = route.value
  return r.page === 'space' ? spaces.value.find((s) => s.slug === r.slug) : undefined
})
const topics = computed(() => (space.value ? newestFirst(space.value.topics) : route.value.page === 'all' ? allTopics.value : []))

/** On a space page, the notes its topics cite; elsewhere the newest notes. */
const notes = computed<Entry[]>(() => {
  const all = [...state.entries.values()].reverse()
  if (!space.value) return all.slice(0, RECENT_NOTES)
  const cited = new Set(space.value.topics.flatMap((t) => t.sources))
  return all.filter((e) => cited.has(e.id))
})

onMounted(connect)
</script>

<template>
  <header>
    <button class="drawer-toggle" :aria-expanded="drawerOpen" aria-controls="sidebar" @click="drawerOpen = !drawerOpen">☰ Spaces</button>
    <h1>Zephyr</h1>
    <span class="dot" :class="{ on: state.connected }" :title="state.connected ? 'live' : 'disconnected'" />
    <section class="activity" aria-label="Recent runs">
      <span v-if="strip.runs.length + strip.failed.length === 0" class="muted">No runs yet</span>
      <span v-for="r in strip.runs" :key="r.id" class="run" :class="[r.status, { dropped: r.dropped?.length }]" :title="runDetail(r)">
        {{ r.kind }} · {{ runSubject(r) }} · {{ r.status }}
      </span>
      <span v-for="g in strip.failed" :key="g.kind" class="run failed" :class="{ dropped: g.latest.dropped?.length, recovered: g.recoveredAt }" :title="failedDetail(g)">
        {{ g.kind }} · {{ g.count }} failed
      </span>
      <a href="#/activity" class="all-activity">All activity →</a>
    </section>
  </header>

  <div class="layout">
    <Sidebar id="sidebar" :open="drawerOpen" @navigate="drawerOpen = false" />

    <main class="page">
      <TasksPage v-if="route.page === 'tasks'" />
      <ActivityPage v-else-if="route.page === 'activity'" />
      <SummariesPage v-else-if="route.page === 'summaries'" />
      <section v-else class="kind" :aria-label="space?.title ?? 'All topics'">
        <h2>{{ space?.title ?? 'All topics' }}</h2>
        <p v-if="topics.length === 0" class="muted">No topics yet. Type a note in your harness.</p>
        <TopicCard v-for="v in topics" :key="v.id" :view="v" />
      </section>
    </main>

    <aside class="entries">
      <h2>{{ space ? 'Notes here' : 'Recent notes' }}</h2>
      <p v-if="notes.length === 0" class="muted">None yet</p>
      <ol>
        <li v-for="e in notes" :key="e.id">
          <small class="muted">{{ time(e.at) }}</small>
          {{ e.text }}
          <small v-if="topicsByEntry.has(e.id)" class="topics">
            <span v-if="topicsByEntry.get(e.id)!.length > 1" class="shared-mark" aria-hidden="true">⧉</span>
            <template v-for="(t, j) in topicsByEntry.get(e.id)" :key="t.id">
              <template v-if="j > 0"> · </template>
              <a :href="`#${t.id}`" @click.prevent="goToTopic(t.id, e.id)">{{ t.title }}</a>
            </template>
          </small>
        </li>
      </ol>
    </aside>
  </div>
</template>
