<template>
  <div class="pv-wrap">
    <!-- 工具栏 -->
    <div class="pv-toolbar">
      <div class="pv-tb-group">
        <button class="pv-btn" :disabled="currentPage <= 1" @click="goTo(currentPage - 1)">
          <PhCaretLeft weight="bold" :size="13" />
        </button>
        <input
          class="pv-page-input"
          type="number"
          :min="1"
          :max="totalPages"
          :value="currentPage"
          @change="onPageInput"
        />
        <span class="pv-page-sep">/</span>
        <span class="pv-page-total">{{ totalPages }}</span>
        <button class="pv-btn" :disabled="currentPage >= totalPages" @click="goTo(currentPage + 1)">
          <PhCaretRight weight="bold" :size="13" />
        </button>
      </div>

      <div class="pv-tb-group">
        <button class="pv-btn" @click="changeScale(-0.1)">
          <PhMinus weight="bold" :size="12" />
        </button>
        <button class="pv-scale-label pv-scale-reset" @click="resetScale" title="回到 100%">{{ Math.round(scale * 100) }}%</button>
        <button class="pv-btn" @click="changeScale(0.1)">
          <PhPlus weight="bold" :size="12" />
        </button>
        <button
          class="pv-btn"
          :class="{ 'pv-btn-active': isFitWidth }"
          :title="isFitWidth ? '恢复 100%' : '适宽'"
          @click="toggleFitWidth"
        >
          <PhArrowsHorizontal weight="bold" :size="13" />
        </button>
      </div>
    </div>

    <!-- 页面滚动区 -->
    <div ref="scrollRef" class="pv-scroll" @scroll="onScroll">
      <div v-if="loading && !totalPages" class="pv-status">
        <div class="pv-spinner" />
        <span>加载中…</span>
      </div>
      <div v-else-if="error" class="pv-status pv-error">
        <PhWarningCircle :size="32" style="opacity:.5" />
        <span>{{ error }}</span>
      </div>
      <div v-else class="pv-pages">
        <div
          v-for="p in totalPages"
          :key="p"
          class="pv-page-wrap"
          :style="pageWrapStyle(p)"
        >
          <template v-if="renderedPages.has(p)">
            <canvas :ref="el => setCanvasRef(el, p)" class="pv-canvas" />
            <div :ref="el => setTextRef(el, p)" class="pv-text-layer" />
          </template>
          <div v-else class="pv-page-placeholder" />
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, watch, onUnmounted, nextTick } from 'vue'
import { PhCaretLeft, PhCaretRight, PhMinus, PhPlus, PhArrowsHorizontal, PhWarningCircle } from '@phosphor-icons/vue'

const props = defineProps({
  blobUrl: { type: String, default: null },
})

// ── 状态 ──────────────────────────────────────────────
const loading       = ref(false)
const error         = ref(null)
const totalPages    = ref(0)
const currentPage   = ref(1)
const scale         = ref(1)
const scrollRef     = ref(null)
const renderedPages = ref(new Set())
const isFitWidth    = ref(false)

// p → { width, height } CSS px at scale=1
const pageSizes  = ref({})
const canvasRefs = {}
const textRefs   = {}

// 每页的渲染任务和状态
const renderTasks = {}   // p → PDF.js renderTask
const textRendered = {}  // p → cssScale（text layer 缓存标记）
const tileStates   = {}  // p → { top, bottom }（已渲染 tile 范围，page 内 CSS px）

let pdfDoc    = null
let pdfjsLib  = null
let CSS_UNITS = 96 / 72

// ── 加载 PDF.js ────────────────────────────────────────
async function ensurePdfjs() {
  if (pdfjsLib) return
  pdfjsLib = await import('pdfjs-dist')
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url,
  ).href
  CSS_UNITS = pdfjsLib.PixelsPerInch.PDF_TO_CSS_UNITS
}

