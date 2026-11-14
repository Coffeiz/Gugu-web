<template>
  <div class="office-viewer-root" :class="{ 'pptx-zooming': pptxZooming }">
    <ViewerToolbar
      v-if="pptxSlideCount"
      :ariaLabel="t('viewerUi.pptxToolbar')"
      :page="pptxSlideIndex"
      :page-count="pptxSlideCount"
      :zoom-percent="pptxZoom"
      :show-fit="true"
      :fit-active="pptxFitMode === 'contain'"
      fit-icon="action.expand-horizontal"
      :previous-page-label="t('viewerUi.previousPage')"
      :next-page-label="t('viewerUi.nextPage')"
      :page-jump-label="t('viewerUi.pageJump')"
      :zoom-out-label="t('viewerUi.zoomOut')"
      :reset-zoom-label="t('viewerUi.resetZoom')"
      :zoom-in-label="t('viewerUi.zoomIn')"
      :fit-label="t('viewerUi.pptxFit')"
      @previous-page="changePptxSlide(-1)"
      @next-page="changePptxSlide(1)"
      @go-to-page="goToPptxPage"
      @zoom-out="changePptxZoom(-10)"
      @reset-zoom="resetPptxZoom"
      @zoom-in="changePptxZoom(10)"
      @fit="fitPptx"
    />
    <div ref="scrollContainerRef" class="office-container" :class="{ 'pptx-fit-mode': pptxFitMode === 'contain' }">
      <div ref="pptxContainerRef" class="pptx-render-surface"></div>
    </div>
    <div v-if="notice" class="office-notice" role="note">{{ notice }}</div>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { PptxViewer } from '@aiden0z/pptx-renderer'
import ViewerToolbar from '../ViewerToolbar.vue'
import { normalizePptxRoundRectAdjustments } from './pptxCompatibility'

const props = defineProps<{ blobUrl?: string; ext: string; fileId?: number; fileVersion?: number }>()
const emit = defineEmits<{ (e: 'content-size', width: number, height: number): void }>()
const { t } = useI18n()
const pptxContainerRef = ref<HTMLDivElement | null>(null)
const scrollContainerRef = ref<HTMLDivElement | null>(null)
const notice = ref('')
const pptxSlideIndex = ref(0)
const pptxSlideCount = ref(0)
const pptxZoom = ref(100)
const pptxFitMode = ref<'contain' | 'none'>('contain')
const pptxZooming = ref(false)
const pptxNavigationTarget = ref<number | null>(null)
let pptxViewer: PptxViewer | null = null
let pptxNavigationReleaseTimer: ReturnType<typeof setTimeout> | null = null
let renderSequence = 0

async function fetchBuffer(): Promise<ArrayBuffer> {
  const res = await fetch(props.blobUrl)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.arrayBuffer()
}

const onPptxSlideChange = (event: CustomEvent<{ index: number }>) => {
  // 列表模式的平滑滚动会在目标页事件前后短暂回报旧页。导航期间只接受
  // 当前目标页，避免工具栏出现「2 → 1 → 2」的闪回。
  if (pptxNavigationTarget.value !== null && event.detail.index !== pptxNavigationTarget.value) return
  pptxSlideIndex.value = event.detail.index
}

