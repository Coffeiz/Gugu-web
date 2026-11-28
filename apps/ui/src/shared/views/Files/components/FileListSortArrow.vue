<template>
  <svg class="lh-arrow" :class="{ desc: descending }" width="8" height="8" viewBox="0 0 10 10"
    aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
    <path d="M5 2v6M2 5l3-3 3 3" />
  </svg>
</template>

<script setup lang="ts">
defineProps<{ descending: boolean }>()
</script>