// ── 加载文档 ───────────────────────────────────────────
async function loadPdf(url) {
  loading.value     = true
  error.value       = null
  totalPages.value  = 0
  currentPage.value = 1
  renderedPages.value = new Set()
  pageSizes.value   = {}
  Object.keys(tileStates).forEach(k => delete tileStates[k])
  Object.keys(textRendered).forEach(k => delete textRendered[k])

  try {
    await ensurePdfjs()
    if (pdfDoc) { pdfDoc.destroy(); pdfDoc = null }

    pdfDoc = await pdfjsLib.getDocument({
      url,
      cMapUrl: '/pdf-assets/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: '/pdf-assets/standard_fonts/',
    }).promise
    totalPages.value = pdfDoc.numPages

    for (let i = 1; i <= pdfDoc.numPages; i++) {
      const page = await pdfDoc.getPage(i)
      const vp = page.getViewport({ scale: CSS_UNITS })
      pageSizes.value[i] = { width: vp.width, height: vp.height }
    }

    await nextTick()
    await renderWindow()
  } catch (e) {
    error.value = 'PDF 加载失败：' + e.message
  } finally {
    loading.value = false
  }
}

watch(() => props.blobUrl, url => {
  if (url) loadPdf(url)
}, { immediate: true })

// ── 页面 Y 坐标（scroll-area CSS px）─────────────────
function getPageTop(p) {
  let top = 0
  for (let i = 1; i < p; i++) {
    const sz = pageSizes.value[i]
    if (sz) top += sz.height * scale.value + 16
  }
  return top
}

// ── Tile 渲染（核心）──────────────────────────────────
// canvas 只渲染可见区域 ± BUFFER，canvas 尺寸 ≈ 视口大小，与缩放无关
const TILE_BUFFER = 400  // CSS px，上下各留 400px 缓冲防闪烁

async function renderPage(p) {
  const canvas  = canvasRefs[p]
  const textDiv = textRefs[p]
  if (!canvas || !pdfDoc) return

  const page = await pdfDoc.getPage(p)
  const dpr      = window.devicePixelRatio || 1
  const cssScale = scale.value * CSS_UNITS
  const physScale = cssScale * dpr  // 1x retina，canvas 尺寸 ≈ 屏幕像素

  const pageSz = pageSizes.value[p]
  if (!pageSz) return
  const pageCSSW = pageSz.width  * scale.value
  const pageCSSH = pageSz.height * scale.value

  // 计算可见 tile（page 内部坐标，CSS px）
  const scrollEl  = scrollRef.value
  const scrollTop = scrollEl ? scrollEl.scrollTop : 0
  const viewportH = scrollEl ? scrollEl.clientHeight : pageCSSH
  const pageTop   = getPageTop(p)

  const tileTop    = Math.max(0,        scrollTop - TILE_BUFFER - pageTop)
  const tileBottom = Math.min(pageCSSH, scrollTop + viewportH + TILE_BUFFER - pageTop)

  if (tileBottom <= tileTop) return  // 该页完全不可见

  const tileH = tileBottom - tileTop
  const tileW = pageCSSW

  // PDF.js viewport：将渲染原点偏移到 tileTop，使 tile 顶部 = canvas 顶部
  const fullVp = page.getViewport({ scale: physScale })
  const mat    = fullVp.transform.slice()
  mat[5] -= tileTop * dpr  // 向上平移 tileTop 个物理像素

  const tileVp = page.getViewport({ scale: physScale, transform: mat })

  // Canvas 大小 = tile 的物理像素，定位在 page-wrap 内 tileTop 处
  canvas.width  = Math.ceil(tileW * dpr)
  canvas.height = Math.ceil(tileH * dpr)
  canvas.style.width    = tileW + 'px'
  canvas.style.height   = tileH + 'px'
  canvas.style.position = 'absolute'
  canvas.style.top      = tileTop + 'px'
  canvas.style.left     = '0'

  // 取消同页上一次渲染
  if (renderTasks[p]) { renderTasks[p].cancel(); delete renderTasks[p] }

  const task = page.render({
    canvasContext: canvas.getContext('2d'),
    viewport: tileVp,
    intent: 'display',
  })
  renderTasks[p] = task
  try {
    await task.promise
    tileStates[p] = { top: tileTop, bottom: tileBottom }
  } catch { /* cancelled */ }
  delete renderTasks[p]

  // Text layer：整页渲染一次，按 cssScale 缓存，不随滚动重渲
  if (!textDiv || textRendered[p] === cssScale) return
  textRendered[p] = cssScale
  textDiv.innerHTML = ''
  const vpCSS = page.getViewport({ scale: cssScale })
  textDiv.style.width  = vpCSS.width  + 'px'
  textDiv.style.height = vpCSS.height + 'px'
  try {
    const textLayer = new pdfjsLib.TextLayer({
      textContentSource: page.streamTextContent(),
      container: textDiv,
      viewport: vpCSS,
    })
    await textLayer.render()
  } catch { /* cancelled or unsupported */ }
}