function releasePptxNavigationTarget() {
  if (pptxNavigationReleaseTimer) clearTimeout(pptxNavigationReleaseTimer)
  pptxNavigationReleaseTimer = setTimeout(() => {
    pptxNavigationTarget.value = null
    pptxNavigationReleaseTimer = null
  }, 500)
}
// PPTX 由渲染器监听容器宽度并自动重绘；这里只在首次打开时上报窗口的自然比例，
// 后续外部缩放由渲染器自己适配，避免再次触发窗口尺寸振荡。
async function renderPptx(buffer: ArrayBuffer, container: HTMLElement, scrollContainer: HTMLElement) {
  container.innerHTML = ''
  const [{ PptxViewer, RECOMMENDED_ZIP_LIMITS, parseZipLazyMedia, buildPresentation }, JSZipModule] = await Promise.all([
    import('@aiden0z/pptx-renderer'),
    import('jszip'),
  ])
  const zipLimits = RECOMMENDED_ZIP_LIMITS
  const files = await parseZipLazyMedia(buffer, zipLimits)
  const zip = await JSZipModule.default.loadAsync(buffer)

  // 部分演示文稿生成器将图片存到 ppt/slides/media/，并在 slide rels 中用
  // media/<文件名> 引用。渲染库按 OOXML 常见布局只查找 ppt/media/，因此
  // 将这些资源补入标准查找路径，避免显示 “Image not found”。
  const slideMediaPrefix = 'ppt/slides/media/'
  const slideMediaEntries = Object.values(zip.files).filter(file => !file.dir && file.name.startsWith(slideMediaPrefix))
  await Promise.all(slideMediaEntries.map(async file => {
    const fileName = file.name.slice(slideMediaPrefix.length)
    const canonicalPath = `ppt/media/${fileName}`
    if (!files.media.has(canonicalPath)) {
      files.media.set(canonicalPath, await file.async('uint8array'))
    }
  }))

  normalizePptxRoundRectAdjustments([files.slides, files.slideLayouts, files.slideMasters])

  pptxViewer = new PptxViewer(container, {
    fitMode: 'contain',
    scrollContainer,
    zipLimits,
    lazyMedia: true,
    lazySlides: true,
  })
  pptxViewer.load(buildPresentation(files, { lazySlides: true }))
  await pptxViewer.renderList({ windowed: true, initialSlides: 4, batchSize: 4 })
  pptxViewer.on('slidechange', onPptxSlideChange)
  pptxSlideCount.value = pptxViewer.slideCount
  pptxSlideIndex.value = pptxViewer.currentSlideIndex
  pptxZoom.value = pptxViewer.zoomPercent
  pptxFitMode.value = pptxViewer.fitMode
  // 窗口高度按第一页适配（其余页由同一滚动容器承载），宽度留出内边距余量。
  const width = container.clientWidth || Math.max(480, Math.min(Math.round(window.innerWidth * 0.72) - 16, 1200))
  const ratio = pptxViewer.slideHeight > 0 && pptxViewer.slideWidth > 0
    ? pptxViewer.slideHeight / pptxViewer.slideWidth
    : 9 / 16
  emit('content-size', width + 24, Math.round(width * ratio) + 24)
}

async function changePptxSlide(delta: number) {
  if (!pptxViewer) return
  const baseIndex = pptxNavigationTarget.value ?? pptxSlideIndex.value
  const targetIndex = Math.max(0, Math.min(pptxSlideCount.value - 1, baseIndex + delta))
  if (targetIndex === baseIndex) return
  pptxNavigationTarget.value = targetIndex
  pptxSlideIndex.value = targetIndex
  await pptxViewer.goToSlide(targetIndex)
  releasePptxNavigationTarget()
}

async function goToPptxPage(index: number) {
  if (!pptxViewer || index < 0 || index >= pptxSlideCount.value) return
  pptxNavigationTarget.value = index
  pptxSlideIndex.value = index
  await pptxViewer.goToSlide(index)
  releasePptxNavigationTarget()
}

function currentPptxDisplayZoom() {
  if (!pptxViewer || pptxViewer.slideWidth <= 0) return pptxZoom.value
  if (pptxFitMode.value !== 'contain') return pptxZoom.value
  const containerWidth = pptxContainerRef.value?.clientWidth ?? 0
  if (containerWidth <= 0) return pptxZoom.value
  // contain 的 100% 是「适配容器」，切到 none 后必须把这个实际比例带过去，
  // 否则放大/缩小会从幻灯片原始 100% 重新开始，视觉上突然跳变。
  return (containerWidth / pptxViewer.slideWidth) * 100 * (pptxZoom.value / 100)
}

async function centerPptxSlide(scrollContainer: HTMLElement, slideIndex: number) {
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  const slide = pptxContainerRef.value?.querySelector<HTMLElement>(`[data-slide-index="${slideIndex}"]`)
  if (!slide) return
  const viewport = scrollContainer.getBoundingClientRect()
  const page = slide.getBoundingClientRect()
  // 直接使用重绘后的页面矩形，消除多页列表和渲染面偏移带来的累计误差。
  scrollContainer.scrollLeft = Math.max(0, scrollContainer.scrollLeft + page.left + page.width / 2 - viewport.left - viewport.width / 2)
  scrollContainer.scrollTop = Math.max(0, scrollContainer.scrollTop + page.top + page.height / 2 - viewport.top - viewport.height / 2)
}

