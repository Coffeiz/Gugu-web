import { ref } from 'vue'
import type { useClipboardStore } from '@/stores/clipboard'

export interface FilePasteDestination {
  folderId: number | null
  projectId: number | null
}

export interface FilePasteCoreOptions {
  clipboardStore: ReturnType<typeof useClipboardStore>
  getDestination: () => FilePasteDestination
  close?: () => void
  onCut: (fileIds: number[], folderIds: number[], destination: FilePasteDestination) => void | Promise<void>
  onCopy: (fileIds: number[], folderIds: number[], destination: FilePasteDestination) => void | Promise<void>
  onError?: (error: unknown) => void
}

/** 统一剪贴板粘贴入口；移动/复制的缓存与回滚策略由文件库和项目适配器注入。 */
export function useFilePasteCore(options: FilePasteCoreOptions) {
  const pasteBusy = ref(false)

  async function paste() {
    if (pasteBusy.value || !options.clipboardStore.hasContent()) return
    pasteBusy.value = true
    options.close?.()
    const fileIds = [...new Set(options.clipboardStore.fileIds)]
    const folderIds = [...new Set(options.clipboardStore.folderIds)]
    const destination = options.getDestination()
    try {
      if (options.clipboardStore.type === 'cut') {
        await options.onCut(fileIds, folderIds, destination)
      } else if (options.clipboardStore.type === 'copy') {
        await options.onCopy(fileIds, folderIds, destination)
      }
    } catch (error) {
      options.onError?.(error)
    } finally {
      pasteBusy.value = false
    }
  }

  return { pasteBusy, paste }
}

