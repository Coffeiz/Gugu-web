<template>
  <div class="file-browser-toolbar right-header">
    <GlassBg />
    <div ref="breadcrumbViewport" class="breadcrumb-viewport"
      @pointerdown="startBreadcrumbDrag" @pointermove="moveBreadcrumbDrag"
      @pointerup="endBreadcrumbDrag" @pointercancel="endBreadcrumbDrag"
      @click.capture="cancelBreadcrumbClick"
    >
      <slot name="breadcrumb" />
    </div>
    <FilePasteButton v-if="canPaste" compact :count="pasteCount" @paste="emit('paste')" />
    <button v-if="showSelection" class="sel-mode-btn select-mode-btn" :class="{ on: selectionMode }"
      @click.stop="emit('toggle-selection')" :title="t('sharedUi.selectionMode')">
      <Icon name="status.check-square" :size="13" />
    </button>
    <SegmentedControl v-if="showViewToggle" class="view-toggle" :active-index="viewMode === 'grid' ? 0 : 1">
      <button :class="{ on: viewMode === 'grid' }" @click="emit('update:view-mode', 'grid')" :title="t('sharedUi.gridView')">
        <Icon name="file.function" :size="13" />
      </button>
      <button :class="{ on: viewMode === 'list' }" @click="emit('update:view-mode', 'list')" :title="t('sharedUi.listView')">
        <Icon name="navigation.list" :size="13" />
      </button>
    </SegmentedControl>
    <button v-if="showNewFolderButton && !showNewFolder" class="new-folder-btn" @click.stop="emit('update:show-new-folder', true)">
      <Icon name="file.folder-add" :size="13" />{{ t('sharedUi.createFolder') }}
    </button>
    <div v-else-if="showNewFolderButton" class="new-folder-inline" @click.stop>
      <input ref="folderInput" class="new-folder-input" :value="newFolderName" :placeholder="t('sharedUi.folderName')"
        @input="emit('update:new-folder-name', ($event.target as HTMLInputElement).value)"
        v-enter.prevent="() => emit('create-folder')" @keyup.esc="cancelFolder" autofocus />
      <button class="btn-confirm-sm" :disabled="folderLoading" @click="emit('create-folder')">{{ t('sharedUi.confirm') }}</button>
      <button class="btn-cancel-sm" @click="cancelFolder">✕</button>
    </div>
    <button v-if="showNewWorkspaceButton" class="new-folder-btn workspace-btn" :class="{ 'workspace-remove-btn': workspaceExists }" :title="workspaceExists ? t('sharedUi.removeWorkspace') : t('sharedUi.addWorkspace')" @click.stop="emit('create-workspace')">
      <Icon :name="workspaceExists ? 'action.delete' : 'admin.stack'" :size="13" />{{ workspaceExists ? t('sharedUi.removeWorkspace') : t('sharedUi.addWorkspace') }}
    </button>
    <SortMenu v-if="showSort" :options="sortOptions" :sort-key="sortKey" :sort-dir="sortDir" @select="emit('sort-select', $event)" />
    <slot name="extra" />
    <slot name="trailing" />
    <CloseButton v-if="showClose" @click="emit('close')" />
  </div>
</template>

<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, onUpdated, ref, watch, type PropType } from 'vue'
import Icon from '@/components/common/icons/Icon.vue'
import CloseButton from '@/components/common/overlays/CloseButton.vue'
import SortMenu from '@/components/common/controls/SortMenu.vue'
import FilePasteButton from '@/components/common/file-browser/FilePasteButton.vue'
import SegmentedControl from '@/components/common/controls/SegmentedControl.vue'
import GlassBg from '@/components/common/layout/GlassBg.vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

const props = defineProps({
  canPaste: Boolean,
  pasteCount: { type: Number, default: 0 },
  selectionMode: Boolean,
  showSelection: { type: Boolean, default: true },
  showViewToggle: { type: Boolean, default: true },
  showNewFolderButton: { type: Boolean, default: true },
  showNewWorkspaceButton: Boolean,
  workspaceExists: Boolean,
  showSort: { type: Boolean, default: true },
  viewMode: { type: String as PropType<'grid' | 'list'>, default: 'grid' },
  showNewFolder: Boolean,
  newFolderName: { type: String, default: '' },
  folderLoading: Boolean,
  sortOptions: { type: Array as PropType<any[]>, default: () => [] },
  sortKey: { type: String, default: 'name' },
  sortDir: { type: String as PropType<'asc' | 'desc'>, default: 'asc' },
  showClose: { type: Boolean, default: true },
})
const emit = defineEmits<{
  paste: []
  'toggle-selection': []
  'update:view-mode': [value: 'grid' | 'list']
  'update:show-new-folder': [value: boolean]
  'update:new-folder-name': [value: string]
  'create-folder': []
  'create-workspace': []
  'sort-select': [value: any]
  close: []
}>()
const folderInput = ref<HTMLInputElement | null>(null)
const breadcrumbViewport = ref<HTMLElement | null>(null)
let dragStartX = 0
let dragStartScroll = 0
let activeBreadcrumbPointerId: number | null = null
let breadcrumbDragging = false
let suppressBreadcrumbClick = false
let breadcrumbLayoutFrame = 0
let breadcrumbResizeObserver: ResizeObserver | null = null