// ── 初始化/缩放后渲染当前页 ±1 页 ──────────────────
async function renderWindow() {
  if (!pdfDoc) return
  const from = Math.max(1, currentPage.value - 1)
  const to   = Math.min(totalPages.value, currentPage.value + 1)

  for (let p = from; p <= to; p++) {
    if (!renderedPages.value.has(p)) {
      renderedPages.value = new Set([...renderedPages.value, p])
      await nextTick()
    }
    await renderPage(p)
  }
}

// ── 滚动时按需重渲 tile（debounce 80ms）────────────
let tileTimer = null
function scheduleTileRender() {
  clearTimeout(tileTimer)
  tileTimer = setTimeout(async () => {
    if (!scrollRef.value) return
    const scrollTop = scrollRef.value.scrollTop
    const viewportH = scrollRef.value.clientHeight
    const from = Math.max(1, currentPage.value - 1)
    const to   = Math.min(totalPages.value, currentPage.value + 1)

    for (let p = from; p <= to; p++) {
      if (!renderedPages.value.has(p)) continue
      const state = tileStates[p]
      if (state) {
        const pageTop   = getPageTop(p)
        const visTop    = scrollTop - pageTop
        const visBottom = scrollTop + viewportH - pageTop
        // 可见区域仍在已渲染 tile 内，跳过
        if (visTop >= state.top && visBottom <= state.bottom) continue
      }
      await renderPage(p)
    }
  }, 80)
}

// ── 翻页 ───────────────────────────────────────────────
let scrollLockTimer = null

function goTo(p) {
  p = Math.max(1, Math.min(totalPages.value, p))
  currentPage.value = p
  clearTimeout(scrollLockTimer)
  scrollLockTimer = setTimeout(() => { scrollLockTimer = null }, 600)
  scrollToPage(p)
  renderWindow()
}

function onPageInput(e) {
  const v = parseInt(e.target.value)
  if (!isNaN(v)) goTo(v)
}

function scrollToPage(p) {
  const el = scrollRef.value
  if (!el) return
  let top = 0
  for (let i = 1; i < p; i++) {
    const sz = pageSizes.value[i]
    if (sz) top += sz.height * scale.value + 16
  }
  el.scrollTo({ top, behavior: 'smooth' })
}

// ── 滚动事件 ───────────────────────────────────────────
function onScroll() {
  if (scrollLockTimer) return
  const el = scrollRef.value
  if (!el) return
  let top = 0
  for (let p = 1; p <= totalPages.value; p++) {
    const sz = pageSizes.value[p]
    if (!sz) continue
    const h = sz.height * scale.value + 16
    if (top + h > el.scrollTop + 80) {
      currentPage.value = p
      scheduleTileRender()
      return
    }
    top += h
  }
}

// ── 缩放 ───────────────────────────────────────────────
async function applyScale(s) {
  const el = scrollRef.value
  let fraction = 0
  if (el && el.scrollHeight > el.clientHeight) {
    fraction = Math.min(1, (el.scrollTop + el.clientHeight / 2) / el.scrollHeight)
  }

  scale.value = s
  renderedPages.value = new Set()
  Object.keys(tileStates).forEach(k => delete tileStates[k])
  Object.keys(textRendered).forEach(k => delete textRendered[k])
  await nextTick()

  if (el && fraction > 0) {
    el.scrollTop = fraction * el.scrollHeight - el.clientHeight / 2
  }

  await renderWindow()
}

async function changeScale(delta) {
  isFitWidth.value = false
  await applyScale(Math.min(4, Math.max(0.4, +(scale.value + delta).toFixed(1))))
}

async function resetScale() {
  isFitWidth.value = false
  await applyScale(1)
}

async function fitWidth() {
  const el = scrollRef.value
  if (!el || !pageSizes.value[1]) return
  const s = +((el.clientWidth - 48) / pageSizes.value[1].width).toFixed(2)
  await applyScale(s)
}

async function toggleFitWidth() {
  if (isFitWidth.value) {
    isFitWidth.value = false
    await applyScale(1)
  } else {
    isFitWidth.value = true
    await fitWidth()
  }
}

