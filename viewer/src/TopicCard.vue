<script setup lang="ts">
import { ref } from 'vue'
import type { View } from '../../src/domain'
import { derivedBySource, goToTopic, openSource, state, topicsByEntry } from './live'
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
      <ol v-if="historyOpen" :id="`${view.id}:titles`" class="past-titles" aria-label="earlier titles">
        <li v-for="p in newestFirst(view)" :key="p.until">
          <span>{{ p.title }}</span>
          <time class="muted" :datetime="p.until">{{ when(p.until) }}</time>
        </li>
      </ol>
    </template>
    <ViewBody :view="view" />
    <ViewBody v-for="d in derivedBySource.get(view.id) ?? []" :key="d.id" :view="d" class="derived" />
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
