<template>
  <div class="mind-page">
    <div class="mind-body">
      <RouterView />
    </div>
  </div>
</template>

<script setup lang="ts">
import { watch } from 'vue'
import { useRoute } from 'vue-router'

const route = useRoute()

// 记录最近访问的独立页面，供旧 /mind 链接和默认入口恢复使用。
watch(() => route.path, (path) => {
  if (path === '/notes') localStorage.setItem('mind-last-mode', 'notes')
  else if (path === '/canvases') localStorage.setItem('mind-last-mode', 'canvas')
}, { immediate: true })
</script>

<style scoped>
.mind-page { display: flex; flex-direction: column; height: 100%; min-height: 0; box-sizing: border-box; }
.mind-body { position: relative; z-index: 1; flex: 1; min-height: 0; }
/* Web 笔记页沿用全局内容区的内边距。 */
.mind-body > .ntp-layout { padding: 0; }
</style>
