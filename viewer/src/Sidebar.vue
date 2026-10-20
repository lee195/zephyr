<script setup lang="ts">
import { computed, reactive } from 'vue'
import { goToTopic, hrefOf, route, spaces, taskList, unplaced, type Route } from './live'

defineProps<{ open: boolean }>()
const emit = defineEmits<{ navigate: [] }>()

const expanded = reactive(new Set<number>())
const toggle = (n: number) => (expanded.has(n) ? expanded.delete(n) : expanded.add(n))
const isCurrent = (r: Route) => hrefOf(r) === hrefOf(route.value)
const openTasks = computed(() => (taskList.value?.tasks ?? []).filter((t) => !t.done).length)

function topic(id: string) {
  emit('navigate')
  void goToTopic(id)
}
</script>

<template>
  <nav class="sidebar" :class="{ open }" aria-label="Spaces">
    <h2>Spaces</h2>
    <p v-if="spaces.length === 0" class="muted small">No map yet</p>
    <ul class="spaces">
      <li v-for="s in spaces" :key="s.n">
        <div class="space-row">
          <button class="caret" :aria-expanded="expanded.has(s.n)" :aria-label="`${expanded.has(s.n) ? 'Hide' : 'Show'} topics of ${s.title}`" @click="toggle(s.n)">
            {{ expanded.has(s.n) ? '▾' : '▸' }}
          </button>
          <a :href="hrefOf({ page: 'space', n: s.n })" :aria-current="isCurrent({ page: 'space', n: s.n }) ? 'page' : undefined" @click="emit('navigate')">
            {{ s.title }}
          </a>
          <span class="count muted">{{ s.topics.length }}</span>
        </div>
        <ul v-if="expanded.has(s.n)" class="space-topics">
          <li v-for="t in s.topics" :key="t.id">
            <a :href="`#${t.id}`" @click.prevent="topic(t.id)">{{ t.title }}</a>
          </li>
        </ul>
      </li>
    </ul>
    <ul class="pages">
      <li>
        <a href="#/all" :aria-current="isCurrent({ page: 'all' }) ? 'page' : undefined" @click="emit('navigate')">All topics</a>
        <span v-if="unplaced.length > 0" class="count muted" :title="`${unplaced.length} not on the map yet`">+{{ unplaced.length }} new</span>
      </li>
      <li v-if="taskList">
        <a href="#/tasks" :aria-current="isCurrent({ page: 'tasks' }) ? 'page' : undefined" @click="emit('navigate')">Tasks</a>
        <span class="count muted">{{ openTasks }}</span>
      </li>
      <li>
        <a href="#/activity" :aria-current="isCurrent({ page: 'activity' }) ? 'page' : undefined" @click="emit('navigate')">Activity</a>
      </li>
    </ul>
  </nav>
</template>