async function changePptxZoom(delta: number) {
  if (!pptxViewer) return
  const scrollContainer = pptxContainerRef.value?.parentElement
  const currentZoom = currentPptxDisplayZoom()
  const nextZoom = Math.max(25, Math.min(300, Math.round(currentZoom) + delta))
  pptxFitMode.value = 'none'
  pptxZoom.value = nextZoom
  pptxZooming.value = true
  try {
    await pptxViewer.setFitMode('none')
    await pptxViewer.setZoom(nextZoom)
    if (scrollContainer) await centerPptxSlide(scrollContainer, pptxViewer.currentSlideIndex)
  } finally {
    pptxZooming.value = false
  }
}

async function resetPptxZoom() {
  if (!pptxViewer) return
  const scrollContainer = pptxContainerRef.value?.parentElement
  const currentSlide = pptxViewer.currentSlideIndex
  pptxFitMode.value = 'none'
  pptxZoom.value = 100
  pptxZooming.value = true
  try {
    await pptxViewer.setFitMode('none')
    await pptxViewer.setZoom(100)
    // setZoom 会重建列表并把滚动位置清零，重建后无动画回到重置前的当前页。
    await pptxViewer.goToSlide(currentSlide, { behavior: 'auto', block: 'center' })
    if (scrollContainer) await centerPptxSlide(scrollContainer, currentSlide)
  } finally {
    pptxZooming.value = false
  }
}

async function fitPptx() {
  if (!pptxViewer) return
  const scrollContainer = pptxContainerRef.value?.parentElement
  const currentSlide = pptxViewer.currentSlideIndex
  pptxFitMode.value = 'contain'
  pptxZoom.value = 100
  pptxZooming.value = true
  try {
    await pptxViewer.setZoom(100)
    await pptxViewer.setFitMode('contain')
    // 适配会重建列表，滚动观察器可能把旧滚动位置误判为下一页；
    // 以点击前的页码为准，使用无动画定位恢复当前页。
    await pptxViewer.goToSlide(currentSlide, { behavior: 'auto', block: 'center' })
    if (scrollContainer) await centerPptxSlide(scrollContainer, currentSlide)
  } finally {
    pptxZooming.value = false
  }
}
async function render() {
  const sequence = ++renderSequence
  const container = pptxContainerRef.value
  if (!container) return
  destroyViewer()
  notice.value = ''
  pptxSlideIndex.value = 0
  pptxSlideCount.value = 0
  pptxNavigationTarget.value = null
  pptxZoom.value = 100
  pptxFitMode.value = 'contain'
  pptxZooming.value = false
  container.replaceChildren()
  try {
    await renderPptx(await fetchBuffer(), container, scrollContainerRef.value ?? container)
  } catch (cause) {
    if (sequence !== renderSequence) return
    console.warn('[office-viewer] PPTX render failed', cause)
    notice.value = t('files.officeRenderFailed')
  }
}

function destroyViewer() {
  pptxViewer?.off('slidechange', onPptxSlideChange)
  pptxViewer?.destroy()
  pptxViewer = null
  if (pptxNavigationReleaseTimer) clearTimeout(pptxNavigationReleaseTimer)
  pptxNavigationReleaseTimer = null
}

watch(() => [props.blobUrl, props.ext] as const, () => { void render() })
onMounted(() => { void render() })
onBeforeUnmount(() => {
  renderSequence++
  destroyViewer()
  pptxNavigationTarget.value = null
  pptxContainerRef.value?.replaceChildren()
})
</script>

<style scoped>
.office-viewer-root { position: relative; display: flex; flex-direction: column; height: 100%; min-height: 0; }
.office-container { flex: 1; min-height: 0; overflow: auto; padding: 12px; background: var(--surface-card-solid, var(--bg-primary)); }
.pptx-render-surface { width: 96%; min-height: 100%; margin-inline: auto; box-sizing: border-box; }
.office-viewer-root.pptx-zooming .pptx-render-surface { visibility: hidden; }
.office-container :deep([data-slide-index] > div) { background: transparent !important; margin-inline: auto; }
.office-container :deep([data-slide-index]), .office-container :deep([data-slide-index] svg), .office-container :deep([data-slide-index] img) { user-select: none; }
.office-container :deep([data-slide-index] svg), .office-container :deep([data-slide-index] img) { -webkit-user-drag: none; }
.office-notice { padding: 11px 14px; border-top: 1px solid var(--panel-glass-border); color: var(--content-secondary); font-size: 12px; }
</style>
