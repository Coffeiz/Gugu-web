import { computed, nextTick, ref, watch, type Ref } from 'vue'
import type { FileMeta } from '@/stores/filesCache'
import type { TrashFolderMeta } from '@/services/api'
import type { FolderCard as FolderCardMeta } from '@/utils/filesNav'
import { useBoxSelection } from '@/composables/shared/useBoxSelection'
import { useSelectionState, selectRange, resolveSelectionAnchor, type SelectableItem } from './useSelectionState'

export interface FileLibrarySelectionOptions {
  containerRef: Ref<HTMLElement | null>
  currentType: Ref<string>
  getFolders: () => Array<{ id: number | string }>
  getFiles: () => FileMeta[]
  getTrashFolders: () => TrashFolderMeta[]
  enterFolder: (folder: FolderCardMeta) => void
  openPreview: (file: FileMeta) => void
  isPreviewable: (ext: string) => boolean
}

/** 文件库页面的统一选择协调器；批量副作用仍由 action composable 负责。 */
export function useFileLibrarySelection(options: FileLibrarySelectionOptions) {
  const selectedTrashFolderIds = ref<Set<number>>(new Set())
  const selectModeForced = ref(false)
  const lastAnchorIndex = ref(-1)
  const box = useBoxSelection(options.containerRef, {
    fileAttr: 'data-file-id', folderAttr: 'data-folder-key', extraFolderAttrs: ['data-trash-folder-id'],
    excludeSelector: 'button, .fc-card, .folder-card, .fub, .list-row',
    onBoxSelect: ({ fileIds, folderIds }, event) => {
      const normal = new Set([...folderIds].filter(id => !String(id).startsWith('trash:')))
      const trash = new Set([...folderIds].filter(id => String(id).startsWith('trash:')).map(id => Number(String(id).slice(6))))
      if (event.shiftKey) {
        box.selectedFileIds.value = new Set([...box.selectedFileIds.value, ...fileIds])
        box.selectedFolderIds.value = new Set([...box.selectedFolderIds.value, ...normal])
        selectedTrashFolderIds.value = new Set([...selectedTrashFolderIds.value, ...trash])
      } else {
        box.selectedFileIds.value = fileIds
        box.selectedFolderIds.value = normal
        selectedTrashFolderIds.value = trash
      }
      if (fileIds.size || folderIds.size) selectModeForced.value = true
    },
    onClear: () => { selectedTrashFolderIds.value = new Set() },
  })
  const state = useSelectionState({ fileIds: box.selectedFileIds, folderIds: box.selectedFolderIds })
  const flatSelectableItems = computed<SelectableItem<number | string>[]>(() => [
    ...(options.currentType.value === 'trash' ? options.getTrashFolders() : options.getFolders()).map(folder => ({ type: 'folder' as const, id: folder.id })),
    ...options.getFiles().map(file => ({ type: 'file' as const, id: file.id })),
  ])
  // 离场窗口：退出多选后、选中集合清空前的短暂时段，inSelectionMode 视为 false
  // （checkbox 的 v-if 翻转触发离场过渡），但集合保留让 .checked 样式撑满整个淡出。
  const selectionExiting = ref(false)
  const inSelectionMode = computed(() => !selectionExiting.value && (selectModeForced.value || box.selectedFileIds.value.size > 0 || box.selectedFolderIds.value.size > 0 || selectedTrashFolderIds.value.size > 0))
  function anchor(type: 'file' | 'folder', id: number | string) { lastAnchorIndex.value = flatSelectableItems.value.findIndex(item => item.type === type && item.id === id) }
  function range(type: 'file' | 'folder', id: number | string) {
    const target = flatSelectableItems.value.findIndex(item => item.id === id)
    return target >= 0 && lastAnchorIndex.value >= 0 && state.selectRangeIn(flatSelectableItems.value, lastAnchorIndex.value, target)
  }
  // 退出多选的两段式：先只关模式位让 checkbox 进入离场过渡（DOM 节点还在，selected
  // 集合未清 → .checked 保留，带着选中样式一次性淡出），过渡结束再清集合。若同帧清空，
  // 选中高亮会在淡出第一帧就消失，暗色下结尾明显闪一下。150ms = sel-cb leave 0.15s。
  let exitTimer: ReturnType<typeof setTimeout> | null = null
  let restoringSelection = false
  // 真正的清空必须走这里：挂上 restoringSelection 让兜底守望跳过本次集合变化，
  // 否则守望会把"非空→空"当成意外清空又恢复回去，退出动画播完模式就复活了。
  function doClear() {
    restoringSelection = true
    selectionExiting.value = false
    state.clearSelection(); box.clearSelection(); selectedTrashFolderIds.value = new Set(); lastAnchorIndex.value = -1
    nextTick(() => { restoringSelection = false })
  }
  function beginExit() {
    selectionExiting.value = true
    selectModeForced.value = false
    exitTimer = setTimeout(() => {
      exitTimer = null
      doClear()
    }, 150)
  }
  function clearSelection() {
    if (exitTimer !== null) { clearTimeout(exitTimer); exitTimer = null }
    if (!inSelectionMode.value) {
      // 离场窗口内再次清空：必须复位 exiting 标志，否则 inSelectionMode 永远为
      // false，之后再次进入多选也不会显示 checkbox。
      doClear()
      return
    }
    beginExit()
  }
  // 兜底守望：除 clearSelection 外还有多条路径会同步清空选中集合（点卡片取消最后一张、
  // box 内部兜底清空等），任何一条都会让 .checked 在离场第一帧消失。这里监视三个集合：
  // 多选模式下从非空变空的瞬间，先恢复旧集合并进入离场窗口，150ms 后再真正清空。
  // 反向（空→非空）说明离场窗口内用户开始了新的选择：取消待清定时器并复位窗口，
  // 避免定时器把新选择也清掉。
  watch([() => box.selectedFileIds.value, () => box.selectedFolderIds.value, selectedTrashFolderIds],
    ([nf, nfo, nt], [of, ofo, ot]) => {
      if (restoringSelection) return
      const had = of.size > 0 || ofo.size > 0 || ot.size > 0
      const empty = nf.size === 0 && nfo.size === 0 && nt.size === 0
      if (selectionExiting.value && !empty) {
        if (exitTimer !== null) { clearTimeout(exitTimer); exitTimer = null }
        selectionExiting.value = false
        selectModeForced.value = true
        return
      }
      if (selectionExiting.value) return
      if (!had || !empty) return
      restoringSelection = true
      box.selectedFileIds.value = of
      box.selectedFolderIds.value = ofo
      selectedTrashFolderIds.value = ot
      nextTick(() => { restoringSelection = false })
      beginExit()
    })
  function handleFolderClick(folder: { id: number | string }, event: MouseEvent) {
    if (event.shiftKey) {
      const hadAnchor = lastAnchorIndex.value >= 0
      if (!range('folder', folder.id)) state.selectOnlyFolder(folder.id)
      lastAnchorIndex.value = resolveSelectionAnchor(lastAnchorIndex.value, flatSelectableItems.value.findIndex(item => item.type === 'folder' && item.id === folder.id), hadAnchor)
      return
    }
    if (event.ctrlKey || event.metaKey || inSelectionMode.value) { state.toggleFolder(folder.id); selectModeForced.value = true; anchor('folder', folder.id); return }
    options.enterFolder(folder as FolderCardMeta)
  }
  function handleFileClick(file: FileMeta, event: MouseEvent) {
    if (event.shiftKey) {
      const hadAnchor = lastAnchorIndex.value >= 0
      if (!range('file', file.id)) state.selectOnlyFile(file.id)
      lastAnchorIndex.value = resolveSelectionAnchor(lastAnchorIndex.value, flatSelectableItems.value.findIndex(item => item.type === 'file' && item.id === file.id), hadAnchor)
      return
    }
    if (event.ctrlKey || event.metaKey || inSelectionMode.value) { state.toggleFile(file.id); selectModeForced.value = true; anchor('file', file.id); return }
    if (options.isPreviewable(file.ext)) options.openPreview(file); else state.toggleExclusiveFile(file.id)
    anchor('file', file.id)
  }
  function handleTrashFileClick(file: FileMeta, event: MouseEvent) {
    if ((event.target as HTMLElement).closest('button')) return
    const target = flatSelectableItems.value.findIndex(item => item.type === 'file' && item.id === file.id)
    if (event.shiftKey && lastAnchorIndex.value >= 0 && target >= 0) {
      const selected = selectRange(flatSelectableItems.value, lastAnchorIndex.value, target)
      if (selected) {
        box.selectedFileIds.value = selected.fileIds
        selectedTrashFolderIds.value = new Set([...selected.folderIds].map(id => Number(id)))
        box.selectedFolderIds.value = new Set()
        selectModeForced.value = true
        return
      }
    }
    const ids = new Set(box.selectedFileIds.value)
    if (ids.has(file.id)) ids.delete(file.id); else ids.add(file.id)
    box.selectedFileIds.value = ids
    selectModeForced.value = true
    lastAnchorIndex.value = target
  }
  function handleTrashFolderClick(folder: TrashFolderMeta, event: MouseEvent) {
    if ((event.target as HTMLElement).closest('button')) return
    const target = flatSelectableItems.value.findIndex(item => item.type === 'folder' && item.id === folder.id)
    if (event.shiftKey && lastAnchorIndex.value >= 0 && target >= 0) {
      const selected = selectRange(flatSelectableItems.value, lastAnchorIndex.value, target)
      if (selected) {
        box.selectedFileIds.value = selected.fileIds
        selectedTrashFolderIds.value = new Set([...selected.folderIds].map(id => Number(id)))
        box.selectedFolderIds.value = new Set()
        selectModeForced.value = true
        return
      }
    }
    const next = new Set(selectedTrashFolderIds.value); if (next.has(folder.id)) next.delete(folder.id); else next.add(folder.id)
    selectedTrashFolderIds.value = next; selectModeForced.value = true; lastAnchorIndex.value = target
  }
  const allTrashSelected = computed(() => {
    const files = options.getFiles(); const folders = options.getTrashFolders()
    return files.length + folders.length > 0 && files.every(file => box.selectedFileIds.value.has(file.id)) && folders.every(folder => selectedTrashFolderIds.value.has(folder.id))
  })
  function toggleSelectAllTrash() { if (allTrashSelected.value) return clearSelection(); selectModeForced.value = true; box.selectedFileIds.value = new Set(options.getFiles().map(file => file.id)); selectedTrashFolderIds.value = new Set(options.getTrashFolders().map(folder => folder.id)) }
  function toggleSelectMode() {
    if (inSelectionMode.value) return clearSelection()
    // 离场窗口内重新进入：取消待清空定时器，保留用户刚做出的选择。
    if (exitTimer !== null) { clearTimeout(exitTimer); exitTimer = null; selectionExiting.value = false }
    selectModeForced.value = true
  }
  return { ...box, selectedIds: box.selectedFileIds, selectedFolderKeys: box.selectedFolderIds, selectedTrashFolderIds, previewFolderKeys: box.previewFolderIds, clearSelection, flatSelectableItems, inSelectionMode, selectModeForced, toggleSelectMode, toggleSelectAllTrash, allTrashSelected, handleFolderClick, handleFileClick, handleTrashFileClick, handleTrashFolderClick }
}
