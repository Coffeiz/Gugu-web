import { nextTick, ref } from 'vue'
import type { FileMeta, FolderMeta } from '@/stores/filesCache'
import type { RequestMeta } from '@/services/api'
import { InteractionSync } from '@/interaction/sync/InteractionSync'

interface RenameOptions {
  getFile: (id: number) => FileMeta | null | undefined
  getFolder: (id: number) => FolderMeta | null | undefined
  updateFile: (id: number, patch: Partial<FileMeta>) => void
  updateFolder: (id: number, patch: Partial<FolderMeta>) => void
  renameFile: (id: number, name: string, meta?: RequestMeta) => void | Promise<unknown>
  renameFolder: (id: number, name: string, version: number, meta?: RequestMeta) => Promise<{ version: number }>
  reload: () => void
  onError?: (scope: 'file' | 'folder', error: unknown) => void
}

/** 文件库文件/文件夹内联重命名状态与乐观更新。页面只注入缓存和 API。 */
export function useFileLibraryRename(options: RenameOptions) {
  const renamingFileId = ref<number | null>(null)
  const renamingFolderKey = ref<number | null>(null)
  const renameText = ref('')

  function focusInput() {
    nextTick(() => document.querySelector<HTMLInputElement>('.rename-input-inline')?.select())
  }

  function startFile(file: FileMeta) {
    renamingFolderKey.value = null
    renamingFileId.value = file.id
    renameText.value = file.displayName
    focusInput()
  }

  function startFolder(folder: { folderId?: number | null; displayName: string }) {
    renamingFileId.value = null
    renamingFolderKey.value = folder.folderId ?? null
    renameText.value = folder.displayName
    focusInput()
  }

  function cancel() {
    renamingFileId.value = null
    renamingFolderKey.value = null
    renameText.value = ''
  }

  async function commit() {
    const fileId = renamingFileId.value
    const folderId = renamingFolderKey.value
    const name = renameText.value.trim()
    cancel()
    if (!name || (fileId == null && folderId == null)) return

    if (fileId != null) {
      const oldName = options.getFile(fileId)?.displayName
      try {
        await InteractionSync.execute({
          scope: 'file.rename', entityKey: `file:${fileId}`,
          apply: () => { options.updateFile(fileId, { displayName: name }); options.reload() },
          rollback: () => { if (oldName != null) options.updateFile(fileId, { displayName: oldName }); options.reload() },
          request: mutation => Promise.resolve(options.renameFile(fileId, name, { mutationId: mutation.mutationId })),
        })
      } catch (error) {
        options.onError?.('file', error)
      }
      return
    }

    const folder = options.getFolder(folderId as number)
    const oldName = folder?.name
    const version = folder?.version ?? 1
    try {
      await InteractionSync.execute({
        scope: 'folder.rename', entityKey: `folder:${folderId}`,
        apply: () => { options.updateFolder(folderId as number, { name }); options.reload() },
        rollback: () => { if (oldName != null) options.updateFolder(folderId as number, { name: oldName }); options.reload() },
        request: mutation => options.renameFolder(folderId as number, name, version, { mutationId: mutation.mutationId }),
        onCommit: updated => options.updateFolder(folderId as number, { version: updated.version }),
      })
    } catch (error) {
      options.onError?.('folder', error)
    }
  }

  return { renamingFileId, renamingFolderKey, renameText, startFile, startFolder, cancel, commit }
}
