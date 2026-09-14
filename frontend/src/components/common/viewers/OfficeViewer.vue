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

async function renderPptx(buffer: ArrayBuffer, container: HTMLElement) {
  container.innerHTML = ''
  const { init } = await import('pptx-preview')
  const width = Math.min(container.clientWidth || 960, 960)
  const previewer = init(container, { width, height: Math.round(width * 9 / 16) })
  await previewer.preview(buffer)
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
onBeforeUnmount(() => { containerRef.value?.replaceChildren() })
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
.office-container :deep(table) { border-collapse: collapse; }
.office-container :deep(td), .office-container :deep(th) { border: 1px solid var(--panel-glass-border); padding: 3px 8px; }
.office-notice {
  padding: 11px 14px; border-top: 1px solid var(--panel-glass-border);
  color: var(--content-secondary); font-size: 12px;
}
</style>
