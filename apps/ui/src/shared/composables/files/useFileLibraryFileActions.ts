import type { Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { FileMeta } from '@/stores/filesCache'
import { useFilesCacheStore } from '@/stores/filesCache'
import { useFileActions } from '@/composables/files/useFileActions'
import { InteractionSync } from '@/interaction/sync/InteractionSync'
import { showAppError } from '@/composables/core/useAppToast'
import { confirmFileDeletion } from './useFileDeleteConfirm'

interface FileActionsOptions {
  cacheStore: ReturnType<typeof useFilesCacheStore>
  fileActions: ReturnType<typeof useFileActions>
  selectedIds: Ref<Set<number>>
  loadContents: () => void
  removeFilesFromSnapshots: (fileIds: number[]) => void
  fetchStorage: () => void | Promise<void>
}

/** 文件库单文件动作适配；项目文件区保留自己的项目缓存和刷新策略。 */
export function useFileLibraryFileActions(options: FileActionsOptions) {
  const { cacheStore, fileActions, selectedIds, loadContents, removeFilesFromSnapshots, fetchStorage } = options
  const { t } = useI18n()

  async function downloadFile(file: FileMeta) {
    try {
      await fileActions.downloadFile(file)
    } catch (error) {
      console.error('[Files] 下载失败:', (error as Error).message)
      showAppError(t('filesUi.downloadFailed'))
    }
  }

  async function deleteSingleFile(file: FileMeta) {
    if (!await confirmFileDeletion('file', { name: file.displayName })) return
    await InteractionSync.execute({
      scope: 'file.delete', entityKey: `file:${file.id}`,
      apply: () => {},
      request: mutation => fileActions.deleteFile(file.id, { mutationId: mutation.mutationId }),
      onCommit: () => {
        cacheStore.removeFile(file.id)
        removeFilesFromSnapshots([file.id])
        selectedIds.value = new Set([...selectedIds.value].filter(id => id !== file.id))
        // 请求成功后再刷新，避免预提交快照重显，也避免乐观消失后回跳。
        loadContents()
        void fetchStorage()
      },
      rollback: () => {},
      onError: error => {
        console.error('[Files] 删除失败:', (error as Error).message)
        loadContents()
      },
    })
  }

  return { downloadFile, deleteSingleFile }
}
