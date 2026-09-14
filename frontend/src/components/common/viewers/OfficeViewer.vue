<template>
  <div class="office-viewer-root">
    <div v-if="sheetTabs.length" class="sheet-tabs">
      <button
        v-for="tab in sheetTabs" :key="tab" class="sheet-tab"
        :class="{ active: tab === activeSheet }"
        @click="activeSheet = tab"
      >{{ tab }}</button>
    </div>
    <div ref="containerRef" class="office-container"></div>
    <div v-if="notice" class="office-notice" role="note">{{ notice }}</div>
  </div>
</template>

<script setup lang="ts">
// Office 只读预览（PRD 决策：前端渲染替代服务端 LibreOffice 转换）。
// 三个渲染库都按需动态加载，不进主包；docx-preview/pptx-preview 会往容器里
// 写带作用域的样式，容器必须由本组件持有并在切换时清空。
import { ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{ blobUrl: string; ext: string }>()
const emit = defineEmits<{ (e: 'content-size', width: number, height: number): void }>()
const { t } = useI18n()

const containerRef = ref<HTMLDivElement | null>(null)
const sheetTabs = ref<string[]>([])
const activeSheet = ref('')
const notice = ref('')

let sheetHtml: Record<string, string> = {}

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
    experimental: false,
  })
  fitDocxWidth(container)
}

// docx-preview 按 A4 固定宽渲染，浮动窗比纸窄时会左右溢出叠成"两层"；
// 按容器宽度对整叠纸做 zoom 缩放（zoom 影响布局盒，不会留下空白滚动区）。
function fitDocxWidth(container: HTMLElement) {
  const wrapper = container.querySelector<HTMLElement>(".docx-wrapper")
  const section = wrapper?.querySelector<HTMLElement>("section.docx")
  if (!wrapper || !section) return
  wrapper.style.zoom = "1"
  const pageWidth = section.offsetWidth
  if (pageWidth <= 0) return
  const available = container.clientWidth - 16
  const scale = Math.min(1, available / pageWidth)
  wrapper.style.zoom = scale < 1 ? String(scale) : "1"
}

async function renderXlsx(buffer: ArrayBuffer, container: HTMLElement) {
  const XLSX = await import('xlsx')
  const workbook = XLSX.read(buffer, { type: 'array' })
  sheetHtml = {}
  const tabs: string[] = []
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name]
    if (!sheet) continue
    sheetHtml[name] = XLSX.utils.sheet_to_html(sheet, { header: '', footer: '' })
    tabs.push(name)
  }
  if (!tabs.length) throw new Error('empty-workbook')
  sheetTabs.value = tabs
  if (!activeSheet.value || !tabs.includes(activeSheet.value)) activeSheet.value = tabs[0]!
}

function renderSheet(name: string, container: HTMLElement) {
  container.innerHTML = sheetHtml[name] ?? ''
}

let pptxPreviewer: { destroy: () => void; preview: (data: ArrayBuffer) => Promise<void> } | null = null

// 只按打开时的容器宽渲染一次：内容尺寸上报一次、窗口适配一次。
// 「容器变化→重渲染→再上报→窗口再适配」会形成越缩越小的振荡循环，绝不触发重渲染。
async function renderPptx(buffer: ArrayBuffer, container: HTMLElement) {
  container.innerHTML = ''
  const { init } = await import('pptx-preview')
  const width = Math.max(320, Math.round(container.clientWidth) - 16)
  pptxPreviewer = (await init(container, { width, height: Math.round(width * 9 / 16) })) as typeof pptxPreviewer
  await pptxPreviewer.preview(buffer)
  const firstSlide = container.querySelector<HTMLElement>('.pptx-preview-slide-wrapper')
  if (firstSlide) {
    // 窗口高度按第一页适配（其余页靠容器滚动），宽度留出内边距余量。
    emit('content-size', firstSlide.offsetWidth + 24, firstSlide.offsetHeight + 24)
  }
}

let renderSequence = 0
async function render() {
  const sequence = ++renderSequence
  const container = containerRef.value
  if (!container) return
  sheetTabs.value = []
  notice.value = ''
  container.innerHTML = ''
  const ext = props.ext.toLowerCase()
  try {
    if (ext === 'docx') {
      await renderDocx(await fetchBuffer(), container)
    } else if (ext === 'xlsx' || ext === 'xls') {
      await renderXlsx(await fetchBuffer(), container)
      renderSheet(activeSheet.value, container)
    } else if (ext === 'pptx') {
      await renderPptx(await fetchBuffer(), container)
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
  resizeObserver = new ResizeObserver(() => fitDocxWidth(container))
  resizeObserver.observe(container)
})
onBeforeUnmount(() => {
  pptxPreviewer?.destroy()
  pptxPreviewer = null
  resizeObserver?.disconnect()
  resizeObserver = null
  containerRef.value?.replaceChildren()
})
</script>

<style scoped>
.office-viewer-root { display: flex; flex-direction: column; height: 100%; min-height: 0; }
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
.office-container :deep(.docx-wrapper) { background: transparent; padding: 8px 0; }
/* pptx 只读：禁选中文本、禁原生拖拽（图片/文本会被拖走），黑底改透明消除多余空底 */
.office-container :deep(.pptx-preview-wrapper) {
  background: transparent !important;
  user-select: none;
  /* 双滚动条消除：内层不再自滚，统一由 .office-container 滚动 */
  overflow: visible !important;
  height: auto !important;
}
.office-container :deep(.pptx-preview-wrapper) img,
.office-container :deep(.pptx-preview-wrapper) svg { -webkit-user-drag: none; }
.office-container :deep(section.docx) { box-shadow: 0 1px 6px rgb(0 0 0 / 0.25); }
.office-container :deep(table) { border-collapse: collapse; }
.office-container :deep(td), .office-container :deep(th) { border: 1px solid var(--panel-glass-border); padding: 3px 8px; }
.office-notice {
  padding: 11px 14px; border-top: 1px solid var(--panel-glass-border);
  color: var(--content-secondary); font-size: 12px;
}
</style>
