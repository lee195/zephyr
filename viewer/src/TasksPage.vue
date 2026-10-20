<script setup lang="ts">
import { computed } from 'vue'
import type { Task } from '../../src/domain'
import { state, taskList } from './live'

const tasks = computed(() => taskList.value?.tasks ?? [])
const openTasks = computed(() => tasks.value.filter((t) => !t.done))
const doneTasks = computed(() => tasks.value.filter((t) => t.done))

/** An ISO due date reads as a day; words the model could not resolve show as written. */
const due = (d: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(`${d}T00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) : d

const taskSources = (t: Task) => t.sources.map((id) => state.entries.get(id)?.text ?? id).join('\n')
</script>

<template>
  <section class="kind" aria-label="Tasks">
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
</template>
