import { ref, shallowRef } from 'vue'
import type { FileMeta } from '@/stores/filesCache'

/** 文件名与后缀分段编辑的共享状态；保存逻辑由具体文件区负责。 */
export function useInlineFileRenameState() {
  const renamingFileId = ref<number | null>(null)
  const renameText = ref('')
  const renameExtension = ref('')
  const editingFile = shallowRef<FileMeta | null>(null)

  function start(file: FileMeta) {
    editingFile.value = file
    renamingFileId.value = file.id
    renameText.value = file.displayName
    renameExtension.value = file.ext.toUpperCase() === 'FILE' ? '' : file.ext.toLowerCase()
  }

  function cancel() {
    editingFile.value = null
    renamingFileId.value = null
    renameText.value = ''
    renameExtension.value = ''
  }

  return { renamingFileId, renameText, renameExtension, editingFile, start, cancel }
}
