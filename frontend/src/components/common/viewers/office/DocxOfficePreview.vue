<template>
  <div class="office-viewer-root">
    <ViewerToolbar
      :ariaLabel="t('viewerUi.docxToolbar')"
      :page="docxPageIndex"
      :page-count="docxPageCount"
      :zoom-percent="docxScale * 100"
      :mode-options="[
        { value: 'fit-width', label: t('viewerUi.docxFitWidth'), icon: 'action.expand-horizontal', active: docxViewMode === 'fit-width' },
        { value: 'fit-page', label: t('viewerUi.docxFitPage'), icon: 'action.expand', active: docxViewMode === 'fit-page' },
      ]"
      :previous-page-label="t('viewerUi.previousPage')"
      :next-page-label="t('viewerUi.nextPage')"
      :page-jump-label="t('viewerUi.pageJump')"
      :zoom-out-label="t('viewerUi.zoomOut')"
      :reset-zoom-label="t('viewerUi.resetZoom')"
      :zoom-in-label="t('viewerUi.zoomIn')"
      @mode="onDocxModeChange"
      @previous-page="changeDocxPage(-1)"
      @next-page="changeDocxPage(1)"
      @go-to-page="goToDocxPage"
      @zoom-out="changeDocxScale(-0.1)"
      @reset-zoom="setDocxModeActual"
      @zoom-in="changeDocxScale(0.1)"
    />
    <div class="office-container">
      <div ref="containerRef" class="office-content-surface"></div>
    </div>
    <div v-if="notice" class="office-notice" role="note">{{ notice }}</div>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import ViewerToolbar from '../ViewerToolbar.vue'

const props = defineProps<{ blobUrl?: string; ext: string; fileId?: number; fileVersion?: number }>()
const { t } = useI18n()
const containerRef = ref<HTMLDivElement | null>(null)
const notice = ref('')
const DOCX_VIEW_MODE_KEY = 'gugu-docx-view-mode'
type DocxViewMode = 'fit-width' | 'fit-page' | 'actual'

function readDocxViewMode(): DocxViewMode {
  try {
    const value = localStorage.getItem(DOCX_VIEW_MODE_KEY)
    return value === 'fit-width' || value === 'fit-page' ? value : 'fit-page'
  } catch {
    return 'fit-page'
  }
}

const docxViewMode = ref<DocxViewMode>(readDocxViewMode())
const docxScale = ref(1)
const docxPageIndex = ref(0)
const docxPageCount = ref(0)
let docxViewRequest = 0
let docxPageScrollRoot: HTMLElement | null = null
let docxPageScrollHandler: (() => void) | null = null
let resizeObserver: ResizeObserver | null = null

async function fetchBuffer(): Promise<ArrayBuffer> {
  const res = await fetch(props.blobUrl)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.arrayBuffer()
}

async function renderDocx(buffer: ArrayBuffer, container: HTMLElement) {
  const old = container.querySelector('.docx-wrapper')
  if (old) old.remove()
  const { renderAsync } = await import('docx-preview')
  await renderAsync(buffer, container, undefined, {
    inWrapper: true,
    ignoreFonts: false,
    // 保留 Word 写入的分页标记，避免多页文档被拼成一个连续页面。
    ignoreLastRenderedPageBreak: false,
    breakPages: true,
    experimental: false,
  })
  normalizeDocxBullets(container)
  paginateDocx(container)
  await nextTick()
  bindDocxPageTracking(container)
  scheduleDocxView()
}

// Word 默认项目符号使用 Symbol 字体的 U+F0B7；浏览器缺少该字体时会显示成方框。
// Word 内置项目符号样式只替换项目符号，不影响数字编号。
function normalizeDocxBullets(container: HTMLElement) {
  const wrapper = container.querySelector<HTMLElement>('.docx-wrapper')
  if (!wrapper) return

  for (const paragraph of wrapper.querySelectorAll<HTMLElement>(
    'p.docx_00002c, p.docx_00002e, p.docx_000030',
  )) {
    paragraph.classList.add('docx-bullet-normalized')
  }
}

