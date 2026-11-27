<script setup lang="ts">
import { useDelayedSkeleton } from '@/composables/core/useDelayedSkeleton'
import PageLoadingState from '../PageLoadingState.vue'
const props = defineProps({ preserveShell: Boolean })
const visible = useDelayedSkeleton(() => true)
</script>

<template>
  <div v-if="props.preserveShell" class="page-loading-shell">
    <div class="page-loading-shell__panels"><slot :visible="false" /></div>
    <PageLoadingState v-if="visible" class="page-loading-shell__state" :delayed="false" />
  </div>
  <PageLoadingState v-else :delayed="true" />
</template>

<style scoped>
.page-loading-shell { position: relative; grid-column: 1 / -1; flex: 1; width: 100%; min-height: 240px; height: 100%; }
.page-loading-shell__panels { display: contents; }
.page-loading-shell__state { position: absolute; inset: 0; }
</style>
