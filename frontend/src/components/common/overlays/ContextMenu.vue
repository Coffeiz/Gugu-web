<template>
  <PopupMenu :show="show" :anchor="anchor" :position="{ x: x ?? 0, y: y ?? 0 }" popup-class="ctx-menu popup-menu">
        <slot />
  </PopupMenu>
</template>

<script setup lang="ts">
import { watch, nextTick, onUnmounted } from 'vue'
import PopupMenu from '@/components/common/overlays/PopupMenu.vue'

const props = defineProps({
  show: Boolean,
  x: Number,
  y: Number,
  anchor: { type: Object as () => HTMLElement | null, default: null },
})
const emit  = defineEmits(['close'])
let openCycle = 0

function close() { emit('close') }

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') close()
}

watch(() => props.show, async (v) => {
  if (v) {
    const cycle = ++openCycle
    await nextTick()
    // PopupMenu 负责 Teleport、层级和定位；菜单内容只处理边界关闭事件。
    // 按打开周期绑定，避免关闭后延迟任务仍注册旧监听，下一次点击误触发二次离场。
    if (!props.show || cycle !== openCycle) return
    document.addEventListener('click', close)
    document.addEventListener('contextmenu', close)
    document.addEventListener('keydown', onKey)
  } else {
    openCycle += 1
    document.removeEventListener('keydown', onKey)
    document.removeEventListener('click',       close)
    document.removeEventListener('contextmenu', close)
  }
})

onUnmounted(() => {
  document.removeEventListener('keydown', onKey)
  document.removeEventListener('click',       close)
  document.removeEventListener('contextmenu', close)
})
</script>

<style scoped>
:global(.ctx-menu) {
  width: 160px;
  min-width: 160px;
  box-sizing: border-box;
}
</style>