// docx-preview 只处理 DOCX 中的显式分页标记，不会模拟 Word 根据纸张高度
// 自动分页。对没有分页标记、但内容超过纸张高度的文档，按顶层块元素拆成多张纸。
function paginateDocx(container: HTMLElement) {
  const wrapper = container.querySelector<HTMLElement>('.docx-wrapper')
  if (!wrapper) return

  const pages = Array.from(wrapper.querySelectorAll<HTMLElement>(':scope > section.docx'))
  const generatedPages: HTMLElement[] = []
  for (const page of pages) {
    const sourceArticles = Array.from(page.children)
      .filter((child): child is HTMLElement => child instanceof HTMLElement && child.matches('article'))
    if (!sourceArticles.length) {
      generatedPages.push(page)
      continue
    }

    // docx-preview 会把相同纸张尺寸的连续 section 合并到一个 section.docx，
    // 但每个原始 section 仍对应一个 article。先恢复这层分页边界。
    for (const sourceArticle of sourceArticles) {
      const sectionPage = page.cloneNode(false) as HTMLElement
      for (const child of Array.from(page.children)) {
        if (child !== sourceArticle && !child.matches('article')) {
          sectionPage.appendChild(child.cloneNode(true))
        }
      }
      const article = sourceArticle.cloneNode(true) as HTMLElement
      sectionPage.appendChild(article)
      // cloneNode 创建的页面尚未参与布局，必须先挂回 wrapper 才能测量真实纸张高度。
      wrapper.appendChild(sectionPage)

      const blocks = Array.from(article.children) as HTMLElement[]
      if (blocks.length < 2) {
        generatedPages.push(sectionPage)
        continue
      }

      const pageStyle = getComputedStyle(sectionPage)
      const pageHeight = parseFloat(pageStyle.minHeight) || sectionPage.getBoundingClientRect().height
      const paddingTop = parseFloat(pageStyle.paddingTop) || 0
      const paddingBottom = parseFloat(pageStyle.paddingBottom) || 0
      const contentHeight = pageHeight - paddingTop - paddingBottom
      if (contentHeight <= 0) {
        generatedPages.push(sectionPage)
        continue
      }

      const articleRect = article.getBoundingClientRect()
      const blockPositions = blocks.map((block) => {
        const rect = block.getBoundingClientRect()
        return { block, top: rect.top - articleRect.top, height: rect.height }
      })
      const last = blockPositions.at(-1)
      if (!last || last.top + last.height <= contentHeight + 1) {
        generatedPages.push(sectionPage)
        continue
      }

      const pageBlocks: HTMLElement[][] = [[]]
      let pageStart = blockPositions[0]?.top ?? 0
      for (const position of blockPositions) {
        const current = pageBlocks.at(-1)!
        if (current.length && position.top - pageStart + position.height > contentHeight) {
          pageBlocks.push([])
          pageStart = position.top
        }
        pageBlocks.at(-1)!.push(position.block)
      }

      for (const [index, currentBlocks] of pageBlocks.entries()) {
        const nextPage = index === 0
          ? sectionPage
          : (sectionPage.cloneNode(false) as HTMLElement)
        const nextArticle = index === 0
          ? article
          : (article.cloneNode(false) as HTMLElement)
        if (index > 0) {
          for (const child of Array.from(sectionPage.children)) {
            if (child === article) nextPage.appendChild(nextArticle)
            else nextPage.appendChild(child.cloneNode(true))
          }
        }
        for (const block of currentBlocks) nextArticle.appendChild(block)
        generatedPages.push(nextPage)
      }
    }
  }

  wrapper.replaceChildren(...generatedPages)
  docxPageCount.value = generatedPages.length
  docxPageIndex.value = 0
}

function updateDocxPage() {
  const root = docxPageScrollRoot
  const wrapper = containerRef.value?.querySelector<HTMLElement>('.docx-wrapper')
  if (!root || !wrapper || docxPageCount.value <= 0) return
  const rootRect = root.getBoundingClientRect()
  const viewportCenter = rootRect.top + rootRect.height / 2
  let closestIndex = 0
  let closestDistance = Number.POSITIVE_INFINITY
  for (const [index, page] of Array.from(wrapper.querySelectorAll<HTMLElement>(':scope > section.docx')).entries()) {
    const rect = page.getBoundingClientRect()
    const distance = Math.abs(rect.top + rect.height / 2 - viewportCenter)
    if (distance < closestDistance) {
      closestDistance = distance
      closestIndex = index
    }
  }
  docxPageIndex.value = closestIndex
}

function bindDocxPageTracking(container: HTMLElement) {
  if (docxPageScrollRoot && docxPageScrollHandler) {
    docxPageScrollRoot.removeEventListener('scroll', docxPageScrollHandler)
  }
  docxPageScrollRoot = container.parentElement
  docxPageScrollHandler = updateDocxPage
  docxPageScrollRoot?.addEventListener('scroll', docxPageScrollHandler, { passive: true })
  updateDocxPage()
}

function changeDocxPage(delta: number) {
  const root = docxPageScrollRoot
  const wrapper = containerRef.value?.querySelector<HTMLElement>('.docx-wrapper')
  if (!root || !wrapper || docxPageCount.value <= 0) return
  const nextIndex = Math.max(0, Math.min(docxPageCount.value - 1, docxPageIndex.value + delta))
  const page = wrapper.querySelectorAll<HTMLElement>(':scope > section.docx')[nextIndex]
  if (!page) return
  const rootRect = root.getBoundingClientRect()
  const pageRect = page.getBoundingClientRect()
  root.scrollTop += pageRect.top - rootRect.top - 8
  docxPageIndex.value = nextIndex
}

