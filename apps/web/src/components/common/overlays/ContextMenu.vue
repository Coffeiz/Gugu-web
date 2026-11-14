<template>
  <!-- x/y 都不传时 position 保持 null，PopupMenu 走 anchor 定位（含视口钳制与滚动跟随）；
       只传其一的旧调用方维持原 (…,0) 行为不变 -->
  <PopupMenu :show="show" :anchor="anchor"
    :position="x == null && y == null ? null : { x: x ?? 0, y: y ?? 0 }"
    popup-class="ctx-menu popup-menu">
        <slot />
  </PopupMenu>
</template>

<script setup lang="ts">
import { watch, nextTick, onUnmounted } from 'vue'
import { createPressOutsideGuard } from '@/composables/shared/pressOutsideClose'
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

// 关闭监听必须走捕获阶段：调用方（活动表单等）的外壳可能带 @click.stop，
// 冒泡阶段监听收不到壳内的点击，菜单就会挂着不关。
// 两类点击不关：菜单自身内部（选项交给菜单项处理器）；锚点触发器（交给调用方
// 的 toggle，否则捕获先关、toggle 再开，"再点一次关闭"会失效）。
// 拖选保护：菜单内按下、移出菜单后松开，click 落在外面，不能因此误关
const pressGuard = createPressOutsideGuard((t: Node) =>
  t instanceof HTMLElement && (t.closest('.ctx-menu') != null || (!!props.anchor && props.anchor.contains(t))))
function onDismissPress(e: MouseEvent) { pressGuard.notePress(e) }

function onDismissClick(e: Event) {
  const target = e.target as HTMLElement | null
  if (!target) { pressGuard.shouldCloseOn(e as MouseEvent); return }
  const clickOutside = pressGuard.shouldCloseOn(e as MouseEvent)
  if (target.closest('.ctx-menu')) return
  const anchor = props.anchor
  if (anchor && anchor.contains(target)) return
  if (!clickOutside) return
  close()
}

watch(() => props.show, async (v) => {
  if (v) {
    const cycle = ++openCycle
    await nextTick()
    // PopupMenu 负责 Teleport、层级和定位；菜单内容只处理边界关闭事件。
    // 按打开周期绑定，避免关闭后延迟任务仍注册旧监听，下一次点击误触发二次离场。
    if (!props.show || cycle !== openCycle) return
    document.addEventListener('mousedown', onDismissPress, { capture: true })
    document.addEventListener('click', onDismissClick, { capture: true })
    document.addEventListener('contextmenu', onDismissClick, { capture: true })
    document.addEventListener('keydown', onKey)
  } else {
    openCycle += 1
    document.removeEventListener('keydown', onKey)
    document.removeEventListener('mousedown', onDismissPress, { capture: true })
    document.removeEventListener('click',       onDismissClick, { capture: true })
    document.removeEventListener('contextmenu', onDismissClick, { capture: true })
  }
})

onUnmounted(() => {
  document.removeEventListener('keydown', onKey)
  document.removeEventListener('click',       onDismissClick, { capture: true })
  document.removeEventListener('contextmenu', onDismissClick, { capture: true })
})
</script>

<style scoped>
:global(.ctx-menu) {
  width: 160px;
  min-width: 160px;
  box-sizing: border-box;
}
</style>
