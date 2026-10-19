<template>
  <div class="office-viewer-root">
    <div v-if="sheetTabs.length && !isCsv" class="sheet-tabs">
      <button v-for="tab in sheetTabs" :key="tab" class="sheet-tab" :class="{ active: tab === activeSheet }" @click="activeSheet = tab">{{ tab }}</button>
    </div>
    <ViewerToolbar
      v-if="sheetTabs.length || isCsv"
      :ariaLabel="t('viewerUi.spreadsheetToolbar')"
      :zoom-percent="sheetZoom"
      :previous-page-label="t('viewerUi.previousPage')"
      :next-page-label="t('viewerUi.nextPage')"
      :zoom-out-label="t('viewerUi.zoomOut')"
      :reset-zoom-label="t('viewerUi.resetZoom')"
      :zoom-in-label="t('viewerUi.zoomIn')"
      @zoom-out="changeSheetZoom(-10)"
      @reset-zoom="resetSheetZoom"
      @zoom-in="changeSheetZoom(10)"
    />
    <div class="office-container">
      <div ref="containerRef" class="office-content-surface" :style="{ zoom: sheetZoom / 100 }"></div>
    </div>
    <div v-if="notice" class="office-notice" role="note">{{ notice }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { filesApi } from '@/services/api'
import { readSpreadsheetZoom, saveSpreadsheetZoom } from '@/utils/spreadsheetZoomPreference'
import ViewerToolbar from '../ViewerToolbar.vue'

const props = defineProps<{ blobUrl?: string; ext: string; fileId?: number; fileVersion?: number }>()
const emit = defineEmits<{
  (e: 'content-size', width: number, height: number): void
  (e: 'csv-render-failed'): void
}>()
const { t } = useI18n()
const containerRef = ref<HTMLDivElement | null>(null)
const sheetTabs = ref<string[]>([])
const activeSheet = ref('')
const sheetZoom = ref(readSpreadsheetZoom())
const notice = ref('')
let sheetHtml: Record<string, string> = {}
let renderSequence = 0
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

async function fetchBuffer(): Promise<ArrayBuffer> {
  const res = await fetch(props.blobUrl)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.arrayBuffer()
}

const XLSX_MAX_ROWS = 500
const XLSX_MAX_COLS = 60
const isCsv = computed(() => props.ext.toLowerCase() === 'csv')

function changeSheetZoom(delta: number) {
  sheetZoom.value = saveSpreadsheetZoom(sheetZoom.value + delta)
}

function resetSheetZoom() {
  sheetZoom.value = saveSpreadsheetZoom(100)
}

async function renderXlsx(buffer: ArrayBuffer | null, container: HTMLElement) {
  const cacheKey = `${props.ext.toLowerCase()}:${props.fileId != null ? `file:${props.fileId}:${props.fileVersion ?? 0}` : props.blobUrl}`
  const cached = xlsxRenderCache.get(cacheKey)
  if (cached) {
    sheetHtml = cached.sheetHtml
    sheetTabs.value = cached.tabs
    if (!activeSheet.value || !cached.tabs.includes(activeSheet.value)) activeSheet.value = cached.tabs[0] ?? ''
    return
  }
  const preview = props.fileId != null && !isCsv.value ? await filesApi.xlsxPreview(props.fileId) : null
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
  const workbook = isCsv.value
    ? (await import('@/utils/csvPreview')).readCsvWorkbook(XLSX, buffer)
    : XLSX.read(buffer, { type: 'array', cellStyles: true })
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
  const reportSize = () => {
    const table = container.querySelector<HTMLTableElement>('table.xlsx-grid')
    if (!table) return
    // 用表格的自然尺寸初始化浮窗；不要按视口比例预留一整块空白。
    emit('content-size', table.scrollWidth + 24, table.offsetHeight + 48)
  }
  requestAnimationFrame(reportSize)
  setTimeout(reportSize, 120)
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
async function render() {
  const sequence = ++renderSequence
  const container = containerRef.value
  if (!container) return
  notice.value = ''
  sheetTabs.value = []
  container.replaceChildren()
  const ext = props.ext.toLowerCase()
  try {
    await renderXlsx(props.fileId != null && ext !== 'csv' ? null : await fetchBuffer(), container)
    if (ext === 'csv') sheetTabs.value = []
    renderSheet(activeSheet.value, container)
  } catch (cause) {
    if (sequence !== renderSequence) return
    console.warn('[office-viewer] spreadsheet render failed', cause)
    if (ext === 'csv') {
      emit('csv-render-failed')
      return
    }
    notice.value = t('files.officeRenderFailed')
  }
}

watch(() => [props.blobUrl, props.ext] as const, () => { void render() })
onMounted(() => { void render() })
watch(activeSheet, (name) => {
  const container = containerRef.value
  if (name && container) renderSheet(name, container)
})
onBeforeUnmount(() => {
  renderSequence++
  xlsxImageObserver?.disconnect()
  xlsxImageObserver = null
  if (xlsxImageScrollRoot && xlsxImageScrollHandler) {
    xlsxImageScrollRoot.removeEventListener('scroll', xlsxImageScrollHandler)
  }
  xlsxImageScrollRoot = null
  xlsxImageScrollHandler = null
  xlsxImageLoads.clear()
  containerRef.value?.replaceChildren()
})
</script>

<style scoped>
.office-viewer-root { position: relative; display: flex; flex-direction: column; height: 100%; min-height: 0; }
.sheet-tabs { display: flex; gap: 4px; padding: 8px 12px 0; flex-wrap: wrap; border-bottom: 1px solid var(--panel-glass-border); }
.sheet-tab { border: 1px solid var(--panel-glass-border); background: var(--panel-glass-bg); color: var(--content-secondary); border-radius: 6px 6px 0 0; padding: 3px 10px; font-size: 12px; cursor: pointer; }
.sheet-tab.active { color: var(--content-primary); border-bottom-color: transparent; font-weight: 600; }
.office-container { flex: 1; min-height: 0; overflow: auto; padding: 12px; background: var(--surface-card-solid, var(--bg-primary)); }
.office-content-surface { min-height: 0; }
.office-container :deep(.xlsx-grid) { border-collapse: collapse; width: max-content; min-width: max-content; table-layout: fixed; }
.office-container :deep(.xlsx-grid td) { border: 1px solid var(--border-document-table); height: 24px; padding: 2px 8px; font-size: 12px; color: var(--content-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.office-container :deep(.xlsx-grid td.xlsx-title) { height: 31px; padding: 4px 10px; font-size: 13px; font-weight: 600; text-align: center; vertical-align: middle; }
.office-container :deep(.xlsx-grid td.xlsx-header), .office-container :deep(.xlsx-grid td.xlsx-row-header) { background: var(--surface-soft); font-weight: 600; }
.office-container :deep(.xlsx-embedded-image) { display: block; max-width: none; height: auto; margin: 4px 0; }
.office-container :deep(.xlsx-empty), .office-container :deep(.xlsx-truncated) { padding: 10px 4px; color: var(--content-secondary); font-size: 12px; }
.office-notice { padding: 11px 14px; border-top: 1px solid var(--panel-glass-border); color: var(--content-secondary); font-size: 12px; }
</style>
