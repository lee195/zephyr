<script setup lang="ts">
import { computed, reactive } from 'vue'
import { goToTopic, hrefOf, route, spaces, taskList, unplaced, type Route } from './live'

defineProps<{ open: boolean }>()
const emit = defineEmits<{ navigate: [] }>()

const expanded = reactive(new Set<string>())
const toggle = (slug: string) => (expanded.has(slug) ? expanded.delete(slug) : expanded.add(slug))
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
      <li v-for="s in spaces" :key="s.slug">
        <div class="space-row">
          <button class="caret" :aria-expanded="expanded.has(s.slug)" :aria-label="`${expanded.has(s.slug) ? 'Hide' : 'Show'} topics of ${s.title}`" @click="toggle(s.slug)">
            {{ expanded.has(s.slug) ? '▾' : '▸' }}
          </button>
          <a :href="hrefOf({ page: 'space', slug: s.slug })" :aria-current="isCurrent({ page: 'space', slug: s.slug }) ? 'page' : undefined" @click="emit('navigate')">
            {{ s.title }}
          </a>
          <span class="count muted">{{ s.topics.length }}</span>
        </div>
        <ul v-if="expanded.has(s.slug)" class="space-topics">
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
      <li>
        <a href="#/summaries" :aria-current="isCurrent({ page: 'summaries' }) ? 'page' : undefined" @click="emit('navigate')">Summaries</a>
      </li>
    </ul>
  </nav>
</template>
