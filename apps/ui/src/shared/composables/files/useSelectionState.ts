import type { Ref } from 'vue'

export interface SelectionState<F = number> {
  fileIds: Ref<Set<number>>
  folderIds: Ref<Set<F>>
}

export interface SelectableItem<F = number> {
  type: 'file' | 'folder'
  id: number | F
}

export function selectRange<F>(
  items: SelectableItem<F>[],
  anchorIndex: number,
  targetIndex: number,
): { fileIds: Set<number>; folderIds: Set<F> } | null {
  if (anchorIndex < 0 || targetIndex < 0 || anchorIndex >= items.length || targetIndex >= items.length) return null
  const [start, end] = anchorIndex <= targetIndex
    ? [anchorIndex, targetIndex]
    : [targetIndex, anchorIndex]
  const fileIds = new Set<number>()
  const folderIds = new Set<F>()
  for (const item of items.slice(start, end + 1)) {
    if (item.type === 'file') fileIds.add(item.id as number)
    else folderIds.add(item.id as F)
  }
  return { fileIds, folderIds }
}

/** Shift 范围选择成功时保留初始锚点；没有锚点时才用当前目标建立锚点。 */
export function resolveSelectionAnchor(currentAnchor: number, targetIndex: number, isRangeSelection: boolean) {
  return isRangeSelection && currentAnchor >= 0 ? currentAnchor : targetIndex
}

/** 文件选择协调器使用的基础集合操作，不负责 DOM 框选和页面导航。 */
export function useSelectionState<F = number>(state: SelectionState<F>) {
  function replaceSelection(fileIds: Set<number>, folderIds: Set<F>) {
    state.fileIds.value = fileIds
    state.folderIds.value = folderIds
  }

  function selectRangeIn(items: SelectableItem<F>[], anchorIndex: number, targetIndex: number) {
    const selected = selectRange(items, anchorIndex, targetIndex)
    if (!selected) return false
    replaceSelection(selected.fileIds, selected.folderIds)
    return true
  }

  function clearSelection() {
    state.fileIds.value = new Set()
    state.folderIds.value = new Set()
  }

  function toggleFile(id: number) {
    const next = new Set(state.fileIds.value)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    state.fileIds.value = next
  }

  function toggleFolder(id: F) {
    const next = new Set(state.folderIds.value)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    state.folderIds.value = next
  }

  function selectOnlyFile(id: number) {
    state.fileIds.value = new Set([id])
    state.folderIds.value = new Set()
  }

  function selectOnlyFolder(id: F) {
    state.fileIds.value = new Set()
    state.folderIds.value = new Set([id])
  }

  function toggleExclusiveFile(id: number) {
    if (state.fileIds.value.size === 1 && state.fileIds.value.has(id) && state.folderIds.value.size === 0) {
      clearSelection()
      return
    }
    selectOnlyFile(id)
  }

  function toggleExclusiveFolder(id: F) {
    if (state.folderIds.value.size === 1 && state.folderIds.value.has(id) && state.fileIds.value.size === 0) {
      clearSelection()
      return
    }
    selectOnlyFolder(id)
  }

  return {
    clearSelection,
    replaceSelection,
    selectRangeIn,
    toggleFile,
    toggleFolder,
    selectOnlyFile,
    selectOnlyFolder,
    toggleExclusiveFile,
    toggleExclusiveFolder,
  }
}
