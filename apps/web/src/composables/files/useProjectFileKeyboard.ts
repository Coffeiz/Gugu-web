import { onMounted, onUnmounted, type Ref } from 'vue'

type ClipboardLike = {
  cut: (fileIds: number[], folderIds: number[]) => void
  copy: (fileIds: number[], folderIds: number[]) => void
  hasContent: () => boolean
}

interface ProjectFileKeyboardOptions {
  isProjectOpen: () => boolean
  selectedFileIds: Ref<Set<number>>
  selectedFolderIds: Ref<Set<number>>
  clipboardStore: ClipboardLike
  paste: () => void
}

/** 项目文件面板的键盘快捷键，避免常驻的项目弹窗把全局事件逻辑留在视图组件中。 */
export function useProjectFileKeyboard(options: ProjectFileKeyboardOptions) {
  function onKeyDown(event: KeyboardEvent) {
    if (!options.isProjectOpen()) return
    const tag = (event.target as HTMLElement | null)?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA') return

    const hasModifier = event.ctrlKey || event.metaKey
    if (hasModifier && event.key === 'x') {
      const fileIds = [...options.selectedFileIds.value]
      const folderIds = [...options.selectedFolderIds.value]
      if (fileIds.length || folderIds.length) {
        options.clipboardStore.cut(fileIds, folderIds)
        event.preventDefault()
        event.stopImmediatePropagation()
      }
    } else if (hasModifier && event.key === 'c') {
      const fileIds = [...options.selectedFileIds.value]
      if (fileIds.length) {
        options.clipboardStore.copy(fileIds, [])
        event.preventDefault()
        event.stopImmediatePropagation()
      }
    } else if (hasModifier && event.key === 'v' && options.clipboardStore.hasContent()) {
      options.paste()
      event.preventDefault()
      event.stopImmediatePropagation()
    }
  }

  onMounted(() => document.addEventListener('keydown', onKeyDown, true))
  onUnmounted(() => document.removeEventListener('keydown', onKeyDown, true))
}
