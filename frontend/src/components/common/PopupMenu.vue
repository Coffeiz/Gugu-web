<template>
  <Teleport to="body">
    <Transition name="menu-pop">
      <div v-show="show" ref="popupRef" class="popup-menu-host" :class="popupClass" :style="popupStyle" @mousedown.stop @click.stop @contextmenu.prevent>
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
  position: { type: Object as PropType<{ x: number; y: number } | null>, default: null },
  style: { type: Object as PropType<Record<string, string | number | undefined>>, default: () => ({}) },
})
const popupRef = ref<HTMLElement | null>(null)
const popupZ = ref(0)
const popupStyle = ref<Record<string, string | number>>({ position: 'fixed' })
let unregister: (() => void) | null = null

function position() {
  const rect = props.anchor?.getBoundingClientRect()
  if (props.position) {
    popupStyle.value = { ...popupStyle.value, ...props.style, left: `${props.position.x}px`, top: `${props.position.y}px`, zIndex: popupZ.value || nextZ() }
    return
  }
  if (!rect) return
  popupStyle.value = { ...popupStyle.value, ...props.style, left: `${rect.left}px`, top: `${rect.bottom + 5}px`, minWidth: `${rect.width}px`, zIndex: popupZ.value || nextZ() }
}
function refresh() { void nextTick(position) }
watch(() => props.show, value => {
  unregister?.(); unregister = value ? registerPopover(z => { popupZ.value = z }) : null
  if (value) { popupZ.value = nextZ(); popupStyle.value = { ...popupStyle.value, ...props.style, zIndex: popupZ.value }; refresh() } else popupZ.value = TOP_Z + 1
})
onMounted(() => { window.addEventListener('resize', refresh); window.addEventListener('scroll', refresh, true) })
onBeforeUnmount(() => { unregister?.(); window.removeEventListener('resize', refresh); window.removeEventListener('scroll', refresh, true) })
defineExpose({ contains: (target: Node) => !!popupRef.value?.contains(target) })
</script>

<style scoped>
.popup-menu-host { padding: var(--popup-surface-padding); border: 1px solid var(--popup-surface-border); border-radius: var(--popup-surface-radius); background: var(--popup-surface-bg); box-shadow: var(--popup-surface-shadow), inset 0 1px 0 var(--popup-surface-highlight); backdrop-filter: var(--popup-surface-blur); -webkit-backdrop-filter: var(--popup-surface-blur); }
:global(.popup-menu-host.menu-pop-leave-active) { z-index: 100001 !important; }
</style>