function goToDocxPage(index: number) {
  changeDocxPage(index - docxPageIndex.value)
}

// docx-preview 按 A4 固定宽渲染，浮动窗比纸窄时会左右溢出叠成"两层"；
// 按容器宽度对整叠纸做 zoom 缩放（zoom 影响布局盒，不会留下空白滚动区）。
function clampDocxScale(scale: number) {
  // 0.1% 精度对应缩放比例的 0.001。
  return Math.min(2, Math.max(0.25, Math.round(scale * 1000) / 1000))
}

function getDocxLayoutSize(section: HTMLElement) {
  const article = section.querySelector<HTMLElement>(':scope > article')
  const articleBottom = article
    ? article.offsetTop + article.scrollHeight
    : 0
  const contentBottom = Array.from(section.children).reduce((max, child) => (
    child instanceof HTMLElement ? Math.max(max, child.offsetTop + child.scrollHeight) : max
  ), 0)
  const style = getComputedStyle(section)
  const declaredWidth = Number.parseFloat(section.style.width) || Number.parseFloat(style.width) || 0
  const declaredHeight = Number.parseFloat(section.style.minHeight) || Number.parseFloat(style.minHeight) || 0
  const measuredHeight = Math.max(section.offsetHeight, section.clientHeight, section.scrollHeight, articleBottom, contentBottom)
  return {
    // docx-preview 用 width/min-height 保存 Word 的原始纸张尺寸；offsetHeight
    // 可能已经被滚动容器裁剪，不能作为唯一的整页测量来源。
    width: Math.max(declaredWidth, section.offsetWidth, section.clientWidth, section.scrollWidth),
    height: Math.max(declaredHeight, measuredHeight),
  }
}

function applyDocxView(container: HTMLElement) {
  const wrapper = container.querySelector<HTMLElement>(".docx-wrapper")
  const section = wrapper?.querySelector<HTMLElement>("section.docx")
  if (!wrapper || !section) return
  wrapper.style.zoom = "1"
  // 适配不修改 DOCX 纸张盒子，只读取布局尺寸。正文 article 可能溢出纸张
  // 盒子，必须纳入测量，否则宽窗口下会错误地按宽度放大并截掉底部内容。
  const page = getDocxLayoutSize(section)
  const pageWidth = page.width
  const pageHeight = page.height
  if (pageWidth <= 0 || pageHeight <= 0) return
  // container 是会被 DOCX 内容撑高的 office-content-surface，不是可视窗口；
  // 必须用外层 office-container，否则页面越长，可用高度反而越大，整页会
  // 错误地保持在 94%/100%。
  const viewport = container.parentElement ?? container
  const viewportRect = viewport.getBoundingClientRect()
  const availableWidth = Math.max(1, viewport.clientWidth - 16)
  // 工具栏是悬浮层，不参与纸张布局。整页模式以预览器可视区域为基准，
  // 让纸张上下边界对齐可视区；宽度不足时再用宽度约束，保持纸张比例。
  // 16px 是纸页自身的顶部布局余量；还要扣除滚动容器的底部内边距，
  // 否则缩放结果会把纸页底部正好贴到视口边缘，底部间距只能靠滚动才能看到。
  const paddingBottom = Number.parseFloat(getComputedStyle(viewport).paddingBottom) || 0
  const availableHeight = Math.max(1, viewportRect.height - 16 - paddingBottom)
  const fitWidth = availableWidth / pageWidth
  const fitPage = Math.min(fitWidth, availableHeight / pageHeight)
  const scale = docxViewMode.value === 'fit-width'
    ? fitWidth
    : docxViewMode.value === 'fit-page'
      ? fitPage
      // 手动缩放时窗口变窄也不能让纸张横向溢出；只在空间不足时自动缩小，
      // 窗口变宽不自动放大，保留用户当前的缩放意图。
      : Math.min(docxScale.value, fitWidth)
  docxScale.value = clampDocxScale(scale)
  wrapper.style.zoom = String(docxScale.value)
}

type DocxZoomAnchor = { x: number; y: number }

function getDocxZoomAnchor(): DocxZoomAnchor | null {
  const viewport = docxPageScrollRoot
  if (!viewport || docxScale.value <= 0) return null
  return {
    x: (viewport.scrollLeft + viewport.clientWidth / 2) / docxScale.value,
    y: (viewport.scrollTop + viewport.clientHeight / 2) / docxScale.value,
  }
}

