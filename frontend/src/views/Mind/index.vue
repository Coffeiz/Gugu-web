<template>
  <div class="mind-page">
    <!-- 正式笔记与 DEV 时间轴共用同一 Mind 顶栏。 -->
    <MindToolbar />

    <div class="mind-body">
      <RouterView />
    </div>
  </div>
</template>

<script setup lang="ts">
import { watch } from 'vue'
import { useRoute } from 'vue-router'
import MindToolbar from './components/MindToolbar.vue'

const route = useRoute()

// /mind 是侧栏唯一入口；把当前子视图记下来，下一次从侧栏回来时由路由重定向恢复它。
watch(() => route.path, (path) => {
  if (path.startsWith('/mind/notes')) localStorage.setItem('mind-last-mode', 'notes')
  else if (path.startsWith('/mind/canvases')) localStorage.setItem('mind-last-mode', 'canvas')
}, { immediate: true })
</script>

<style scoped>
.mind-page { display: flex; flex-direction: column; gap: 8px; height: 100%; min-height: 0; }
.mind-body { position: relative; z-index: 1; flex: 1; min-height: 0; }
</style>
