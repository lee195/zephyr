<script setup lang="ts">
import { ref, watch } from 'vue'
import type { View, ViewFormat } from '../../src/domain'
import { derivedBySource, fetchJson, goToTopic, openSource, state, topicsByEntry } from './live'
import ViewBody from './ViewBody.vue'

const props = defineProps<{ view: View }>()

const historyOpen = ref(false)
const newestFirst = (v: View) => [...(v.pastTitles ?? [])].reverse()
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const time = (iso?: string) => (iso ? new Date(iso).toLocaleTimeString() : '')

function toggleSource(entryId: string) {
  const key = `${props.view.id}:${entryId}`
  openSource.value = openSource.value === key ? null : key
}

/** The other topics citing an entry this topic cites; a note may belong to several, and showing them makes a wrong one easy to spot. */
const otherTopics = (entryId: string) => (topicsByEntry.value.get(entryId) ?? []).filter((t) => t.id !== props.view.id)

/**
 * The page as it was before each rewrite, newest first, read from `.history` only while the list is open. A page
 * never rewritten has none, since only a rewrite or a deleting adjustment archives a page.
 */
const versionsOpen = ref(false)
const versions = ref<{ at: string; format: ViewFormat }[]>([])
const shown = ref<{ at: string; view: View } | null>(null)
const historyPath = () => `/api/history/${props.view.kind}/${props.view.slug}`

async function loadVersions() {
  versions.value = (await fetchJson<{ at: string; format: ViewFormat }[]>(historyPath())) ?? []
  if (shown.value && !versions.value.some((v) => v.at === shown.value!.at)) shown.value = null
}

function toggleVersions(e: Event) {
  versionsOpen.value = (e.target as HTMLDetailsElement).open
  if (versionsOpen.value) void loadVersions()
  else shown.value = null
}

async function showVersion(at: string) {
  if (shown.value?.at === at) return (shown.value = null)
  const v = await fetchJson<{ at: string; format: ViewFormat; body: string }>(`${historyPath()}/${encodeURIComponent(at)}`)
  shown.value = v ? { at, view: { ...props.view, format: v.format, body: v.body } } : null
  if (!v) void loadVersions()
}

// A rewrite archives the page it replaces, and a purge may delete versions; an open list follows both.
watch(
  () => props.view.updatedAt,
  () => versionsOpen.value && loadVersions(),
)

/** The topics the person linked to this one, as loaded topic cards. */
const related = () => (props.view.related ?? []).flatMap((slug) => state.views.get(`organizer/${slug}`) ?? [])
</script>

<template>
  <article :id="view.id" class="card">
    <h3 v-if="!view.pastTitles?.length">{{ view.title }}</h3>
    <template v-else>
      <h3>
        <button class="title-toggle" :aria-expanded="historyOpen" :aria-controls="`${view.id}:titles`" @click="historyOpen = !historyOpen">
          {{ view.title }}
          <span class="history-mark muted"><span aria-hidden="true">↺</span> {{ view.pastTitles.length }}<span class="sr-only"> earlier titles</span></span>
        </button>
      </h3>
      <ol v-show="historyOpen" :id="`${view.id}:titles`" class="past-titles" aria-label="earlier titles">
        <li v-for="p in newestFirst(view)" :key="p.until">
          <span>{{ p.title }}</span>
          <time class="muted" :datetime="p.until">{{ when(p.until) }}</time>
        </li>
      </ol>
    </template>
    <ViewBody :view="view" />
    <ViewBody v-for="d in derivedBySource.get(view.id) ?? []" :key="d.id" :view="d" class="derived" />
    <details class="versions" @toggle="toggleVersions">
      <summary class="muted">Earlier versions</summary>
      <p v-if="versions.length === 0" class="muted small">None saved</p>
      <ol v-else class="version-list">
        <li v-for="v in versions" :key="v.at">
          <button class="chip" :aria-pressed="shown?.at === v.at" @click="showVersion(v.at)">{{ when(v.at) }}</button>
        </li>
      </ol>
      <div v-if="shown" class="version-body" :aria-label="`Version of ${when(shown.at)}`" role="region">
        <ViewBody :view="shown.view" />
      </div>
    </details>
    <p v-if="related().length > 0" class="related">
      <span class="muted">Related:</span>
      <template v-for="(t, j) in related()" :key="t.id">
        <template v-if="j > 0">, </template>
        <a :href="`#${t.id}`" @click.prevent="goToTopic(t.id)">{{ t.title }}</a>
      </template>
    </p>
    <footer>
      <span class="muted">{{ view.sources.length }} source{{ view.sources.length === 1 ? '' : 's' }}</span>
      <button
        v-for="(id, i) in view.sources"
        :key="id"
        class="chip"
        :class="{ active: openSource === `${view.id}:${id}`, shared: otherTopics(id).length > 0 }"
        :title="otherTopics(id).length > 0 ? `also in: ${otherTopics(id).map((t) => t.title).join(', ')}` : undefined"
        @click="toggleSource(id)"
      >
        {{ i + 1 }}<span v-if="otherTopics(id).length > 0" class="shared-mark" aria-hidden="true">⧉</span>
      </button>
    </footer>
    <template v-for="id in view.sources" :key="id">
      <blockquote v-if="openSource === `${view.id}:${id}`" class="source">
        {{ state.entries.get(id)?.text ?? 'entry not loaded' }}
        <small class="muted">{{ time(state.entries.get(id)?.at) }}</small>
        <small v-if="otherTopics(id).length > 0" class="also">
          <span class="shared-mark" aria-hidden="true">⧉</span> also in:
          <template v-for="(t, j) in otherTopics(id)" :key="t.id">
            <template v-if="j > 0">, </template>
            <a :href="`#${t.id}`" @click.prevent="goToTopic(t.id, id)">{{ t.title }}</a>
          </template>
        </small>
      </blockquote>
    </template>
  </article>
</template>
