<script setup lang="ts">
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { View } from '../../src/domain'

const props = defineProps<{ view: View }>()

const html = computed(() =>
  props.view.format === 'md' ? DOMPurify.sanitize(marked.parse(props.view.body, { async: false })) : '',
)

// SVG goes through <img>, where the browser never runs its scripts.
const svgSrc = ref<string | null>(null)
const revoke = () => svgSrc.value && URL.revokeObjectURL(svgSrc.value)
watch(
  () => [props.view.format, props.view.body] as const,
  ([format, body]) => {
    revoke()
    svgSrc.value = format === 'svg' ? URL.createObjectURL(new Blob([body], { type: 'image/svg+xml' })) : null
  },
  { immediate: true },
)
onBeforeUnmount(revoke)
</script>

<template>
  <div v-if="view.format === 'md'" class="md" v-html="html" />
  <img v-else-if="view.format === 'svg'" class="svg" :src="svgSrc ?? ''" :alt="view.title" />
  <pre v-else class="ascii">{{ view.body }}</pre>
</template>
