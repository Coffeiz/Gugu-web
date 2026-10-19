<template>
  <svg class="flip-chevron" :class="{ open }" :width="size" :height="size" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
    <path d="M2 3.5l3 3 3-3" />
  </svg>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ open?: boolean; size?: number }>(), { open: false, size: 9 })
</script>

<style scoped>
.flip-chevron { flex-shrink: 0; color: var(--content-tertiary); transform: rotate(-90deg); transition: transform var(--motion-fast) var(--motion-ease-standard); }
.flip-chevron.open { transform: rotate(0deg); }
</style>
