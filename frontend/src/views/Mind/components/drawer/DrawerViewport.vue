<template>
  <div ref="viewportRef" class="drawer-viewport">
    <slot />
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'

export interface DrawerScrollSnapshot {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  atBottom: boolean
}

const viewportRef = ref<HTMLElement | null>(null)

function captureScroll(): DrawerScrollSnapshot | null {
  const element = viewportRef.value
  if (!element) return null
  return {
    scrollTop: element.scrollTop,
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
    atBottom: element.scrollTop + element.clientHeight >= element.scrollHeight - 1,
  }
}

function restoreScroll(snapshot: DrawerScrollSnapshot | null) {
  const element = viewportRef.value
  if (!element || !snapshot) return
  const delta = element.scrollHeight - snapshot.scrollHeight
  element.scrollTop = snapshot.atBottom ? snapshot.scrollTop + delta : snapshot.scrollTop
}

defineExpose({ viewportRef, captureScroll, restoreScroll })
</script>

<style scoped>
.drawer-viewport { position: relative; width: 100%; height: 100%; overflow-y: auto; overflow-x: hidden; scrollbar-gutter: stable; }
.drawer-viewport.canvas-viewport { overflow-y: auto; }
.drawer-viewport.project-viewport { overflow: hidden; scrollbar-gutter: auto; }
.drawer-viewport::-webkit-scrollbar { width: 3px; }
.drawer-viewport::-webkit-scrollbar-track { background: transparent; }
.drawer-viewport::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.12); border-radius: 99px; }
</style>
