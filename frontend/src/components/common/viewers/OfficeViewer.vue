<template>
  <div class="office-viewer-root" :class="{ 'pptx-fit-mode': isPptx && pptxFitMode === 'contain', 'pptx-zooming': pptxZooming }">
    <div v-if="sheetTabs.length" class="sheet-tabs">
      <button
        v-for="tab in sheetTabs" :key="tab" class="sheet-tab"
        :class="{ active: tab === activeSheet }"
        @click="activeSheet = tab"
      >{{ tab }}</button>
    </div>
    <ViewerToolbar
      v-if="isDocx"
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
    <ViewerToolbar
      v-if="isPptx && pptxSlideCount"
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
    <div class="office-container">
      <div v-if="isPptx" ref="pptxContainerRef" class="pptx-render-surface"></div>
      <div v-else ref="containerRef" class="office-content-surface"></div>
    </div>
    <div v-if="notice" class="office-notice" role="note">{{ notice }}</div>
  </div>
</template>

<script setup lang="ts">
// Office 只读预览（PRD 决策：前端渲染替代服务端 LibreOffice 转换）。
// 文档渲染库都按需动态加载，不进主包；docx-preview 和 PPTX renderer 会往容器里
// 写带作用域的样式，容器必须由本组件持有并在切换时清空。
import { computed, nextTick, ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import type { PptxViewer } from '@aiden0z/pptx-renderer'
import { filesApi } from '@/services/api'
import ViewerToolbar from './ViewerToolbar.vue'

const props = defineProps<{ blobUrl?: string; ext: string; fileId?: number; fileVersion?: number }>()
const emit = defineEmits<{ (e: 'content-size', width: number, height: number): void }>()
const { t } = useI18n()

const containerRef = ref<HTMLDivElement | null>(null)
const pptxContainerRef = ref<HTMLDivElement | null>(null)
const sheetTabs = ref<string[]>([])
const activeSheet = ref('')
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
const isDocx = computed(() => props.ext.toLowerCase() === 'docx')
const isPptx = computed(() => props.ext.toLowerCase() === 'pptx')
const pptxSlideIndex = ref(0)
const pptxSlideCount = ref(0)
const pptxZoom = ref(100)
const pptxFitMode = ref<'contain' | 'none'>('contain')
const pptxZooming = ref(false)
const pptxNavigationTarget = ref<number | null>(null)
let pptxNavigationReleaseTimer: ReturnType<typeof setTimeout> | null = null
let docxViewRequest = 0
let docxPageScrollRoot: HTMLElement | null = null
let docxPageScrollHandler: (() => void) | null = null

let sheetHtml: Record<string, string> = {}
type XlsxRenderCacheEntry = { sheetHtml: Record<string, string>; tabs: string[] }
const xlsxRenderCache = new Map<string, XlsxRenderCacheEntry>()
type XlsxPreviewSheetData = {
  cells?: Record<string, string>
  merges?: Array<{ s: number; c: number; e: number; d: number }>
  rowHeights?: Record<string, number>
  colWidths?: Record<string, number>
  rows?: number
  cols?: number
}

function setError(message: string) {
  notice.value = message
  if (containerRef.value) containerRef.value.innerHTML = ''
}

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

const XLSX_MAX_ROWS = 500
const XLSX_MAX_COLS = 60

async function renderXlsx(buffer: ArrayBuffer | null, container: HTMLElement) {
  const cacheKey = props.fileId != null ? `file:${props.fileId}:${props.fileVersion ?? 0}` : props.blobUrl
  const cached = xlsxRenderCache.get(cacheKey)
  if (cached) {
    sheetHtml = cached.sheetHtml
    sheetTabs.value = cached.tabs
    if (!activeSheet.value || !cached.tabs.includes(activeSheet.value)) activeSheet.value = cached.tabs[0] ?? ''
    return
  }
  const preview = props.fileId != null ? await filesApi.xlsxPreview(props.fileId) : null
  const previewData = preview?.sheets.map(sheet => sheet.data)
  if (previewData?.some(data => data?.cells)) {
    sheetHtml = {}
    const tabs = preview?.sheets.map((sheet, index) => sheet.data?.name || `工作表${index + 1}`) ?? []
    for (const [index, data] of previewData.entries()) {
      sheetHtml[tabs[index]!] = buildSheetHtmlFromData(data, new Map(Object.entries(preview?.sheets[index]?.images ?? {})))
    }
    sheetTabs.value = tabs
    if (!activeSheet.value || !tabs.includes(activeSheet.value)) activeSheet.value = tabs[0] ?? ''
    xlsxRenderCache.set(cacheKey, { sheetHtml, tabs })
    return
  }
  if (!buffer) throw new Error('empty-workbook')
  const XLSX = await import('xlsx')
  const workbook = XLSX.read(buffer, { type: 'array', cellStyles: true })
  sheetHtml = {}
  const tabs: string[] = []
  for (const [index, name] of workbook.SheetNames.entries()) {
    const sheet = workbook.Sheets[name]
    if (!sheet) continue
    const images = new Map(Object.entries(preview?.sheets[index]?.images ?? {}))
    sheetHtml[name] = buildSheetHtml(XLSX, sheet, images)
    tabs.push(name)
  }
  if (!tabs.length) throw new Error('empty-workbook')
  sheetTabs.value = tabs
  if (!activeSheet.value || !tabs.includes(activeSheet.value)) activeSheet.value = tabs[0]!
  xlsxRenderCache.delete(cacheKey)
  xlsxRenderCache.set(cacheKey, { sheetHtml, tabs })
  while (xlsxRenderCache.size > 3) {
    const oldest = xlsxRenderCache.keys().next().value as string | undefined
    if (!oldest) break
    xlsxRenderCache.delete(oldest)
  }
}

function buildSheetHtmlFromData(
  data: XlsxPreviewSheetData,
  images: Map<string, XlsxImage[]> = new Map(),
): string {
  const rowCount = Math.min(XLSX_MAX_ROWS, data.rows ?? 0)
  const cols = Math.min(XLSX_MAX_COLS, data.cols ?? 0)
  if (!rowCount || !cols) return '<div class="xlsx-empty">（空工作表）</div>'
  const esc = (value: unknown) => String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const cellValue = (r: number, c: number) => {
    let column = ''
    for (let value = c + 1; value > 0; value = Math.floor((value - 1) / 26)) {
      column = String.fromCharCode(65 + ((value - 1) % 26)) + column
    }
    return data.cells?.[`${column}${r + 1}`] ?? ''
  }
  const merges = (data.merges ?? []).filter(merge => (
    merge.s < rowCount && merge.c < cols && merge.e >= 0 && merge.d >= 0
  ))
  const hasTitleMerge = merges.some(merge => merge.s === 0 && merge.c === 0 && merge.d >= cols - 1)
  const mergeByStart = new Map(merges.map(merge => [`${merge.s}:${merge.c}`, merge]))
  const covered = new Set<string>()
  for (const merge of merges) {
    for (let r = merge.s; r <= Math.min(merge.e, rowCount - 1); r++) {
      for (let c = merge.c; c <= Math.min(merge.d, cols - 1); c++) {
        if (r !== merge.s || c !== merge.c) covered.add(`${r}:${c}`)
      }
    }
  }
  const renderedRows: string[] = []
  for (let r = 0; r < rowCount; r++) {
    const cells: string[] = []
    for (let c = 0; c < cols; c++) {
      if (covered.has(`${r}:${c}`)) continue
      const merge = mergeByStart.get(`${r}:${c}`)
      const colspan = merge ? Math.min(merge.d, cols - 1) - c + 1 : 1
      const rowspan = merge ? Math.min(merge.e, rowCount - 1) - r + 1 : 1
      const title = merge && r === 0 && c === 0 && colspan === cols
      const header = !title && r === (hasTitleMerge ? 1 : 0)
      const rowHeader = !title && !header && c === 0
      const classes = [title ? 'xlsx-title' : '', header ? 'xlsx-header' : '', rowHeader ? 'xlsx-row-header' : ''].filter(Boolean).join(' ')
      const attributes = [colspan > 1 ? ` colspan="${colspan}"` : '', rowspan > 1 ? ` rowspan="${rowspan}"` : '', classes ? ` class="${classes}"` : ''].join('')
      const embeddedImages = (images.get(`${r}:${c}`) ?? []).map(image => {
        const size = image.width ? ` style="width:${image.width}px;${image.height ? `height:${image.height}px;` : ''}"` : ''
        return `<img class="xlsx-embedded-image" data-xlsx-image-id="${image.id}" alt=""${size} />`
      }).join('')
      cells.push(`<td${attributes}>${esc(cellValue(r, c))}${embeddedImages}</td>`)
    }
    const height = data.rowHeights?.[String(r)]
    renderedRows.push(`<tr${height ? ` style="height:${height}px"` : ''}>${cells.join('')}</tr>`)
  }
  const colgroup = `<colgroup>${Array.from({ length: cols }, (_, c) => `<col style="width:${data.colWidths?.[String(c)] ?? 120}px" />`).join('')}</colgroup>`
  return `<table class="xlsx-grid">${colgroup}<tbody>${renderedRows.join('')}</tbody></table>`
}

// 这里自建统一网格：保留合并单元格和行高，空单元格补齐、隔行着色，超出上限截断。
type XlsxImage = { id: number; width?: number; height?: number }

function buildSheetHtml(
  XLSX: typeof import('xlsx'),
  sheet: import('xlsx').WorkSheet,
  images: Map<string, XlsxImage[]> = new Map(),
): string {
  if (!sheet['!ref']) return '<div class="xlsx-empty">（空工作表）</div>'
  const range = XLSX.utils.decode_range(sheet['!ref'])
  const rowCount = Math.min(XLSX_MAX_ROWS, range.e.r + 1)
  const cols = Math.min(XLSX_MAX_COLS, range.e.c + 1)
  if (!rowCount || !cols) return '<div class="xlsx-empty">（空工作表）</div>'
  const esc = (value: unknown) => String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const cellValue = (r: number, c: number) => {
    const cell = sheet[XLSX.utils.encode_cell({ r, c })]
    return cell ? (cell.w ?? XLSX.utils.format_cell(cell)) : ''
  }
  const merges = (sheet['!merges'] ?? []).filter((merge) => (
    merge.s.r < rowCount && merge.s.c < cols && merge.e.r >= 0 && merge.e.c >= 0
  ))
  const hasTitleMerge = merges.some((merge) => merge.s.r === 0 && merge.s.c === 0 && merge.e.c >= cols - 1)
  const mergeByStart = new Map(merges.map((merge) => [`${merge.s.r}:${merge.s.c}`, merge]))
  const covered = new Set<string>()
  for (const merge of merges) {
    for (let r = merge.s.r; r <= Math.min(merge.e.r, rowCount - 1); r++) {
      for (let c = merge.s.c; c <= Math.min(merge.e.c, cols - 1); c++) {
        if (r !== merge.s.r || c !== merge.s.c) covered.add(`${r}:${c}`)
      }
    }
  }
  const renderedRows: string[] = []
  for (let r = 0; r < rowCount; r++) {
    const cells: string[] = []
    for (let c = 0; c < cols; c++) {
      if (covered.has(`${r}:${c}`)) continue
      const merge = mergeByStart.get(`${r}:${c}`)
      const colspan = merge ? Math.min(merge.e.c, cols - 1) - c + 1 : 1
      const rowspan = merge ? Math.min(merge.e.r, rowCount - 1) - r + 1 : 1
      const title = merge && r === 0 && c === 0 && colspan === cols
      const header = !title && r === (hasTitleMerge ? 1 : 0)
      const rowHeader = !title && !header && c === 0
      const classes = [
        title ? 'xlsx-title' : '',
        header ? 'xlsx-header' : '',
        rowHeader ? 'xlsx-row-header' : '',
      ].filter(Boolean).join(' ')
      const attributes = [
        colspan > 1 ? ` colspan="${colspan}"` : '',
        rowspan > 1 ? ` rowspan="${rowspan}"` : '',
        classes ? ` class="${classes}"` : '',
      ].join('')
      const embeddedImages = (images.get(`${r}:${c}`) ?? [])
        .map((image) => {
          const size = image.width ? ` style="width:${image.width}px;${image.height ? `height:${image.height}px;` : ''}"` : ''
          return `<img class="xlsx-embedded-image" data-xlsx-image-id="${image.id}" alt=""${size} />`
        })
        .join('')
      cells.push(`<td${attributes}>${esc(cellValue(r, c))}${embeddedImages}</td>`)
    }
    const height = sheet['!rows']?.[r]?.hpx
    renderedRows.push(`<tr${height ? ` style="height:${Math.round(height)}px"` : ''}>${cells.join('')}</tr>`)
  }
  const colgroup = `<colgroup>${Array.from({ length: cols }, (_, c) => {
    const column = sheet['!cols']?.[c]
    // Excel 的字符宽度比 SheetJS 换算出的 wpx 更接近预览器中的实际列宽。
    const width = Math.max(72, Math.round((column?.wch ?? ((column?.wpx ?? 120) / 14)) * 8 + 16))
    return `<col style="width:${width}px" />`
  }).join('')}</colgroup>`
  return `<table class="xlsx-grid">${colgroup}<tbody>${renderedRows.join('')}</tbody></table>` +
    (range.e.r + 1 > XLSX_MAX_ROWS ? `<div class="xlsx-truncated">已截断：仅显示前 ${XLSX_MAX_ROWS} 行</div>` : '')
}

function renderSheet(name: string, container: HTMLElement) {
  container.innerHTML = sheetHtml[name] ?? ''
  observeXlsxImages(container)
  if (!isDocx.value && !isPptx.value) {
    const reportSize = () => {
      const table = container.querySelector<HTMLTableElement>('table.xlsx-grid')
      if (!table) return
      // 用表格的自然尺寸初始化浮窗；不要按视口比例预留一整块空白。
      emit('content-size', table.scrollWidth + 24, table.offsetHeight + 48)
    }
    requestAnimationFrame(reportSize)
    setTimeout(reportSize, 120)
  }
}

const XLSX_IMAGE_CACHE_MAX = 80
const xlsxImageUrls = new Map<string, string>()
const xlsxImageLoads = new Map<string, Promise<void>>()
let xlsxImageObserver: IntersectionObserver | null = null
let xlsxImageScrollRoot: HTMLElement | null = null
let xlsxImageScrollHandler: (() => void) | null = null

async function loadXlsxImage(image: HTMLImageElement, imageId: number) {
  const fileId = props.fileId
  if (fileId == null) return
  const cacheKey = `file:${fileId}:${props.fileVersion ?? 0}:image:${imageId}`
  const cached = xlsxImageUrls.get(cacheKey)
  if (cached) {
    image.src = cached
    return
  }
  const running = xlsxImageLoads.get(cacheKey)
  if (running) {
    await running
    const url = xlsxImageUrls.get(cacheKey)
    if (url) image.src = url
    return
  }
  const load = filesApi.xlsxPreviewImage(fileId, imageId, props.fileVersion ?? 0).then(blob => {
    const url = URL.createObjectURL(blob)
    xlsxImageUrls.set(cacheKey, url)
    while (xlsxImageUrls.size > XLSX_IMAGE_CACHE_MAX) {
      const oldest = xlsxImageUrls.keys().next().value
      if (!oldest) break
      const oldestUrl = xlsxImageUrls.get(oldest)
      if (oldestUrl) URL.revokeObjectURL(oldestUrl)
      xlsxImageUrls.delete(oldest)
    }
    image.src = url
  }).catch(() => {
    image.dataset.xlsxImageFailed = 'true'
  }).finally(() => {
    xlsxImageLoads.delete(cacheKey)
  })
  xlsxImageLoads.set(cacheKey, load)
  await load
}

function observeXlsxImages(container: HTMLElement) {
  xlsxImageObserver?.disconnect()
  xlsxImageObserver = null
  if (xlsxImageScrollRoot && xlsxImageScrollHandler) {
    xlsxImageScrollRoot.removeEventListener('scroll', xlsxImageScrollHandler)
  }
  xlsxImageScrollRoot = null
  xlsxImageScrollHandler = null
  if (props.fileId == null) return
  const root = container.parentElement
  if (typeof IntersectionObserver !== 'undefined') {
    xlsxImageObserver = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        const image = entry.target as HTMLImageElement
        const imageId = Number(image.dataset.xlsxImageId)
        if (Number.isInteger(imageId) && !image.getAttribute('src') && image.dataset.xlsxImageFailed !== 'true') {
          void loadXlsxImage(image, imageId)
        }
        xlsxImageObserver?.unobserve(image)
      }
    }, { root, rootMargin: '1200px 0px' })
  }
  for (const image of container.querySelectorAll<HTMLImageElement>('img[data-xlsx-image-id]')) {
    const imageId = Number(image.dataset.xlsxImageId)
    const cacheKey = `file:${props.fileId}:${props.fileVersion ?? 0}:image:${imageId}`
    const cached = xlsxImageUrls.get(cacheKey)
    if (cached) image.src = cached
    else xlsxImageObserver?.observe(image)
  }

  const loadNearby = () => {
    const rootRect = root?.getBoundingClientRect()
    if (!rootRect) return
    const margin = 1200
    for (const image of container.querySelectorAll<HTMLImageElement>('img[data-xlsx-image-id]')) {
      if (image.getAttribute('src') || image.dataset.xlsxImageFailed === 'true') continue
      const rect = image.getBoundingClientRect()
      if (rect.bottom >= rootRect.top - margin && rect.top <= rootRect.bottom + margin) {
        const imageId = Number(image.dataset.xlsxImageId)
        if (Number.isInteger(imageId)) void loadXlsxImage(image, imageId)
      }
    }
  }
  xlsxImageScrollRoot = root
  xlsxImageScrollHandler = loadNearby
  root?.addEventListener('scroll', loadNearby, { passive: true })
  loadNearby()
}

