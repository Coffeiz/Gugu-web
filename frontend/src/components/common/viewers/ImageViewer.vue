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
      :class="{ 'iv-grabbing': dragging, 'iv-ready': imageReady, 'iv-no-transition': disableTransition }"
      :style="imgStyle"
      draggable="false"
      @load="onLoad"
      @error="onError"
    />
    <div v-if="error" class="iv-status">
      <Icon name="file.image" :size="32" style="opacity:.5" />
      <span>{{ t('viewerUi.imageLoadFailed') }}</span>
    </div>

    <!-- 缩放工具栏 -->
    <div v-if="!error" class="iv-toolbar" @mousedown.stop @dblclick.stop>
      <button class="iv-tb-btn" :title="t('viewerUi.zoomOut')" @click="zoomOut">
        <Icon name="action.subtract" :size="12" />
      </button>
      <span class="iv-tb-pct" @click="reset" :title="t('viewerUi.resetZoom')">{{ pct }}%</span>
      <button class="iv-tb-btn" :title="t('viewerUi.zoomIn')" @click="zoomIn">
        <Icon name="action.add" :size="12" />
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import Icon from '@/components/common/icons/Icon.vue'
import { useI18n } from 'vue-i18n'
const { t } = useI18n()
const PADDING = 32
// 溢出钳制的宽松系数：1.0 = 图片边缘最多贴视口边缘；1.5 = 允许再推出去半程留白
const PAN_SLACK = 1.5
// 手动缩放上限；矢量文件（upscale）自动适配也允许放大到该上限填满视口
const MAX_ZOOM = 8

const props = defineProps({
  blobUrl: { type: String, default: null },
  // 矢量图（svg）放大无损：打开时自动适配允许超过 100% 填满视口。
  // 位图保持默认（适配不放大），避免糊。
  upscale: { type: Boolean, default: false },
})

const wrapRef = ref<HTMLElement | null>(null)
const imgRef  = ref<HTMLImageElement | null>(null)
const scale   = ref(1)
const tx      = ref(0)
const ty      = ref(0)
const naturalWidth = ref(0)
const naturalHeight = ref(0)
const hasUserZoom = ref(false)
const imageReady = ref(false)
const disableTransition = ref(false)
const dragging = ref(false)
const error    = ref(false)

let dragStart: { x: number; y: number } | null = null
let resizeObserver: ResizeObserver | null = null
let transitionRaf: number | null = null

const imgStyle = computed(() => ({
  transform: `translate(${tx.value}px, ${ty.value}px) scale(${scale.value})`,
  width: naturalWidth.value ? `${naturalWidth.value}px` : undefined,
  height: naturalHeight.value ? `${naturalHeight.value}px` : undefined,
  cursor: dragging.value ? 'grabbing' : 'grab',
}))

function getBounds() {
  if (!wrapRef.value || !imgRef.value) return { maxTx: 0, maxTy: 0 }
  const wrap = wrapRef.value
  const img  = imgRef.value
  // 放大到超出视口时，平移范围 = 溢出量的一半 × PAN_SLACK：默认允许把图片
  // 边缘推过视口边界半程（留白便于把关注内容挪到视口中央），又不至于把图片
  // 整个拖丢。未超出视口时保留原有的自由拖动余量（布局尺寸的 200%），
  // 缩小后的小图仍可挪到一边对比。
  const overflowX = (img.clientWidth  * scale.value - wrap.clientWidth) / 2
  const overflowY = (img.clientHeight * scale.value - wrap.clientHeight) / 2
  const maxTx = overflowX > 0 ? overflowX * PAN_SLACK : img.clientWidth  * 0.5
  const maxTy = overflowY > 0 ? overflowY * PAN_SLACK : img.clientHeight * 0.5
  return { maxTx, maxTy }
}

function clamp() {
  const { maxTx, maxTy } = getBounds()
  tx.value = Math.max(-maxTx, Math.min(maxTx, tx.value))
  ty.value = Math.max(-maxTy, Math.min(maxTy, ty.value))
}

const pct = computed(() => Math.round(scale.value * 100))

function applyZoom(newScale: number) {
  hasUserZoom.value = true
  scale.value = Math.min(MAX_ZOOM, Math.max(0.05, newScale))
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
  hasUserZoom.value = true
  // 矢量图的“原始大小”只是浏览器折算的默认对象尺寸（如无尺寸 SVG 的
  // 300×150），重置回 100% 会缩回窗口中间一小块，因此回到适配视图；
  // 位图保持原有的 100% 语义。
  if (props.upscale) {
    fitToView(true)
    return
  }
  scale.value = 1
  tx.value = 0
  ty.value = 0
}

function fitToView(force = false) {
  if ((!force && hasUserZoom.value) || !wrapRef.value || !naturalWidth.value || !naturalHeight.value) return
  // 原图加载和浮动窗口尺寸调整不是同一帧完成的：首轮可能先按默认窗口计算，
  // 随后 ResizeObserver 再按最终窗口重算。所有自动适配都必须瞬时切换，不能
  // 把这次内部重算表现成“原图从缩略图大小放大到最终大小”的动画。
  const isAutomaticFit = !hasUserZoom.value
  if (isAutomaticFit) {
    disableTransition.value = true
  }
  const availableWidth = Math.max(1, wrapRef.value.clientWidth - PADDING * 2)
  const availableHeight = Math.max(1, wrapRef.value.clientHeight - PADDING * 2)
  // 适配只缩小不放大，防止位图拉伸发糊；矢量图（upscale）放大无损，
  // 允许放大到缩放上限以填满视口——无尺寸 SVG 的“natural”只是 300×150
  // 的折算值，封顶 1 会让它以小尺寸打开。
  scale.value = Math.min(
    props.upscale ? MAX_ZOOM : 1,
    availableWidth / naturalWidth.value,
    availableHeight / naturalHeight.value,
  )
  tx.value = 0
  ty.value = 0
  imageReady.value = true
  if (isAutomaticFit) {
    if (transitionRaf !== null) cancelAnimationFrame(transitionRaf)
    transitionRaf = requestAnimationFrame(() => {
      transitionRaf = null
      disableTransition.value = false
    })
  }
}

