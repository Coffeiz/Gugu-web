import { nextTick, ref } from 'vue'
import type { FileMeta, FolderMeta } from '@/stores/filesCache'

interface RenameOptions {
  getFile: (id: number) => FileMeta | null | undefined
  getFolder: (id: number) => FolderMeta | null | undefined
  updateFile: (id: number, patch: Partial<FileMeta>) => void
  updateFolder: (id: number, patch: Partial<FolderMeta>) => void
  renameFile: (id: number, name: string) => void | Promise<unknown>
  renameFolder: (id: number, name: string, version: number) => Promise<{ version: number }>
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
      options.updateFile(fileId, { displayName: name })
      options.reload()
      try {
        await options.renameFile(fileId, name)
      } catch (error) {
        if (oldName != null) options.updateFile(fileId, { displayName: oldName })
        options.reload()
        options.onError?.('file', error)
      }
      return
    }

    const folder = options.getFolder(folderId as number)
    const oldName = folder?.name
    const version = folder?.version ?? 1
    options.updateFolder(folderId as number, { name })
    options.reload()
    try {
      const updated = await options.renameFolder(folderId as number, name, version)
      options.updateFolder(folderId as number, { version: updated.version })
    } catch (error) {
      if (oldName != null) options.updateFolder(folderId as number, { name: oldName })
      options.reload()
      options.onError?.('folder', error)
    }
  }

  return { renamingFileId, renamingFolderKey, renameText, startFile, startFolder, cancel, commit }
}
