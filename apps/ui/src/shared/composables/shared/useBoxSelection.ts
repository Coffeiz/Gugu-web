import { ref, shallowRef, computed, type Ref } from 'vue'

type Id = number | string
interface Pt { x: number; y: number }

export function useBoxSelection<F extends Id = string, I extends Id = string>(containerRef: Ref<HTMLElement | null>, {
  filePathAttr    = 'data-file-path',
  directoryPathAttr      = 'data-folder-key',
  extraDirectoryPathAttrs = [],
  excludeSelector = 'button, .fc-card, .folder-card, .fc-upload, .list-row',
  parseFilePath     = ((value: string) => value as I),
  parseDirectoryPath   = ((v: string) => v as F),
  onBoxSelect     = null,
  onClear         = null,
  getItemsInBox,
}: {
  filePathAttr?: string
  getItemsInBox?: (box: { left: number; top: number; width: number; height: number }) => { filePaths: Set<I>; directoryPaths: Set<F> } | null
  directoryPathAttr?: string
  extraDirectoryPathAttrs?: string[]
  excludeSelector?: string
  parseFilePath?: (v: string) => I
  parseDirectoryPath?: (v: string) => F
  onBoxSelect?: ((sel: { filePaths: Set<I>; directoryPaths: Set<F> }, e: MouseEvent) => void) | null
  // 点击空白区域（非拖框选、非 ctrl/shift）时的兜底清空只知道本组合式函数自己管的
  // selectedFilePaths/selectedDirectoryPaths；调用方如果在组合式函数之外还维护了别的选择态
  // （比如 Files/index.vue 的回收站文件夹用独立的 selectedTrashDirectoryPaths，box 拖选时靠
  // extraDirectoryPathAttrs+onBoxSelect 能覆盖到，但点击清空这条路径够不着），要一并清掉就传这个
  // 钩子——2026-07-17 复现：回收站多选文件+文件夹后点空白，文件夹选中态没跟着清掉。
  onClear?: (() => void) | null
} = {}) {
  const selectedFilePaths   = shallowRef(new Set<I>())
  const selectedDirectoryPaths = shallowRef(new Set<F>())
  const previewFilePaths    = shallowRef(new Set<I>())
  const previewDirectoryPaths  = shallowRef(new Set<F>())
  const boxStart          = ref<Pt | null>(null)
  const boxEnd            = ref<Pt | null>(null)
  let   _cRect: DOMRect | null = null
  let   _latestPreview: { filePaths: Set<I>; directoryPaths: Set<F> } = { filePaths: new Set(), directoryPaths: new Set() }

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
    selectedFilePaths.value   = new Set()
    selectedDirectoryPaths.value = new Set()
    onClear?.()
  }

  function _getItemsInBox() {
    const rect = selectionRect.value
    if (!rect || !containerRef.value) return { filePaths: new Set<I>(), directoryPaths: new Set<F>() }
    const virtualItems = getItemsInBox?.(rect)
    if (virtualItems) return virtualItems
    const cRect     = containerRef.value.getBoundingClientRect()
    const st        = containerRef.value.scrollTop
    const filePaths   = new Set<I>()
    const directoryPaths = new Set<F>()
    const folderSelectors = [directoryPathAttr, ...extraDirectoryPathAttrs].map(attr => `[${attr}]`).join(', ')
    containerRef.value.querySelectorAll(`[${filePathAttr}], ${folderSelectors}`).forEach(el => {
      const er = el.getBoundingClientRect()
      const l  = er.left - cRect.left
      const t  = er.top  - cRect.top + st
      if (l < rect.left + rect.width && l + er.width > rect.left &&
          t < rect.top  + rect.height && t + er.height > rect.top) {
        const fv = el.getAttribute(filePathAttr)
        const dv = [directoryPathAttr, ...extraDirectoryPathAttrs]
          .map(attr => el.getAttribute(attr))
          .find((value): value is string => value !== null)
        if (fv !== null) filePaths.add(parseFilePath(fv))
        if (dv != null) directoryPaths.add(parseDirectoryPath(dv))
      }
    })
    return { filePaths, directoryPaths }
  }

  function _updatePreview() {
    if (!selectionRect.value) {
      _latestPreview = { filePaths: new Set(), directoryPaths: new Set() }
      previewFilePaths.value = new Set(); previewDirectoryPaths.value = new Set()
      return
    }
    const { filePaths, directoryPaths } = _getItemsInBox()
    // _latestPreview keeps the complete hit set for mouseup semantics. The visual preview is only
    // for not-yet-selected items: selected + pre-selected on the same card creates two competing
    // paint states (and used to expose load-order differences in Mono folder cards).
    _latestPreview = { filePaths, directoryPaths }
    previewFilePaths.value = new Set([...filePaths].filter(id => !selectedFilePaths.value.has(id)))
    previewDirectoryPaths.value = new Set([...directoryPaths].filter(id => !selectedDirectoryPaths.value.has(id)))
  }

  function _swallowClick(e: Event) { e.stopImmediatePropagation() }

  function _onMouseMove(e: MouseEvent) {
    if (!_cRect || !containerRef.value) return
    // Safari 会在 document.mousemove 阶段继续扩展原生文字选区；框选已经接管了这次拖动。
    e.preventDefault()
    const st = containerRef.value.scrollTop
    boxEnd.value = { x: e.clientX - _cRect.left, y: e.clientY - _cRect.top + st }
    _updatePreview()
  }

  function _onMouseUp(e: MouseEvent) {
    document.removeEventListener('mousemove', _onMouseMove)
    document.removeEventListener('mouseup',   _onMouseUp)
    if (selectionRect.value) {
      if (onBoxSelect) {
        onBoxSelect({ filePaths: _latestPreview.filePaths, directoryPaths: _latestPreview.directoryPaths }, e)
      } else {
        selectedFilePaths.value   = _latestPreview.filePaths
        selectedDirectoryPaths.value = _latestPreview.directoryPaths
      }
      document.addEventListener('click', _swallowClick, { capture: true, once: true })
    } else if (!e.ctrlKey && !e.metaKey && !e.shiftKey) {
      clearSelection()
    }
    _latestPreview = { filePaths: new Set(), directoryPaths: new Set() }
    previewFilePaths.value = new Set(); previewDirectoryPaths.value = new Set()
    boxStart.value = null; boxEnd.value = null; _cRect = null
  }

  function onContainerMouseDown(e: MouseEvent) {
    if (e.button !== 0) return
    if (excludeSelector && (e.target as HTMLElement | null)?.closest(excludeSelector)) return
    if (!containerRef.value) return
    // 有文本输入框处于焦点（文件内联重命名、项目弹窗的阶段/待办重命名等）：
    // 放行默认行为，让输入框随点击失焦（@blur 提交并退出）。
    // mousedown preventDefault 会阻止焦点转移，否则点空白处退不出重命名。
    const active = document.activeElement
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return
    // 同理放行 contenteditable（聊天输入框等 ProseMirror 根是 div[contenteditable]）：
    // 不放行会把焦点钉在编辑器上，视觉选区还被下面 removeAllRanges 清空，看起来
    // 像已失焦，实际键盘撤销等默认行为仍被编辑器拦截、页面侧完全收不到（2026-09-10）。
    if (active instanceof HTMLElement && active.isContentEditable) return
    // 框选不是文本拖拽；在起点就阻止 Safari 建立选区，并清掉此前残留的文字选中态。
    e.preventDefault()
    window.getSelection()?.removeAllRanges()
    _cRect = containerRef.value.getBoundingClientRect()
    const st = containerRef.value.scrollTop
    boxStart.value = { x: e.clientX - _cRect.left, y: e.clientY - _cRect.top + st }
    boxEnd.value   = { ...boxStart.value! }
    document.addEventListener('mousemove', _onMouseMove)
    document.addEventListener('mouseup',   _onMouseUp)
  }

  function cancelDrag() {
    document.removeEventListener('mousemove', _onMouseMove)
    document.removeEventListener('mouseup', _onMouseUp)
    _latestPreview = { filePaths: new Set(), directoryPaths: new Set() }
    previewFilePaths.value = new Set(); previewDirectoryPaths.value = new Set()
    boxStart.value = null; boxEnd.value = null; _cRect = null
  }

  return {
    selectedFilePaths, selectedDirectoryPaths,
    previewFilePaths, previewDirectoryPaths,
    boxStart, selectionRect,
    clearSelection,
    onContainerMouseDown, cancelDrag,
  }
}
