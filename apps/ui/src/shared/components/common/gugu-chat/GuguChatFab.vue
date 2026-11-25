<template>
  <div ref="shellRef" class="ai-fab-shell" :class="{ 'ai-fab-shell--playing': rippleActive, 'ai-fab-shell--drop-hover': dropHover }" :style="{ zIndex: fabZ, translate: dragOffset, opacity: previewOutside ? 0 : undefined, transition: dragging ? 'none' : 'translate 220ms ease-out' }"
    @pointerover="onPointerOver" @pointerleave="dropHover = false">
    <button class="ai-fab" :class="{ 'ai-fab--playing': rippleActive }" @click="onClick" @pointerdown="beginDrag" @pointermove="moveDrag" @pointerup="endDrag"
      @pointercancel="cancelDrag" @lostpointercapture="cancelDrag" :title="t('chatUi.gugu')">
      <span ref="svgRef"
            class="ai-fab-logo"
            :class="{ 'ai-fab-spin': hasAudioFile && !spinningBack, 'ai-fab--typing': fabJumping }"
            :style="hasAudioFile && !spinningBack ? { animationPlayState: audioPlaying ? 'running' : 'paused' } : {}"
            aria-hidden="true" />
    </button>
  </div>
</template>

<script setup lang="ts">
/**
 * 悬浮球：纯展示 + 点击转发。转圈/涟漪/打字跳动都是外部状态驱动。
 * Design 页的 GuguChatMock 与这里共享同一组 --gugu-fab-* 令牌，避免样板另画一套。
 */
import { ref, computed, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  dragFab?: (action: 'down' | 'move' | 'up' | 'cancel', x: number, y: number) => void
  rippleActive: boolean
  fabZ: number
  hasAudioFile: boolean
  spinningBack: boolean
  fabJumping: boolean
  audioPlaying: boolean
}>()
const { t } = useI18n()

const emit = defineEmits<{ click: [] }>()
const dragOffset = ref<string>()
const dragging = ref(false)
const previewOutside = ref(false)
let pointer: { id: number; x: number; y: number } | undefined
let suppressClick = false

function beginDrag(event: PointerEvent) {
  if (!props.dragFab || event.button !== 0 || event.pointerType !== 'mouse' || pointer) return
  suppressClick = false
  pointer = { id: event.pointerId, x: event.screenX, y: event.screenY }
  const button = event.currentTarget as HTMLElement
  button.setPointerCapture(event.pointerId)
  props.dragFab('down', event.screenX, event.screenY)
}
function moveDrag(event: PointerEvent) {
  if (pointer?.id !== event.pointerId) return
  const x = event.screenX - pointer.x, y = event.screenY - pointer.y
  if (!dragging.value && Math.hypot(x, y) < 5) return
  dragging.value = true
  previewOutside.value = event.clientX < 0 || event.clientY < 0 || event.clientX >= window.innerWidth || event.clientY >= window.innerHeight
  dragOffset.value = `${x}px ${y}px`
  props.dragFab?.('move', event.screenX, event.screenY)
}
function finishDrag(action: 'up' | 'cancel', x: number, y: number) {
  if (!pointer) return
  pointer = undefined
  suppressClick = action === 'cancel' || dragging.value
  props.dragFab?.(action, x, y)
  dragging.value = false
  previewOutside.value = false
  dragOffset.value = '0px 0px'
}
function endDrag(event: PointerEvent) {
  if (pointer?.id !== event.pointerId) return
  moveDrag(event)
  finishDrag('up', event.screenX, event.screenY)
}
function cancelDrag(event: PointerEvent) {
  if (pointer?.id === event.pointerId) finishDrag('cancel', event.screenX, event.screenY)
}
function cancelOnEscape(event: KeyboardEvent) {
  if (event.key !== 'Escape' || !pointer) return
  event.preventDefault()
  event.stopImmediatePropagation()
  finishDrag('cancel', pointer.x, pointer.y)
}
function onClick(event: MouseEvent) {
  if (event.detail === 0 || !suppressClick) emit('click')
  suppressClick = false
}
window.addEventListener('keydown', cancelOnEscape, true)
onUnmounted(() => {
  if (pointer) finishDrag('cancel', pointer.x, pointer.y)
  window.removeEventListener('keydown', cancelOnEscape, true)
})

const svgRef = ref<HTMLElement | null>(null)
const shellRef = ref<HTMLElement | null>(null)
const dropHover = ref(false)
function onPointerOver(event: PointerEvent) {
  if ((event.buttons & 1) && document.querySelector('[data-runtime-active]')) dropHover.value = true
}
function onPointerUp() { dropHover.value = false }
window.addEventListener('pointerup', onPointerUp, true)
onUnmounted(() => window.removeEventListener('pointerup', onPointerUp, true))
defineExpose({ svgEl: computed(() => svgRef.value), dropTargetEl: computed(() => shellRef.value) })
</script>

<style scoped>
.ai-fab {
  position: relative;
  z-index: 1;
  width: var(--gugu-fab-size);
  height: var(--gugu-fab-size);
  border-radius: 50%;
  background: color-mix(in srgb, var(--surface-card-solid) 68%, transparent);
  backdrop-filter: var(--popup-surface-blur);
  -webkit-backdrop-filter: var(--popup-surface-blur);
  border: 1px solid var(--gugu-fab-border);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: var(--gugu-fab-shadow);
  transition:
    transform var(--motion-hover-control) var(--motion-ease-standard),
    box-shadow var(--motion-hover-control) var(--motion-ease-standard),
    background-color var(--motion-hover-control) var(--motion-ease-standard),
  border-color var(--motion-hover-control) var(--motion-ease-standard);
}
.ai-fab-shell {
  position: fixed;
  right: var(--floating-edge);
  bottom: var(--floating-edge);
  isolation: isolate;
  width: var(--gugu-fab-size);
  height: var(--gugu-fab-size);
}
.ai-fab-shell--playing::before,
.ai-fab-shell--playing::after {
  content: '';
  position: absolute;
  z-index: 0;
  inset: 0;
  border-radius: 50%;
  border: 1.5px solid var(--gugu-fab-ripple);
  pointer-events: none;
  animation: fab-ripple 3.6s ease-out infinite;
}
.ai-fab-shell--playing::after { animation-delay: 1.8s; }
.ai-fab-shell--drop-hover .ai-fab { transform: scale(1.12); box-shadow: var(--gugu-fab-hover-shadow), var(--control-focus-shadow); }
.ai-fab:hover {
  transform: scale(1.08);
  box-shadow: var(--gugu-fab-hover-shadow);
}
.ai-fab:focus-visible { outline: none; box-shadow: var(--gugu-fab-hover-shadow), var(--control-focus-shadow); }
.ai-fab-logo {
  position: relative;
  z-index: 1;
  width: var(--gugu-fab-logo-size);
  height: var(--gugu-fab-logo-size);
  display: block;
  background: url('/brand/bird-colored.svg') center / contain no-repeat;
}
.ai-fab-spin { animation: fab-spin 8s linear infinite; transform-origin: center; }
@keyframes fab-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
@keyframes fab-ripple { 0% { transform: scale(.4); opacity: .8; } 100% { transform: scale(1.55); opacity: 0; } }
@keyframes fab-typing { 0% { transform: translateY(0); } 50% { transform: translateY(-2px); } 100% { transform: translateY(0); } }
.ai-fab--typing { animation: fab-typing .2s linear 1; }
</style>
