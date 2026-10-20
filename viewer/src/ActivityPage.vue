<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { Run } from '../../src/domain'
import { runDetail, runSubject, state } from './live'

const PAGE = 50

const loaded = ref<Run[]>([])
const more = ref(false)
const loading = ref(false)
const failed = ref(false)
const kind = ref('')
const status = ref('')
const showNoCall = ref(false)

async function loadOlder() {
  loading.value = true
  failed.value = false
  const before = loaded.value.at(-1)?.endedAt
  const query = `limit=${PAGE}${before ? `&before=${encodeURIComponent(before)}` : ''}`
  try {
    const res = await fetch(`/api/runs/history?${query}`)
    if (!res.ok) throw new Error(String(res.status))
    const page: { runs: Run[]; more: boolean } = await res.json()
    loaded.value = [...loaded.value, ...page.runs]
    more.value = page.more
  } catch {
    failed.value = true
  } finally {
    loading.value = false
  }
}

onMounted(loadOlder)

const endOf = (r: Run) => r.endedAt ?? r.startedAt ?? ''

/** Live runs, in flight or finished since the page loaded, over the pages loaded from the server; newest first. */
const runs = computed(() => {
  const byId = new Map(loaded.value.map((r) => [r.id, r]))
  for (const r of state.runs.values()) byId.set(r.id, r)
  const all = [...byId.values()].sort((a, b) => Number(!a.endedAt) - Number(!b.endedAt) || endOf(b).localeCompare(endOf(a)))
  return all.filter((r) => (showNoCall.value || !r.noCall) && (!kind.value || r.kind === kind.value) && (!status.value || r.status === status.value))
})
const kinds = computed(() => [...new Set([...loaded.value, ...state.runs.values()].map((r) => r.kind))].sort())

const when = (r: Run) => (r.endedAt ? new Date(r.endedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' }) : r.status)
</script>

<template>
  <section class="kind" aria-label="Activity">
    <h2>Activity</h2>
    <div class="filters">
      <label>Kind <select v-model="kind"><option value="">all</option><option v-for="k in kinds" :key="k" :value="k">{{ k }}</option></select></label>
      <label>Status <select v-model="status"><option value="">all</option><option value="done">done</option><option value="failed">failed</option><option value="running">running</option><option value="queued">queued</option></select></label>
      <label><input v-model="showNoCall" type="checkbox" /> Runs with no model call</label>
    </div>
    <p v-if="runs.length === 0 && !loading" class="muted">No runs</p>
    <ol class="history">
      <li v-for="r in runs" :key="r.id" :class="r.status">
        <time class="muted">{{ when(r) }}</time>
        <span class="run" :class="[r.status, { dropped: r.dropped?.length }]">{{ r.kind }} · {{ r.status }}</span>
        <span>{{ runSubject(r) }}<template v-if="r.attempt > 1"> · attempt {{ r.attempt }}</template><template v-if="r.noCall"> · no model call</template></span>
        <small v-if="runDetail(r)" class="detail muted">{{ runDetail(r) }}</small>
      </li>
    </ol>
    <p v-if="failed" class="muted">Could not load older runs.</p>
    <button v-if="more || failed" class="more" :disabled="loading" @click="loadOlder">{{ loading ? 'Loading…' : 'Load older' }}</button>
  </section>
</template>
