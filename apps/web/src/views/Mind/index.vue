<template>
  <div class="mind-page">
    <MindToolbar v-if="isNotes" />

    <div class="mind-body">
      <RouterView />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, watch } from 'vue'
import { useRoute } from 'vue-router'
import MindToolbar from './components/MindToolbar.vue'

const route = useRoute()
const isNotes = computed(() => route.path === '/notes')

// 记录最近访问的独立页面，供旧 /mind 链接和默认入口恢复使用。
watch(() => route.path, (path) => {
  if (path === '/notes') localStorage.setItem('mind-last-mode', 'notes')
  else if (path === '/canvases') localStorage.setItem('mind-last-mode', 'canvas')
}, { immediate: true })
</script>

<style scoped>
.mind-page { display: flex; flex-direction: column; gap: 8px; height: 100%; min-height: 0; }
.mind-body { position: relative; z-index: 1; flex: 1; min-height: 0; }
</style>
