<script setup lang="ts">
import Icon from './Icon.vue'
import { MIND_REF_TYPE_ICON_PATH } from './referenceIconPaths'

defineProps<{ type: string; size: number }>()
</script>

<template>
  <svg v-if="MIND_REF_TYPE_ICON_PATH[type]" :width="size" :height="size" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">
    <path :d="MIND_REF_TYPE_ICON_PATH[type]" />
  </svg>
  <Icon v-else :name="type === 'client' ? 'communication.customer' : 'canvas.note'" :size="size" />
</template>