// ── 占位尺寸 ──────────────────────────────────────────
function pageWrapStyle(p) {
  const sz = pageSizes.value[p]
  if (!sz) return {}
  return {
    width:  sz.width  * scale.value + 'px',
    height: sz.height * scale.value + 'px',
  }
}

// ── ref 收集 ──────────────────────────────────────────
function setCanvasRef(el, p) {
  if (el) canvasRefs[p] = el
  else    delete canvasRefs[p]
}

function setTextRef(el, p) {
  if (el) textRefs[p] = el
  else    delete textRefs[p]
}

onUnmounted(() => {
  if (pdfDoc) pdfDoc.destroy()
  clearTimeout(scrollLockTimer)
  clearTimeout(tileTimer)
})
</script>

<style scoped>
.pv-wrap {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  background: rgba(228, 230, 238, 0.6);
}

/* ── 工具栏 ── */
.pv-toolbar {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 16px;
  padding: 8px 16px;
  background: rgba(255, 255, 255, 0.7);
  border-bottom: 1px solid rgba(0, 0, 0, 0.07);
  flex-shrink: 0;
}

.pv-tb-group {
  display: flex;
  align-items: center;
  gap: 4px;
}

.pv-btn {
  width: 26px;
  height: 26px;
  border-radius: 6px;
  border: none;
  background: rgba(255, 255, 255, 0.7);
  color: var(--text-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06);
}
.pv-btn svg { display: block; }
.pv-btn:hover:not(:disabled) { background: rgba(255, 255, 255, 0.95); color: var(--text-primary); }
.pv-btn:disabled { opacity: 0.35; cursor: default; }
.pv-btn-active { background: rgba(100, 110, 200, 0.12); color: var(--text-primary); }

.pv-page-input {
  width: 36px;
  height: 26px;
  border-radius: 6px;
  border: 1px solid rgba(0, 0, 0, 0.1);
  background: rgba(255, 255, 255, 0.8);
  text-align: center;
  font-size: 12px;
  color: var(--text-primary);
  outline: none;
}
.pv-page-input::-webkit-inner-spin-button { display: none; }

.pv-page-sep,
.pv-page-total,
.pv-scale-label {
  font-size: 12px;
  color: var(--text-secondary);
  min-width: 20px;
  text-align: center;
}
.pv-scale-reset {
  border: none; background: none; cursor: pointer;
  padding: 2px 5px; border-radius: 4px;
  transition: background 0.12s, color 0.12s;
}
.pv-scale-reset:hover { background: rgba(0,0,0,0.06); color: var(--text-primary); }

/* ── 滚动区 ── */
.pv-scroll {
  flex: 1;
  overflow: auto;
  padding: 20px 24px;
  position: relative;
}

.pv-pages {
  display: flex;
  flex-direction: column;
  gap: 16px;
  align-items: center;
  margin: 0 auto;
  width: fit-content;
  min-width: 100%;
}

.pv-page-wrap {
  position: relative;
  background: white;
  border-radius: 10px;
  box-shadow: 0 2px 16px rgba(20, 25, 60, 0.12);
  clip-path: inset(0 round 10px);
  flex-shrink: 0;
}

.pv-page-placeholder {
  width: 100%;
  height: 100%;
  background: rgba(240, 241, 246, 0.8);
}

/* canvas 绝对定位在 page-wrap 内，只覆盖可见 tile */
.pv-canvas {
  display: block;
  position: absolute;
  top: 0;
  left: 0;
}

/* ── text layer ── */
.pv-text-layer {
  position: absolute;
  top: 0;
  left: 0;
  overflow: hidden;
  line-height: 1;
  pointer-events: none;
}

.pv-text-layer :deep(span) {
  color: transparent;
  position: absolute;
  white-space: pre;
  cursor: text;
  transform-origin: 0% 0%;
  pointer-events: auto;
}

.pv-text-layer :deep(span::selection) {
  background: rgba(70, 130, 220, 0.25);
  color: transparent;
}

/* ── 状态 ── */
.pv-status {
  position: absolute; inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--text-secondary);
  font-size: 13px;
}
.pv-error { color: rgba(180, 80, 80, 0.8); }
.pv-spinner {
  width: 26px; height: 26px; border-radius: 50%;
  border: 2px solid rgba(123, 127, 178, 0.2);
  border-top-color: rgba(123, 127, 178, 0.7);
  animation: pv-spin 0.7s linear infinite;
}
@keyframes pv-spin { to { transform: rotate(360deg); } }
</style>
