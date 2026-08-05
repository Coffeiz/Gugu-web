import { ref, shallowRef, computed, type Ref } from 'vue'

type Id = number | string
interface Pt { x: number; y: number }

export function useBoxSelection<F extends Id = Id>(containerRef: Ref<HTMLElement | null>, {
  fileAttr        = 'data-file-id',
  folderAttr      = 'data-folder-key',
  extraFolderAttrs = [],
  excludeSelector = 'button, .fc-card, .folder-card, .fc-upload, .list-row',
  parseFileId     = Number,
  parseFolderId   = ((v: string) => v as F),
  onBoxSelect     = null,
  onClear         = null,
}: {
  fileAttr?: string
  folderAttr?: string
  extraFolderAttrs?: string[]
  excludeSelector?: string
  parseFileId?: (v: string) => number
  parseFolderId?: (v: string) => F
  onBoxSelect?: ((sel: { fileIds: Set<number>; folderIds: Set<F> }, e: MouseEvent) => void) | null
  // 点击空白区域（非拖框选、非 ctrl/shift）时的兜底清空只知道本组合式函数自己管的
  // selectedFileIds/selectedFolderIds；调用方如果在组合式函数之外还维护了别的选择态
  // （比如 Files/index.vue 的回收站文件夹用独立的 selectedTrashFolderIds，box 拖选时靠
  // extraFolderAttrs+onBoxSelect 能覆盖到，但点击清空这条路径够不着），要一并清掉就传这个
  // 钩子——2026-07-17 复现：回收站多选文件+文件夹后点空白，文件夹选中态没跟着清掉。
  onClear?: (() => void) | null
} = {}) {
  const selectedFileIds   = shallowRef(new Set<number>())
  const selectedFolderIds = shallowRef(new Set<F>())
  const previewFileIds    = shallowRef(new Set<number>())
  const previewFolderIds  = shallowRef(new Set<F>())
  const boxStart          = ref<Pt | null>(null)
  const boxEnd            = ref<Pt | null>(null)
  let   _cRect: DOMRect | null = null
  let   _latestPreview: { fileIds: Set<number>; folderIds: Set<F> } = { fileIds: new Set(), folderIds: new Set() }

  const selectionRect = computed(() => {
    if (!boxStart.value || !boxEnd.value) return null
    const x1 = Math.min(boxStart.value.x, boxEnd.value.x)
    const x2 = Math.max(boxStart.value.x, boxEnd.value.x)
    const y1 = Math.min(boxStart.value.y, boxEnd.value.y)
    const y2 = Math.max(boxStart.value.y, boxEnd.value.y)
    if (x2 - x1 < 3 && y2 - y1 < 3) return null
    return { left: x1, top: y1, width: x2 - x1, height: y2 - y1 }
  })

  function clearSelection() {
    selectedFileIds.value   = new Set()
    selectedFolderIds.value = new Set()
    onClear?.()
  }

  function toggleFileSelect(id: number) {
    const ids = new Set(selectedFileIds.value)
    if (ids.has(id)) ids.delete(id); else ids.add(id)
    selectedFileIds.value = ids
  }

  function toggleFolderSelect(id: F) {
    const ids = new Set(selectedFolderIds.value)
    if (ids.has(id)) ids.delete(id); else ids.add(id)
    selectedFolderIds.value = ids
  }

  function _getItemsInBox() {
    const rect = selectionRect.value
    if (!rect || !containerRef.value) return { fileIds: new Set<number>(), folderIds: new Set<F>() }
    const cRect     = containerRef.value.getBoundingClientRect()
    const st        = containerRef.value.scrollTop
    const fileIds   = new Set<number>()
    const folderIds = new Set<F>()
    const folderSelectors = [folderAttr, ...extraFolderAttrs].map(attr => `[${attr}]`).join(', ')
    containerRef.value.querySelectorAll(`[${fileAttr}], ${folderSelectors}`).forEach(el => {
      const er = el.getBoundingClientRect()
      const l  = er.left - cRect.left
      const t  = er.top  - cRect.top + st
      if (l < rect.left + rect.width && l + er.width > rect.left &&
          t < rect.top  + rect.height && t + er.height > rect.top) {
        const fv = el.getAttribute(fileAttr)
        const dv = [folderAttr, ...extraFolderAttrs]
          .map(attr => el.getAttribute(attr))
          .find((value): value is string => value !== null)
        if (fv !== null) fileIds.add(parseFileId(fv))
        if (dv != null) folderIds.add(parseFolderId(dv))
      }
    })
    return { fileIds, folderIds }
  }

  function _updatePreview() {
    if (!selectionRect.value) {
      _latestPreview = { fileIds: new Set(), folderIds: new Set() }
      previewFileIds.value = new Set(); previewFolderIds.value = new Set()
      return
    }
    const { fileIds, folderIds } = _getItemsInBox()
    _latestPreview = { fileIds, folderIds }
    previewFileIds.value = fileIds; previewFolderIds.value = folderIds
  }

  function _swallowClick(e: Event) { e.stopImmediatePropagation() }

  function _onMouseMove(e: MouseEvent) {
    if (!_cRect || !containerRef.value) return
    const st = containerRef.value.scrollTop
    boxEnd.value = { x: e.clientX - _cRect.left, y: e.clientY - _cRect.top + st }
    _updatePreview()
  }

  function _onMouseUp(e: MouseEvent) {
    document.removeEventListener('mousemove', _onMouseMove)
    document.removeEventListener('mouseup',   _onMouseUp)
    if (selectionRect.value) {
      if (onBoxSelect) {
        onBoxSelect({ fileIds: _latestPreview.fileIds, folderIds: _latestPreview.folderIds }, e)
      } else {
        selectedFileIds.value   = _latestPreview.fileIds
        selectedFolderIds.value = _latestPreview.folderIds
      }
      document.addEventListener('click', _swallowClick, { capture: true, once: true })
    } else if (!e.ctrlKey && !e.metaKey && !e.shiftKey) {
      clearSelection()
    }
    _latestPreview = { fileIds: new Set(), folderIds: new Set() }
    previewFileIds.value = new Set(); previewFolderIds.value = new Set()
    boxStart.value = null; boxEnd.value = null; _cRect = null
  }

  function onContainerMouseDown(e: MouseEvent) {
    if (e.button !== 0) return
    if (excludeSelector && (e.target as HTMLElement | null)?.closest(excludeSelector)) return
    if (!containerRef.value) return
    _cRect = containerRef.value.getBoundingClientRect()
    const st = containerRef.value.scrollTop
    boxStart.value = { x: e.clientX - _cRect.left, y: e.clientY - _cRect.top + st }
    boxEnd.value   = { ...boxStart.value! }
    document.addEventListener('mousemove', _onMouseMove)
    document.addEventListener('mouseup',   _onMouseUp)
  }

  function cancelDrag() {
    document.removeEventListener('mousemove', _onMouseMove)
    document.removeEventListener('mouseup',   _onMouseUp)
    _latestPreview = { fileIds: new Set(), folderIds: new Set() }
    previewFileIds.value = new Set(); previewFolderIds.value = new Set()
    boxStart.value = null; boxEnd.value = null; _cRect = null
  }

  return {
    selectedFileIds, selectedFolderIds,
    previewFileIds, previewFolderIds,
    boxStart, selectionRect,
    clearSelection, toggleFileSelect, toggleFolderSelect,
    onContainerMouseDown, cancelDrag,
  }
}