function setDocxViewMode(mode: 'fit-width' | 'fit-page' | 'actual') {
  const anchor = getDocxZoomAnchor()
  docxViewMode.value = mode
  if (mode === 'fit-width' || mode === 'fit-page') {
    try { localStorage.setItem(DOCX_VIEW_MODE_KEY, mode) } catch { /* 存储不可用时不影响预览 */ }
  }
  if (mode === 'actual') docxScale.value = 1
  scheduleDocxView(anchor)
}

function scheduleDocxView(anchor: DocxZoomAnchor | null = null) {
  const request = ++docxViewRequest
  requestAnimationFrame(() => {
    if (request !== docxViewRequest) return
    if (containerRef.value) {
      applyDocxView(containerRef.value)
      if (anchor && docxPageScrollRoot) {
        const viewport = docxPageScrollRoot
        viewport.scrollLeft = Math.max(0, anchor.x * docxScale.value - viewport.clientWidth / 2)
        viewport.scrollTop = Math.max(0, anchor.y * docxScale.value - viewport.clientHeight / 2)
      }
    }
  })
}

function onDocxModeChange(mode: string) {
  if (mode === 'fit-width' || mode === 'fit-page' || mode === 'actual') setDocxViewMode(mode)
}

function setDocxModeActual() {
  setDocxViewMode('actual')
}

function changeDocxScale(delta: number) {
  const anchor = getDocxZoomAnchor()
  docxViewMode.value = 'actual'
  const currentPercent = docxScale.value * 100
  const nextPercent = delta > 0
    ? Math.floor(currentPercent / 10 + 1) * 10
    : Math.ceil(currentPercent / 10 - 1) * 10
  docxScale.value = clampDocxScale(nextPercent / 100)
  scheduleDocxView(anchor)
}
async function render() {
  const container = containerRef.value
  if (!container) return
  const request = ++docxViewRequest
  docxPageCount.value = 0
  docxPageIndex.value = 0
  notice.value = ''
  container.replaceChildren()
  try {
    await renderDocx(await fetchBuffer(), container)
  } catch (cause) {
    if (request !== docxViewRequest) return
    console.warn('[office-viewer] DOCX render failed', cause)
    notice.value = t('files.officeRenderFailed')
  }
}

watch(() => [props.blobUrl, props.ext] as const, () => { void render() })
onMounted(() => {
  void render()
  const container = containerRef.value
  if (!container || typeof ResizeObserver === 'undefined') return
  resizeObserver = new ResizeObserver(() => scheduleDocxView())
  resizeObserver.observe(container)
})
onBeforeUnmount(() => {
  docxViewRequest++
  resizeObserver?.disconnect()
  resizeObserver = null
  if (docxPageScrollRoot && docxPageScrollHandler) {
    docxPageScrollRoot.removeEventListener('scroll', docxPageScrollHandler)
  }
  docxPageScrollRoot = null
  docxPageScrollHandler = null
  containerRef.value?.replaceChildren()
})
</script>

<style scoped>
.office-viewer-root { position: relative; display: flex; flex-direction: column; height: 100%; min-height: 0; }
.office-container { flex: 1; min-height: 0; overflow: auto; padding: 12px; background: var(--surface-card-solid, var(--bg-primary)); }
.office-content-surface { min-height: 0; }
.office-container :deep(.docx-wrapper) { background: transparent; padding: 8px 0; }
.office-container :deep(.docx-wrapper > section.docx) { margin: 0 auto; box-shadow: 0 1px 6px rgb(0 0 0 / 0.25); border-bottom: 1px solid var(--content-divider); overflow: hidden; }
.office-container :deep(.docx-wrapper > section.docx:last-child) { border-bottom: 0; }
.office-container :deep(section.docx p:has(img)) { height: auto !important; min-height: 0 !important; width: 100% !important; max-width: 100% !important; }
.office-container :deep(section.docx p:has(img) > span),
.office-container :deep(section.docx p:has(img) > span > div) { display: block; box-sizing: border-box; height: auto !important; min-height: 0 !important; width: 100% !important; max-width: 100% !important; overflow: hidden; }
.office-container :deep(section.docx img) { display: block; width: auto !important; max-width: 100% !important; height: auto !important; object-fit: contain; }
.office-container :deep(section.docx p.docx-bullet-normalized) { display: block !important; list-style: none !important; margin-left: 0 !important; margin-right: 0 !important; padding-left: 0 !important; text-indent: 0 !important; }
.office-container :deep(section.docx p.docx-bullet-normalized::before) { content: '•' !important; display: inline-block; width: 1em; margin-right: 0; font-family: sans-serif !important; }
.office-container :deep(table) { border-collapse: collapse; }
.office-container :deep(.docx td), .office-container :deep(.docx th) { border: 1px solid var(--border-document-table); padding: 3px 8px; }
.office-notice { padding: 11px 14px; border-top: 1px solid var(--panel-glass-border); color: var(--content-secondary); font-size: 12px; }
</style>