const emit = defineEmits(['loaded'])
function onLoad() {
  error.value = false
  const img = imgRef.value
  if (img) {
    naturalWidth.value = img.naturalWidth
    naturalHeight.value = img.naturalHeight
    fitToView()
  }
  emit('loaded')
}
function onError() { error.value = true }

watch(() => props.blobUrl, () => {
  // 切换文件时重新执行“打开即适配”；只有用户主动缩放/重置后才保留当前视图。
  hasUserZoom.value = false
  imageReady.value = false
  disableTransition.value = false
  naturalWidth.value = 0
  naturalHeight.value = 0
})

onMounted(() => {
  if (typeof ResizeObserver === 'undefined' || !wrapRef.value) return
  // 浮动窗口会在图片读取完成后异步调整尺寸；观察容器可以覆盖这段竞态，
  // 也同时处理最大化、手动 resize 和浏览器窗口变化。
  resizeObserver = new ResizeObserver(() => {
    // 用户已手动缩放时窗口变化不应重置视图，但平移钳制要按新视口重算，
    // 避免拖出去的内容在窗口变窄后 stranded 在不可达位置。
    if (hasUserZoom.value) clamp()
    else fitToView()
  })
  resizeObserver.observe(wrapRef.value)
})

onUnmounted(() => {
  window.removeEventListener('mousemove', onMouseMove)
  window.removeEventListener('mouseup', onMouseUp)
  if (transitionRaf !== null) cancelAnimationFrame(transitionRaf)
  resizeObserver?.disconnect()
  resizeObserver = null
})
</script>

<style scoped>
.iv-wrap {
  /* 亮色默认值保持原设计；暗色在本组件末尾重映射这些变量。
     toolbar 本身始终只有下面一套属性声明，不再维护亮/暗两份组件 CSS。 */
  --iv-toolbar-bg: rgba(255, 255, 255, 0.68);
  --iv-toolbar-filter: blur(18px);
  --iv-toolbar-border: rgba(255, 255, 255, 0.82);
  --iv-toolbar-shadow:
    0 4px 16px rgba(80, 90, 110, 0.10),
    inset 0 1px 0 rgba(255, 255, 255, 0.95),
    inset 1px 0 0 rgba(255, 255, 255, 0.55);
  --iv-toolbar-fg: var(--text-secondary);
  --iv-toolbar-hover-bg: rgba(123, 127, 178, 0.12);
  --iv-toolbar-hover-fg: var(--color-primary);
  --iv-toolbar-pct-hover-fg: var(--text-primary);

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
  display: block;
  flex: none;
  transform-origin: center;
  opacity: 0;
  transition: opacity 0.12s ease, transform 0.08s ease-out;
  border-radius: 6px;
  box-shadow: 0 4px 24px rgba(20,25,60,0.12);
}

.iv-img.iv-ready { opacity: 1; }
.iv-img.iv-no-transition { transition: none; }

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
  background: var(--iv-toolbar-bg);
  backdrop-filter: var(--iv-toolbar-filter);
  -webkit-backdrop-filter: var(--iv-toolbar-filter);
  border: 1px solid var(--iv-toolbar-border);
  border-radius: 20px;
  padding: 3px 5px;
  pointer-events: auto;
  box-shadow: var(--iv-toolbar-shadow);
}
.iv-tb-btn {
  width: 26px; height: 26px;
  border-radius: 50%; border: none;
  background: transparent; color: var(--iv-toolbar-fg);
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; transition: background 0.15s, color 0.15s;
}
.iv-tb-btn svg { display: block; }
.iv-tb-btn:hover {
  background: var(--iv-toolbar-hover-bg);
  color: var(--iv-toolbar-hover-fg);
}
.iv-tb-pct {
  font-size: 11px; font-weight: 600;
  color: var(--iv-toolbar-fg);
  min-width: 38px; text-align: center;
  cursor: pointer; letter-spacing: 0.02em;
  padding: 0 2px; transition: color 0.15s;
}
.iv-tb-pct:hover { color: var(--iv-toolbar-pct-hover-fg); }
</style>

<style>
/* 工具栏变量只在 ImageViewer 内消费，暗色映射也归还组件。 */
html[data-theme='dark'][data-family] .iv-wrap {
  --iv-toolbar-bg: color-mix(in srgb, var(--surface-floating) 90%, transparent);
  --iv-toolbar-filter: var(--popup-surface-blur);
  --iv-toolbar-border: var(--border-strong);
  --iv-toolbar-shadow: var(--elevation-popup), inset 0 1px 0 var(--modal-card-highlight);
  --iv-toolbar-fg: var(--content-secondary);
  --iv-toolbar-hover-bg: var(--option-bg-hover);
  --iv-toolbar-hover-fg: var(--action-primary);
  --iv-toolbar-pct-hover-fg: var(--content-primary);
}
</style>