let pptxViewer: PptxViewer | null = null
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
  const { PptxViewer, RECOMMENDED_ZIP_LIMITS } = await import('@aiden0z/pptx-renderer')
  pptxViewer = await PptxViewer.open(buffer, container, {
    fitMode: 'contain',
    scrollContainer,
    zipLimits: RECOMMENDED_ZIP_LIMITS,
    lazyMedia: true,
    lazySlides: true,
    renderMode: 'list',
    listOptions: { windowed: true, initialSlides: 4, batchSize: 4 },
  })
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

let renderSequence = 0
async function render() {
  const sequence = ++renderSequence
  docxViewRequest++
  docxPageCount.value = 0
  docxPageIndex.value = 0
  const container = isPptx.value ? pptxContainerRef.value : containerRef.value
  if (!container) return
  pptxViewer?.destroy()
  pptxViewer = null
  pptxSlideIndex.value = 0
  pptxSlideCount.value = 0
  pptxNavigationTarget.value = null
  if (pptxNavigationReleaseTimer) {
    clearTimeout(pptxNavigationReleaseTimer)
    pptxNavigationReleaseTimer = null
  }
  pptxZoom.value = 100
  pptxFitMode.value = 'contain'
  sheetTabs.value = []
  notice.value = ''
  container.innerHTML = ''
  const ext = props.ext.toLowerCase()
  try {
    if (ext === 'docx') {
      await renderDocx(await fetchBuffer(), container)
    } else if (ext === 'xlsx' || ext === 'xls') {
      await renderXlsx(props.fileId != null ? null : await fetchBuffer(), container)
      renderSheet(activeSheet.value, container)
    } else if (ext === 'pptx') {
      const scrollContainer = container.parentElement ?? container
      await renderPptx(await fetchBuffer(), container, scrollContainer)
    } else {
      // .doc / .ppt 是 97-2003 二进制格式，前端渲染器只支持 OOXML；提示下载查看。
      notice.value = t('files.legacyOfficeHint')
    }
  } catch (cause) {
    if (sequence !== renderSequence) return
    console.warn('[office-viewer] render failed', cause)
    notice.value = t('files.officeRenderFailed')
  }
}

