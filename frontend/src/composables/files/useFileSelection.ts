import type { Ref } from 'vue'

export interface FileSelectionState<F = number> {
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

/** 收口文件浏览页共用的基础集合操作；框选和 Shift 范围仍由页面编排。 */
export function useFileSelection<F = number>(state: FileSelectionState<F>) {
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

  return { clearSelection, toggleFile, toggleFolder }
}
