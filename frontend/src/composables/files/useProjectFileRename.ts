import { nextTick, ref } from 'vue'
import type { FileMeta, FolderMeta } from '@/stores/filesCache'
import { normalizeEditableExtension } from '@/utils/fileTypes'
import { useInlineFileRenameState } from './useInlineFileRenameState'

/** 文件/文件夹内联重命名状态；网络写入由调用方提供，便于不同场景复用。 */
export function useProjectFileRename(options: {
  renameFile: (id: number, name: string, extension?: string) => void | Promise<void>
  renameFolder: (id: number, name: string) => void | Promise<void>
  onInvalidExtension?: () => void
}) {
  const fileRename = useInlineFileRenameState()
  const { renamingFileId, renameText, renameExtension, editingFile } = fileRename
  const renamingFolderId = ref<number | null>(null)
  const folderRenameText = ref('')

  function startRename(file: FileMeta) { fileRename.start(file) }
  function cancelRename() { fileRename.cancel() }
  function commitRename() {
    const id = renamingFileId.value; const name = renameText.value.trim()
    const file = editingFile.value
    const normalizedExtension = normalizeEditableExtension(renameExtension.value)
    if (id != null && (normalizedExtension == null || (!normalizedExtension && file?.ext.toUpperCase() !== 'FILE'))) {
      options.onInvalidExtension?.()
      nextTick(() => document.querySelector<HTMLInputElement>('.rename-file-extension-input')?.focus())
      return
    }
    const extension = normalizedExtension || undefined
    if (id == null || !name) { cancelRename(); return }
    if (file?.displayName === name && (extension ?? file.ext) === file.ext) { cancelRename(); return }
    void options.renameFile(id, name, extension)
    cancelRename()
  }
  function startRenameFolder(folder: FolderMeta) { renamingFolderId.value = folder.id; folderRenameText.value = folder.name }
  function cancelFolderRename() { renamingFolderId.value = null; folderRenameText.value = '' }
  function commitFolderRename() {
    const id = renamingFolderId.value; const name = folderRenameText.value.trim()
    renamingFolderId.value = null
    if (!id || !name) return
    void options.renameFolder(id, name)
    folderRenameText.value = ''
  }

  return { renamingFileId, renameText, renameExtension, startRename, cancelRename, commitRename, renamingFolderId, folderRenameText, startRenameFolder, cancelFolderRename, commitFolderRename }
}
