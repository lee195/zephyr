<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { connect, state, viewsByKind } from './live'
import ViewBody from './ViewBody.vue'

const openSource = ref<string | null>(null)
const runs = computed(() => [...state.runs.values()].slice(-12).reverse())
const entries = computed(() => [...state.entries.values()].slice(-20).reverse())

function toggleSource(viewId: string, entryId: string) {
  const key = `${viewId}:${entryId}`
  openSource.value = openSource.value === key ? null : key
}

const time = (iso?: string) => (iso ? new Date(iso).toLocaleTimeString() : '')

onMounted(connect)
</script>

<template>
  <header>
    <h1>Zephyr</h1>
    <span class="dot" :class="{ on: state.connected }" :title="state.connected ? 'live' : 'disconnected'" />
  </header>

  <section class="activity" aria-label="Runs">
    <span v-if="runs.length === 0" class="muted">No runs yet</span>
    <span v-for="r in runs" :key="r.id" class="run" :class="r.status" :title="r.error ?? ''">
      {{ r.kind }} · {{ r.entryIds.length }} · {{ r.status }}
    </span>
  </section>

  <main>
    <div class="views">
      <p v-if="viewsByKind.size === 0" class="muted">No views yet. Type a note in your harness.</p>
      <section v-for="[kind, views] in viewsByKind" :key="kind" class="kind">
        <h2>{{ kind }}</h2>
        <article v-for="v in views" :key="v.id" class="card">
          <h3>{{ v.title }}</h3>
          <ViewBody :view="v" />
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
