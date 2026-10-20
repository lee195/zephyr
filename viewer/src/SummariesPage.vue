<script setup lang="ts">
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { onMounted, reactive, ref } from 'vue'
import { fetchJson } from './live'

interface Saved {
  since: string | null
  until: string
  noteCount: number
}

const list = ref<Saved[] | null>(null)
/** Bodies of the summaries opened so far, by until, as sanitized HTML; empty for one deleted since the list loaded, as a purge does. */
const bodies = reactive(new Map<string, string>())

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const windowOf = (s: Saved) => (s.since ? `${when(s.since)} to ${when(s.until)}` : `until ${when(s.until)}`)

async function open(e: Event, until: string) {
  if (!(e.target as HTMLDetailsElement).open || bodies.has(until)) return
  const s = await fetchJson<Saved & { summary: string }>(`/api/summaries/${encodeURIComponent(until)}`)
  bodies.set(until, s ? DOMPurify.sanitize(marked.parse(s.summary, { async: false })) : '')
}

// Read on entering the page, never cached across visits, so a summary a purge deleted is not shown.
onMounted(async () => (list.value = (await fetchJson<Saved[]>('/api/summaries')) ?? []))
</script>

<template>
  <section class="kind" aria-label="Summaries">
    <h2>Summaries</h2>
    <p v-if="list === null" class="muted">Loading…</p>
    <p v-else-if="list.length === 0" class="muted">No saved summaries. A review saves one when you ask for it.</p>
    <ol v-else class="summaries">
      <li v-for="s in list" :key="s.until" class="card">
        <details @toggle="open($event, s.until)">
          <summary>
            {{ windowOf(s) }} <span class="muted">· {{ s.noteCount }} {{ s.noteCount === 1 ? 'note' : 'notes' }}</span>
          </summary>
          <p v-if="!bodies.has(s.until)" class="muted small">Loading…</p>
          <p v-else-if="!bodies.get(s.until)" class="muted small">No longer saved</p>
          <div v-else class="md" v-html="bodies.get(s.until)" />
        </details>
      </li>
    </ol>
  </section>
</template>
