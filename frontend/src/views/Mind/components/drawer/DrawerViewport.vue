<template>
  <div ref="viewportRef" class="drawer-viewport" :style="{ '--drawer-height': `${height}px` }" data-layout-role="viewport" data-layout-key="drawer-viewport">
    <slot />
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { transitionGroupHeight } from '@/interaction/runtime'

const props = defineProps({
  open: { type: Boolean, default: false },
  targetHeight: { type: Number, default: 0 },
  scrollKey: { type: String, default: '' },
})
const height = ref(0)
const isAnimating = ref(false)

export interface DrawerScrollSnapshot {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  atBottom: boolean
}

const viewportRef = ref<HTMLElement | null>(null)
function scrollElement(): HTMLElement | null {
  const key = String(props.scrollKey || '').replace(/"/g, '\\"')
  return viewportRef.value?.querySelector<HTMLElement>(`[data-drawer-scroll="${key}"]`) ?? viewportRef.value
}
function animateTo(nextHeight: number) {
  if (!viewportRef.value) {
    height.value = nextHeight
    return
  }
  const currentHeight = viewportRef.value.getBoundingClientRect().height
  if (Math.abs(currentHeight - nextHeight) < 0.5) {
    isAnimating.value = false
    height.value = nextHeight
    return
  }
  const preservedScrollElement = scrollElement()
  const preservedScrollTop = preservedScrollElement?.scrollTop ?? 0
  isAnimating.value = true
  const started = transitionGroupHeight(viewportRef.value, nextHeight, undefined, undefined, undefined, true)
  if (!started) {
    // Runtime 正在接管同一 Surface 的高度；这里只更新最终自然高度，
    // 让 CSS 变量在 Runtime 恢复 inline height 后接管布局，不再启动第二条动画。
    height.value = nextHeight
    isAnimating.value = false
    return
  }
  window.setTimeout(() => {
    height.value = nextHeight
    isAnimating.value = false
    // 高度从 0 展开时浏览器可能触发 scroll anchoring，把位置推到最大值；
    // 布局事务只负责高度，不应改变用户原本的滚动位置。
    if (preservedScrollElement) preservedScrollElement.scrollTop = preservedScrollTop
  }, 390)
}
watch(() => [props.open, props.targetHeight], ([open, target]) => {
  animateTo(open ? Number(target) : 0)
}, { immediate: true })

function captureScroll(): DrawerScrollSnapshot | null {
  const element = scrollElement()
  if (!element) return null
  return {
    scrollTop: element.scrollTop,
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
    // 没有实际溢出时不能算“底部锚点”；否则展开第一组后 scrollHeight 增大，
    // restoreScroll 会把原本的顶部位置错误换算成新内容的最底部。
    atBottom: element.scrollHeight > element.clientHeight + 1
      && element.scrollTop + element.clientHeight >= element.scrollHeight - 1,
  }
}

function restoreScroll(snapshot: DrawerScrollSnapshot | null) {
  const element = scrollElement()
  if (!element || !snapshot) return
  const delta = element.scrollHeight - snapshot.scrollHeight
  const target = snapshot.atBottom ? snapshot.scrollTop + delta : snapshot.scrollTop
  element.scrollTop = Math.max(0, Math.min(target, element.scrollHeight - element.clientHeight))
  // 组高度事务和 Vue 的 DOM 提交可能跨两个 frame；再确认一次最终轨道位置，
  // 防止浏览器在中间布局阶段按旧 scrollHeight 做 scroll anchoring。
  requestAnimationFrame(() => {
    if (scrollElement() !== element) return
    element.scrollTop = Math.max(0, Math.min(target, element.scrollHeight - element.clientHeight))
  })
}

defineExpose({ viewportRef, captureScroll, restoreScroll, animateTo, isAnimating })
</script>

<style scoped>
.drawer-viewport { position: relative; width: 100%; height: var(--drawer-height); overflow: hidden; overflow-anchor: none; }
.drawer-viewport [data-drawer-scroll] { overflow-anchor: none; }
.drawer-viewport.canvas-viewport, .drawer-viewport.project-viewport { overflow: hidden; }
.drawer-viewport::-webkit-scrollbar { width: 3px; }
.drawer-viewport::-webkit-scrollbar-track { background: transparent; }
.drawer-viewport::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.12); border-radius: 99px; }
</style>