function scheduleBreadcrumbLayout() {
  if (breadcrumbLayoutFrame) cancelAnimationFrame(breadcrumbLayoutFrame)
  breadcrumbLayoutFrame = requestAnimationFrame(() => {
    breadcrumbLayoutFrame = 0
    updateBreadcrumbOverflow()
  })
}

/** 保持当前目录为右侧锚点，从最上级开始逐项压缩目录文字。 */
function updateBreadcrumbOverflow() {
  const scroller = breadcrumbScroller()
  if (!scroller) return
  const items = Array.from(scroller.querySelectorAll<HTMLElement>('.bc-item, .bc-seg'))
  items.forEach(item => {
    item.style.width = ''
    item.style.flexShrink = '0'
    item.classList.remove('is-breadcrumb-compressed')
  })

  let overflow = Math.max(0, scroller.scrollWidth - scroller.clientWidth)
  const activeIndex = items.findIndex(item => item.classList.contains('active'))
  items.forEach((item, index) => {
    if (index === activeIndex || overflow <= 0) return
    const naturalWidth = item.getBoundingClientRect().width
    const labelWidth = item.querySelector<HTMLElement>('.bc-label')?.getBoundingClientRect().width ?? 0
    const minimum = Math.max(30, naturalWidth - labelWidth + 18)
    const reduction = Math.min(overflow, Math.max(0, naturalWidth - minimum))
    if (reduction <= 0) return
    item.style.width = `${naturalWidth - reduction}px`
    item.classList.add('is-breadcrumb-compressed')
    overflow -= reduction
  })
}

function breadcrumbScroller() {
  return breadcrumbViewport.value?.querySelector<HTMLElement>('.breadcrumb, .file-breadcrumb') ?? null
}

function startBreadcrumbDrag(event: PointerEvent) {
  if ((event.target as HTMLElement).closest('.breadcrumb-nav')) return
  const el = breadcrumbScroller()
  if (!el || event.button !== 0) return
  dragStartX = event.clientX
  dragStartScroll = el.scrollLeft
  activeBreadcrumbPointerId = event.pointerId
  breadcrumbDragging = false
}
function moveBreadcrumbDrag(event: PointerEvent) {
  const el = breadcrumbScroller()
  if (!el || activeBreadcrumbPointerId !== event.pointerId) return
  const delta = event.clientX - dragStartX
  if (!breadcrumbDragging && Math.abs(delta) < 4) return
  if (!breadcrumbDragging) el.setPointerCapture?.(event.pointerId)
  breadcrumbDragging = true
  suppressBreadcrumbClick = true
  el.scrollLeft = dragStartScroll - delta
  event.preventDefault()
}
function endBreadcrumbDrag(event: PointerEvent) {
  const el = breadcrumbScroller()
  if (el?.hasPointerCapture?.(event.pointerId)) el.releasePointerCapture(event.pointerId)
  if (activeBreadcrumbPointerId === event.pointerId) activeBreadcrumbPointerId = null
  breadcrumbDragging = false
}
function cancelBreadcrumbClick(event: MouseEvent) {
  if (!suppressBreadcrumbClick) return
  event.preventDefault()
  event.stopPropagation()
  suppressBreadcrumbClick = false
}
onMounted(() => {
  breadcrumbResizeObserver = new ResizeObserver(() => scheduleBreadcrumbLayout())
  if (breadcrumbViewport.value) breadcrumbResizeObserver.observe(breadcrumbViewport.value)
  scheduleBreadcrumbLayout()
})
onUpdated(() => {
  scheduleBreadcrumbLayout()
})
onUnmounted(() => {
  if (breadcrumbLayoutFrame) cancelAnimationFrame(breadcrumbLayoutFrame)
  breadcrumbResizeObserver?.disconnect()
  breadcrumbResizeObserver = null
})
function cancelFolder() {
  emit('update:show-new-folder', false)
  emit('update:new-folder-name', '')
}
// Vue 的 autofocus 在已挂载的弹窗中不一定触发，显式聚焦保证键盘输入行为稳定。
watch(() => props.showNewFolder, value => {
  if (value) nextTick(() => folderInput.value?.focus())
})
</script>

<style scoped>
/* 共享工具栏只负责内部布局。外框高度属于宿主：文件库保持 v0.20.4 的 52px，
   项目编辑卡在自己的 toolbar host 中声明同样的高度。control paint/尺寸继续由
   file-toolbar-theme-refinements.css 唯一负责。 */
.file-browser-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  position: relative;
  isolation: isolate;
  background: transparent;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
}
.breadcrumb-viewport {
  position: relative;
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  cursor: grab;
  touch-action: pan-x;
}
.breadcrumb-viewport :deep(.breadcrumb),
.breadcrumb-viewport :deep(.file-breadcrumb) {
  flex: 1 1 auto;
  width: auto;
  min-width: 0;
  overflow: hidden;
  overflow-y: hidden;
  overflow-x: auto;
  scrollbar-width: none;
}
.breadcrumb-viewport:active { cursor: grabbing; }
.breadcrumb-viewport :deep(.breadcrumb::-webkit-scrollbar),
.breadcrumb-viewport :deep(.file-breadcrumb::-webkit-scrollbar) { display: none; }
.new-folder-inline {
  display: flex;
  align-items: center;
  gap: 5px;
}
.workspace-remove-btn { color: var(--danger-button-fg); }
.workspace-remove-btn:hover { color: var(--danger-button-fg); }
</style>
