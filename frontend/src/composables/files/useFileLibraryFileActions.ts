import type { Ref } from 'vue'
import type { FileMeta } from '@/stores/filesCache'
import { useFilesCacheStore } from '@/stores/filesCache'
import { useFileActions } from '@/composables/files/useFileActions'
import { InteractionSync } from '@/interaction/sync/InteractionSync'
import { confirmFileDeletion } from './useFileDeleteConfirm'

interface FileActionsOptions {
  cacheStore: ReturnType<typeof useFilesCacheStore>
  fileActions: ReturnType<typeof useFileActions>
  selectedIds: Ref<Set<number>>
  loadContents: () => void
  fetchStorage: () => void | Promise<void>
}

/** 文件库单文件动作适配；项目文件区保留自己的项目缓存和刷新策略。 */
export function useFileLibraryFileActions(options: FileActionsOptions) {
  const { cacheStore, fileActions, selectedIds, loadContents, fetchStorage } = options

  async function downloadFile(file: FileMeta) {
    try {
      await fileActions.downloadFile(file)
    } catch (error) {
      console.error('[Files] 下载失败:', (error as Error).message)
    }
  }

  async function deleteSingleFile(file: FileMeta) {
    if (!await confirmFileDeletion('file', { name: file.displayName })) return
    const backup = cacheStore.getFile(file.id)
    await InteractionSync.execute({
      scope: 'file.delete', entityKey: `file:${file.id}`,
      apply: () => {
        cacheStore.removeFile(file.id)
        selectedIds.value = new Set([...selectedIds.value].filter(id => id !== file.id))
      },
      afterMutate: loadContents,
      request: mutation => fileActions.deleteFile(file.id, { mutationId: mutation.mutationId }),
      onCommit: fetchStorage,
      rollback: () => { if (backup) cacheStore.addFile(backup) },
      onError: error => console.error('[Files] 删除失败:', (error as Error).message),
    })
  }

  return { downloadFile, deleteSingleFile }
}