// immediate watch 在挂载前触发时 containerRef 还是 null；挂载后再渲染一次。
watch(() => [props.blobUrl, props.ext] as const, () => { void render() })
onMounted(() => { void render() })
watch(activeSheet, (name) => {
  const container = containerRef.value
  if (name && container) renderSheet(name, container)
})
// 浮动窗拖拽缩放会改变容器宽度，纸页宽度需要跟着重新适配。
let resizeObserver: ResizeObserver | null = null
onMounted(() => {
  const container = containerRef.value
  if (!container || typeof ResizeObserver === "undefined") return
  resizeObserver = new ResizeObserver(() => {
    scheduleDocxView()
  })
  resizeObserver.observe(container)
})
onBeforeUnmount(() => {
  pptxViewer?.off('slidechange', onPptxSlideChange)
  pptxViewer?.destroy()
  pptxViewer = null
  if (pptxNavigationReleaseTimer) clearTimeout(pptxNavigationReleaseTimer)
  pptxNavigationReleaseTimer = null
  pptxNavigationTarget.value = null
  resizeObserver?.disconnect()
  resizeObserver = null
  xlsxImageObserver?.disconnect()
  xlsxImageObserver = null
  if (xlsxImageScrollRoot && xlsxImageScrollHandler) {
    xlsxImageScrollRoot.removeEventListener('scroll', xlsxImageScrollHandler)
  }
  xlsxImageScrollRoot = null
  xlsxImageScrollHandler = null
  if (docxPageScrollRoot && docxPageScrollHandler) {
    docxPageScrollRoot.removeEventListener('scroll', docxPageScrollHandler)
  }
  docxPageScrollRoot = null
  docxPageScrollHandler = null
  // 图片对象 URL 保留在模块级缓存中，关闭后再次打开可直接复用；仅在 LRU 淘汰时释放。
  xlsxImageLoads.clear()
  containerRef.value?.replaceChildren()
  pptxContainerRef.value?.replaceChildren()
})
</script>

