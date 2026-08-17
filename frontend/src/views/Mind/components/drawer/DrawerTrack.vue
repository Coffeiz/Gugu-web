<template>
  <div ref="trackRef" class="drawer-track scroll-surface scroll-surface--compact" data-layout-role="track" data-layout-key="drawer-track">
    <slot />
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'

export interface DrawerTrackLayout {
  rect: DOMRect
  scrollHeight: number
}

const trackRef = ref<HTMLElement | null>(null)
function captureLayout(): DrawerTrackLayout | null {
  const element = trackRef.value
  if (!element) return null
  return { rect: element.getBoundingClientRect(), scrollHeight: element.scrollHeight }
}

defineExpose({ trackRef, captureLayout })
</script>

<style scoped>
.drawer-track { position: relative; width: 100%; min-height: 0; overflow-anchor: none; }
.drawer-track[data-drawer-scroll] { overflow-anchor: none; }
</style>
