<template>
  <Teleport to="body">
    <Transition name="menu-pop" @before-leave="raiseLeaveLayer" @after-leave="emit('after-leave')">
      <!-- v-if 只在打开或离场过渡期间挂载，避免每个业务实例长期留下隐藏 host 占位。 -->
      <div v-if="show" ref="popupRef" class="popup-menu-host" :class="[popupClass, { 'popup-menu-host--transparent': transparent }]" :style="transparent ? { ...popupStyle, padding: 0, border: 0, background: 'transparent', boxShadow: 'none', backdropFilter: 'none', WebkitBackdropFilter: 'none' } : popupStyle" @mousedown.stop @click.stop @contextmenu.prevent>
        <slot />
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch, type PropType } from 'vue'
import { nextZ, registerPopover, TOP_Z } from '@/composables/windowz'

const props = defineProps({
  show: { type: Boolean, default: false },
  anchor: { type: Object as PropType<HTMLElement | null>, default: null },
  popupClass: { type: String, default: '' },
  transparent: { type: Boolean, default: false },
  placement: { type: String as PropType<'bottom' | 'top'>, default: 'bottom' },
  position: { type: Object as PropType<{ x: number; y: number } | null>, default: null },
  style: { type: Object as PropType<Record<string, string | number | undefined>>, default: () => ({}) },
})
const emit = defineEmits<{ 'after-leave': [] }>()
const popupRef = ref<HTMLElement | null>(null)
const popupZ = ref(0)
const popupStyle = ref<Record<string, string | number | undefined>>({ position: 'fixed' })
let unregister: (() => void) | null = null

function setPopupZ(z: number) {
  popupZ.value = z
  popupStyle.value = { ...popupStyle.value, zIndex: z }
  if (popupRef.value) popupRef.value.style.zIndex = String(z)
}

// 离场第一帧就提升层级，避免过渡 class 尚未生效时短暂落到宿主面板后面。
function raiseLeaveLayer(el: Element) {
  const node = el as HTMLElement
  setPopupZ(100001)
  // Transition 钩子执行到下一次渲染前，直接写 DOM，避免离场第一帧仍沿用旧 z-index。
  node.style.zIndex = '100001'
}

function raiseBeforeAnchorInteraction(event: MouseEvent) {
  if (!props.show || !props.anchor?.contains(event.target as Node)) return
  setPopupZ(100001)
}

function position() {
  const rect = props.anchor?.getBoundingClientRect()
  if (props.position) {
    popupStyle.value = { ...popupStyle.value, ...props.style, left: `${props.position.x}px`, top: `${props.position.y}px`, zIndex: popupZ.value || nextZ() }
    return
  }
  if (!rect) return
  const popupWidth = popupRef.value?.offsetWidth || rect.width
  const popupHeight = popupRef.value?.offsetHeight || 0
  const rawLeft = props.placement === 'top'
    ? rect.left + (rect.width - popupWidth) / 2
    : rect.left
  const rawTop = props.placement === 'top'
    ? rect.top - popupHeight - 8
    : rect.bottom + 5
  const left = Math.max(6, Math.min(rawLeft, window.innerWidth - popupWidth - 6))
  const top = props.placement === 'top'
    ? Math.max(6, rawTop)
    : Math.min(rawTop, window.innerHeight - popupHeight - 6)
  popupStyle.value = { ...popupStyle.value, ...props.style, left: `${left}px`, top: `${top}px`, minWidth: props.placement === 'bottom' ? `${rect.width}px` : undefined, zIndex: popupZ.value || nextZ() }
}
function refresh() { void nextTick(position) }
watch(() => props.style, value => {
  const next = { ...popupStyle.value, ...value }
  for (const key of ['top', 'bottom', 'left', 'right', 'width', 'minWidth', 'transformOrigin']) {
    if (!(key in value)) delete next[key]
  }
  popupStyle.value = next
}, { deep: true })
watch(() => props.show, value => {
  unregister?.(); unregister = value ? registerPopover(setPopupZ) : null
  if (value) { popupZ.value = nextZ(); popupStyle.value = { ...popupStyle.value, ...props.style, zIndex: popupZ.value }; refresh() } else popupZ.value = TOP_Z + 1
  // show 关闭时先于 DOM patch 提升当前节点，避免点击空白路径在 before-leave 前被宿主面板盖住。
  if (!value && popupRef.value) {
    setPopupZ(100001)
  }
}, { immediate: true })
onMounted(() => { document.addEventListener('mousedown', raiseBeforeAnchorInteraction, true); window.addEventListener('resize', refresh); window.addEventListener('scroll', refresh, true) })
onBeforeUnmount(() => { unregister?.(); document.removeEventListener('mousedown', raiseBeforeAnchorInteraction, true); window.removeEventListener('resize', refresh); window.removeEventListener('scroll', refresh, true) })
defineExpose({ contains: (target: Node) => !!popupRef.value?.contains(target), element: () => popupRef.value })
</script>

<style scoped>
.popup-menu-host { padding: var(--popup-surface-padding); border: 1px solid var(--popup-surface-border); border-radius: var(--popup-surface-radius); background: var(--popup-surface-bg); box-shadow: var(--popup-surface-shadow), inset 0 1px 0 var(--popup-surface-highlight); backdrop-filter: var(--popup-surface-blur); -webkit-backdrop-filter: var(--popup-surface-blur); }
:global(.popup-menu-host--transparent) { padding: 0; border: 0; border-radius: 0; background: transparent; box-shadow: none; backdrop-filter: none; -webkit-backdrop-filter: none; }
:global(.popup-menu-host.menu-pop-leave-active) { z-index: 100001 !important; }
</style>
