<template>
  <div
    ref="wrapRef"
    class="iv-wrap"
    @wheel.prevent="onWheel"
    @mousedown="onMouseDown"
    @dblclick="reset"
  >
    <img
      v-if="blobUrl"
      ref="imgRef"
      :src="blobUrl"
      class="iv-img"
      :class="{ 'iv-grabbing': dragging }"
      :style="imgStyle"
      draggable="false"
      @load="onLoad"
      @error="onError"
    />
    <div v-if="error" class="iv-status">
      <PhImageBroken :size="32" style="opacity:.5" />
      <span>图片加载失败</span>
    </div>

    <!-- 缩放工具栏 -->
    <div v-if="!error" class="iv-toolbar" @mousedown.stop @dblclick.stop>
      <button class="iv-tb-btn" title="缩小" @click="zoomOut">
        <PhMinus weight="bold" :size="12" />
      </button>
      <span class="iv-tb-pct" @click="reset" title="重置缩放">{{ pct }}%</span>
      <button class="iv-tb-btn" title="放大" @click="zoomIn">
        <PhPlus weight="bold" :size="12" />
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onUnmounted } from 'vue'
import { PhImageBroken, PhMinus, PhPlus } from '@phosphor-icons/vue'

const PADDING = 32

const props = defineProps({
  blobUrl: { type: String, default: null },
})

const wrapRef = ref<HTMLElement | null>(null)
const imgRef  = ref<HTMLImageElement | null>(null)
const scale   = ref(1)
const tx      = ref(0)
const ty      = ref(0)
const dragging = ref(false)
const error    = ref(false)

let dragStart: { x: number; y: number } | null = null

const imgStyle = computed(() => ({
  transform: `translate(${tx.value}px, ${ty.value}px) scale(${scale.value})`,
  cursor: dragging.value ? 'grabbing' : 'grab',
}))

function getBounds() {
  if (!wrapRef.value || !imgRef.value) return { maxTx: 0, maxTy: 0 }
  const img  = imgRef.value
  // 限制区域 = 图片布局尺寸的 200%，与 scale 无关
  const maxTx = img.clientWidth  * 0.5
  const maxTy = img.clientHeight * 0.5
  return { maxTx, maxTy }
}

function clamp() {
  const { maxTx, maxTy } = getBounds()
  tx.value = Math.max(-maxTx, Math.min(maxTx, tx.value))
  ty.value = Math.max(-maxTy, Math.min(maxTy, ty.value))
}

const pct = computed(() => Math.round(scale.value * 100))

function applyZoom(newScale: number) {
  scale.value = Math.min(8, Math.max(0.05, newScale))
  clamp()
}

function onWheel(e: WheelEvent) {
  const delta = e.deltaY > 0 ? -0.1 : 0.1
  applyZoom(scale.value + delta * scale.value)
}

function zoomIn()  { applyZoom(scale.value * 1.25) }
function zoomOut() { applyZoom(scale.value / 1.25) }

function onMouseDown(e: MouseEvent) {
  if (e.button !== 0) return
  dragging.value = true
  dragStart = { x: e.clientX - tx.value, y: e.clientY - ty.value }
  window.addEventListener('mousemove', onMouseMove)
  window.addEventListener('mouseup', onMouseUp)
}

function onMouseMove(e: MouseEvent) {
  if (!dragging.value || !dragStart) return
  tx.value = e.clientX - dragStart.x
  ty.value = e.clientY - dragStart.y
  clamp()
}

function onMouseUp() {
  dragging.value = false
  window.removeEventListener('mousemove', onMouseMove)
  window.removeEventListener('mouseup', onMouseUp)
}

function reset() {
  scale.value = 1
  tx.value = 0
  ty.value = 0
}

const emit = defineEmits(['loaded'])
function onLoad() { error.value = false; emit('loaded') }
function onError() { error.value = true }

onUnmounted(() => {
  window.removeEventListener('mousemove', onMouseMove)
  window.removeEventListener('mouseup', onMouseUp)
})
</script>

<style scoped>
.iv-wrap {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px;
  background: rgba(230, 232, 240, 0.5);
  user-select: none;
  overflow: visible;
}

.iv-img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  transform-origin: center;
  transition: transform 0.08s ease-out;
  border-radius: 6px;
  box-shadow: 0 4px 24px rgba(20,25,60,0.12);
}

.iv-img.iv-grabbing {
  transition: none;
}

.iv-status {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  color: var(--text-secondary);
  font-size: 13px;
}

/* ── 缩放工具栏 ── */
.iv-toolbar {
  position: absolute;
  z-index: 2;
  bottom: 14px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 1px;
  background: rgba(255, 255, 255, 0.68);
  backdrop-filter: blur(18px);
  -webkit-backdrop-filter: blur(18px);
  border: 1px solid rgba(255, 255, 255, 0.82);
  border-radius: 20px;
  padding: 3px 5px;
  pointer-events: auto;
  box-shadow:
    0 4px 16px rgba(80, 90, 110, 0.10),
    inset 0 1px 0 rgba(255, 255, 255, 0.95),
    inset 1px 0 0 rgba(255, 255, 255, 0.55);
}
.iv-tb-btn {
  width: 26px; height: 26px;
  border-radius: 50%; border: none;
  background: transparent; color: var(--text-secondary);
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; transition: background 0.15s, color 0.15s;
}
.iv-tb-btn svg { display: block; }
.iv-tb-btn:hover {
  background: rgba(123, 127, 178, 0.12);
  color: var(--color-primary);
}
.iv-tb-pct {
  font-size: 11px; font-weight: 600;
  color: var(--text-secondary);
  min-width: 38px; text-align: center;
  cursor: pointer; letter-spacing: 0.02em;
  padding: 0 2px; transition: color 0.15s;
}
.iv-tb-pct:hover { color: var(--text-primary); }
</style>
