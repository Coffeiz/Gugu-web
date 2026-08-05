import { useFileContextMenu } from './useFileContextMenu'

export type FileLibraryContextType = 'file' | 'multi-file' | 'folder' | 'empty'

export interface FileLibraryContextActionsOptions<TTarget extends { id?: string | number }> {
  selectedFileIds: { value: Set<number> }
  selectedFolderKeys: { value: Set<string | number> }
  actions: Record<string, () => unknown>
}

/** 文件库右键目标判定与动作分发；具体文件副作用由页面回调注入。 */
export function useFileLibraryContextActions<TTarget extends { id?: string | number }>(options: FileLibraryContextActionsOptions<TTarget>) {
  const { state, open, close } = useFileContextMenu<FileLibraryContextType, TTarget>()

  function openContext(type: Exclude<FileLibraryContextType, 'multi-file'>, target: TTarget | null, event: MouseEvent) {
    const targetId = target?.id
    const isSelectedFile = typeof targetId === 'number' && options.selectedFileIds.value.has(targetId)
    const isMulti = type === 'file' && target != null &&
      (isSelectedFile || options.selectedFolderKeys.value.size > 0) &&
      options.selectedFileIds.value.size + options.selectedFolderKeys.value.size > 1
    open(isMulti ? 'multi-file' : type, target, event)
  }

  function handleAction(action: string) {
    options.actions[action]?.()
  }

  return { state, close, openContext, handleAction }
}
