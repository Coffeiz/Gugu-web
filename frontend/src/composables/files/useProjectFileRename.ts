import { nextTick, ref } from 'vue'
import type { FileMeta, FolderMeta } from '@/stores/filesCache'

/** 文件/文件夹内联重命名状态；网络写入由调用方提供，便于不同场景复用。 */
export function useProjectFileRename(options: {
  renameFile: (id: number, name: string) => void | Promise<void>
  renameFolder: (id: number, name: string) => void | Promise<void>
}) {
  const renamingFileId = ref<number | null>(null)
  const renameText = ref('')
  const renamingFolderId = ref<number | null>(null)
  const folderRenameText = ref('')

  function focusRenameInput() {
    nextTick(() => {
      const input = document.querySelector<HTMLInputElement>('.rename-input-inline')
      input?.focus()
      input?.select()
    })
  }
  function startRename(file: FileMeta) { renamingFileId.value = file.id; renameText.value = file.displayName; focusRenameInput() }
  function cancelRename() { renamingFileId.value = null; renameText.value = '' }
  function commitRename() {
    const id = renamingFileId.value; const name = renameText.value.trim()
    renamingFileId.value = null
    if (!id || !name) return
    void options.renameFile(id, name)
    renameText.value = ''
  }
  function startRenameFolder(folder: FolderMeta) { renamingFolderId.value = folder.id; folderRenameText.value = folder.name; focusRenameInput() }
  function cancelFolderRename() { renamingFolderId.value = null; folderRenameText.value = '' }
  function commitFolderRename() {
    const id = renamingFolderId.value; const name = folderRenameText.value.trim()
    renamingFolderId.value = null
    if (!id || !name) return
    void options.renameFolder(id, name)
    folderRenameText.value = ''
  }

  return { renamingFileId, renameText, startRename, cancelRename, commitRename, renamingFolderId, folderRenameText, startRenameFolder, cancelFolderRename, commitFolderRename }
}
