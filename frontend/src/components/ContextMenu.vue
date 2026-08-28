<template>
  <PopupMenu :show="show" :position="{ x: x ?? 0, y: y ?? 0 }" popup-class="ctx-menu popup-menu">
        <slot />
  </PopupMenu>
</template>

<script setup lang="ts">
import { watch, nextTick, onUnmounted } from 'vue'
import PopupMenu from '@/components/common/PopupMenu.vue'

const props = defineProps({ show: Boolean, x: Number, y: Number })
const emit  = defineEmits(['close'])

function close() { emit('close') }

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') close()
}

watch(() => props.show, async (v) => {
  if (v) {
    await nextTick()
    // 边缘修正
    // PopupMenu 负责 Teleport、层级和定位；菜单内容只处理边界关闭事件。
    setTimeout(() => document.addEventListener('click',       close, { once: true }), 0)
    setTimeout(() => document.addEventListener('contextmenu', close, { once: true }), 0)
    document.addEventListener('keydown', onKey)
  } else {
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
.ctx-menu { min-width: 160px; }
</style>
