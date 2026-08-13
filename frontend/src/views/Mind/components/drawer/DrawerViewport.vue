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
.drawer-viewport { position: relative; width: 100%; overflow: hidden; overflow-anchor: none; }
.drawer-viewport [data-drawer-scroll] { overflow-anchor: none; }
.drawer-viewport.canvas-viewport, .drawer-viewport.project-viewport { overflow: hidden; }
.drawer-viewport::-webkit-scrollbar { width: 3px; }
.drawer-viewport::-webkit-scrollbar-track { background: transparent; }
.drawer-viewport::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.12); border-radius: 99px; }
</style>
