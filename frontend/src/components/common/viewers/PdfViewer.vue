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
        <span class="pv-scale-label">{{ Math.round(scale * 100) }}%</span>
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

// p → { width, height } in CSS px at scale=1 (with PDF_TO_CSS_UNITS applied)
const pageSizes  = ref({})
const canvasRefs = {}
const textRefs   = {}

const SUPERSAMPLE = 2   // 超采样倍率，canvas 渲染分辨率 = CSS 尺寸 × dpr × SUPERSAMPLE

let pdfDoc     = null
let renderTask = null
let pdfjsLib   = null
let CSS_UNITS  = 96 / 72  // PDF pt → CSS px，ensurePdfjs 后从库取精确值

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
  loading.value    = true
  error.value      = null
  totalPages.value = 0
  currentPage.value = 1
  renderedPages.value = new Set()
  pageSizes.value = {}

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

    // 预取页面 CSS 尺寸（含 DPI 校正，不含用户缩放）
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

// ── 渲染窗口（当前页 ±2 页）────────────────────────────
async function renderWindow() {
  if (!pdfDoc) return
  const from = Math.max(1, currentPage.value - 2)
  const to   = Math.min(totalPages.value, currentPage.value + 2)

  for (let p = from; p <= to; p++) {
    if (renderedPages.value.has(p)) continue
    renderedPages.value = new Set([...renderedPages.value, p])
    await nextTick()
    await renderPage(p)
  }
}

async function renderPage(p) {
  const canvas  = canvasRefs[p]
  const textDiv = textRefs[p]
  if (!canvas || !pdfDoc) return

  const page = await pdfDoc.getPage(p)

  const dpr = window.devicePixelRatio || 1

  // 物理像素 viewport（canvas 用，含超采样）
  const vpPhysical = page.getViewport({ scale: scale.value * CSS_UNITS * dpr * SUPERSAMPLE })
  // CSS 像素 viewport（text layer 用）
  const vpCSS = page.getViewport({ scale: scale.value * CSS_UNITS })

  // ── canvas ──
  canvas.width  = vpPhysical.width
  canvas.height = vpPhysical.height
  canvas.style.width  = vpCSS.width  + 'px'
  canvas.style.height = vpCSS.height + 'px'

  if (renderTask) renderTask.cancel()
  renderTask = page.render({
    canvasContext: canvas.getContext('2d'),
    viewport: vpPhysical,
    intent: 'display',
  })
  try { await renderTask.promise } catch { /* cancelled */ }

  // ── text layer ──
  if (!textDiv) return
  textDiv.innerHTML = ''
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

// ── 滚动时更新当前页 ───────────────────────────────────
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
      renderWindow()
      return
    }
    top += h
  }
}

// ── 缩放 ───────────────────────────────────────────────
async function applyScale(s) {
  scale.value = s
  renderedPages.value = new Set()
  await nextTick()
  await renderWindow()
}

async function changeScale(delta) {
  isFitWidth.value = false
  await applyScale(Math.min(4, Math.max(0.4, +(scale.value + delta).toFixed(1))))
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

// ── 页面占位尺寸（CSS px，含 DPI 校正 + 用户缩放）────────
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

/* ── 滚动区 ── */
.pv-scroll {
  flex: 1;
  overflow: auto;
  padding: 20px 24px;
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

.pv-canvas {
  display: block;
}

/* ── text layer ── */
.pv-text-layer {
  position: absolute;
  top: 0;
  left: 0;
  overflow: hidden;
  /* spans 是透明的，只用于文字选中 */
  line-height: 1;
  pointer-events: none;  /* 不拦截点击，只允许选中 */
}

/* PDF.js 动态插入的 span，不在 scoped 范围内，用 :deep */
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
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--text-secondary);
  font-size: 13px;
  min-height: calc(100vh - 200px);
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
