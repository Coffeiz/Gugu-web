<template>
  <div ref="viewportRef" class="drawer-viewport" :style="{ height: `${height}px` }" data-layout-role="viewport" data-layout-key="drawer-viewport">
    <slot />
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { createDrawerLayoutTransaction } from '@/interaction/drag/animation/flipCoordinator'

const props = defineProps({
  open: { type: Boolean, default: false },
  targetHeight: { type: Number, default: 0 },
})
const height = ref(0)

export interface DrawerScrollSnapshot {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  atBottom: boolean
}

const viewportRef = ref<HTMLElement | null>(null)
let heightTransaction: ReturnType<typeof createDrawerLayoutTransaction> | null = null
watch(() => [props.open, props.targetHeight], ([open, target]) => {
  const nextHeight = open ? Number(target) : 0
  if (!viewportRef.value) {
    height.value = nextHeight
    return
  }
  const preservedScrollTop = viewportRef.value.scrollTop
  heightTransaction?.cancel()
  const transaction = createDrawerLayoutTransaction(viewportRef.value)
  heightTransaction = transaction
  void transaction.play(nextHeight).then(() => {
    if (heightTransaction === transaction) {
      height.value = nextHeight
      // 高度从 0 展开时浏览器可能触发 scroll anchoring，把位置推到最大值；
      // 布局事务只负责高度，不应改变用户原本的滚动位置。
      viewportRef.value!.scrollTop = preservedScrollTop
    }
  })
}, { immediate: true })

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
.drawer-viewport { position: relative; width: 100%; overflow-y: auto; overflow-x: hidden; scrollbar-gutter: stable; overflow-anchor: none; }
.drawer-viewport.canvas-viewport { overflow-y: auto; }
.drawer-viewport.project-viewport { overflow-y: auto; scrollbar-gutter: stable; }
.drawer-viewport::-webkit-scrollbar { width: 3px; }
.drawer-viewport::-webkit-scrollbar-track { background: transparent; }
.drawer-viewport::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.12); border-radius: 99px; }
</style>