<style scoped>
.office-viewer-root {
  position: relative; display: flex; flex-direction: column; height: 100%; min-height: 0;
}
.sheet-tabs {
  display: flex; gap: 4px; padding: 8px 12px 0; flex-wrap: wrap;
  border-bottom: 1px solid var(--panel-glass-border);
}
.sheet-tab {
  border: 1px solid var(--panel-glass-border); background: var(--panel-glass-bg);
  color: var(--content-secondary); border-radius: 6px 6px 0 0;
  padding: 3px 10px; font-size: 12px; cursor: pointer;
}
.sheet-tab.active { color: var(--content-primary); border-bottom-color: transparent; font-weight: 600; }
.office-container {
  flex: 1; min-height: 0; overflow: auto; padding: 12px;
  background: var(--surface-card-solid, var(--bg-primary));
}
.pptx-render-surface {
  width: 96%;
  min-height: 100%;
  margin-inline: auto;
  box-sizing: border-box;
}
.office-viewer-root.pptx-zooming .pptx-render-surface {
  visibility: hidden;
}
/* 让单页 DOCX 的内容表面跟随实际纸张高度，不额外撑满整个预览窗口。 */
.office-content-surface { min-height: 0; }
.office-container :deep(.docx-wrapper) { background: transparent; padding: 8px 0; }
/* xlsx：统一网格——固定列宽行高、斑马纹、撑满容器宽度 */
.office-container :deep(.xlsx-grid) {
  border-collapse: collapse;
  width: max-content;
  min-width: max-content;
  table-layout: fixed;
}
.office-container :deep(.xlsx-grid td) {
  border: 1px solid var(--border-document-table);
  height: 24px;
  padding: 2px 8px;
  font-size: 12px;
  color: var(--content-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.office-container :deep(.xlsx-grid td.xlsx-title) {
  height: 31px;
  padding: 4px 10px;
  font-size: 13px;
  font-weight: 600;
  text-align: center;
  vertical-align: middle;
}
.office-container :deep(.xlsx-grid td.xlsx-header) {
  background: var(--surface-soft);
  font-weight: 600;
}
.office-container :deep(.xlsx-grid td.xlsx-row-header) {
  background: var(--surface-soft);
  font-weight: 600;
}
.office-container :deep(.xlsx-embedded-image) {
  display: block;
  max-width: none;
  height: auto;
  margin: 4px 0;
}
.office-container :deep(.xlsx-empty),
.office-container :deep(.xlsx-truncated) {
  padding: 10px 4px;
  color: var(--content-secondary);
  font-size: 12px;
}
/* pptx 只读：多页由 renderer 的 list 模式统一承载，禁选中文本和原生拖拽。 */
.office-container :deep([data-slide-index]) {
  user-select: none;
}
.office-container :deep([data-slide-index] > div) {
  background: transparent !important;
  margin-inline: auto;
}
.office-container :deep([data-slide-index] svg),
.office-container :deep([data-slide-index] img) {
  user-select: none;
  -webkit-user-drag: none;
}
.office-container :deep(.docx-wrapper > section.docx) {
  margin: 0 auto;
  box-shadow: 0 1px 6px rgb(0 0 0 / 0.25);
  border-bottom: 1px solid var(--border-default);
  overflow: hidden;
}
.office-container :deep(.docx-wrapper > section.docx:last-child) {
  border-bottom: 0;
}
.office-container :deep(section.docx p:has(img)) {
  height: auto !important;
  min-height: 0 !important;
  width: 100% !important;
  max-width: 100% !important;
}
.office-container :deep(section.docx p:has(img) > span),
.office-container :deep(section.docx p:has(img) > span > div) {
  display: block;
  box-sizing: border-box;
  height: auto !important;
  min-height: 0 !important;
  width: 100% !important;
  max-width: 100% !important;
  overflow: hidden;
}
.office-container :deep(section.docx img) {
  display: block;
  width: auto !important;
  max-width: 100% !important;
  height: auto !important;
  object-fit: contain;
}
.office-container :deep(section.docx p.docx-bullet-normalized) {
  display: block !important;
  list-style: none !important;
  margin-left: 0 !important;
  margin-right: 0 !important;
  padding-left: 0 !important;
  text-indent: 0 !important;
}
.office-container :deep(section.docx p.docx-bullet-normalized::before) {
  content: '•' !important;
  display: inline-block;
  width: 1em;
  margin-right: 0;
  font-family: sans-serif !important;
}
.office-container :deep(table) { border-collapse: collapse; }
.office-container :deep(.docx td), .office-container :deep(.docx th) {
  border: 1px solid var(--border-document-table);
  padding: 3px 8px;
}
.office-notice {
  padding: 11px 14px; border-top: 1px solid var(--panel-glass-border);
  color: var(--content-secondary); font-size: 12px;
}
</style>
