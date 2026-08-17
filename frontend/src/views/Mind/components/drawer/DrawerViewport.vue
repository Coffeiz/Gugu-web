<template>
  <div ref="viewportRef" class="drawer-viewport" data-layout-role="viewport" data-layout-key="drawer-viewport">
    <slot />
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'

const viewportRef = ref<HTMLElement | null>(null)

defineExpose({ viewportRef })
</script>

<style scoped>
.drawer-viewport { position: relative; width: 100%; flex: 0 0 auto; overflow: hidden; overflow-anchor: none; }
.drawer-viewport:not(.is-visible) { height: 0; }
.drawer-viewport.is-visible { height: auto; }
.drawer-viewport [data-drawer-scroll] { overflow-anchor: none; }
.drawer-viewport.canvas-viewport, .drawer-viewport.project-viewport { overflow: hidden; }
</style>
