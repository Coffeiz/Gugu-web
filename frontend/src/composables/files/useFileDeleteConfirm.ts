import { confirmDialog } from '@/composables/useConfirmDialog'
import { i18n } from '@/i18n'

type DeleteConfirmKind = 'file' | 'folder' | 'selected' | 'permanent-file' | 'permanent-folder' | 'permanent-selected'

const keys: Record<DeleteConfirmKind, { title: string; message: string }> = {
  file: { title: 'filesViewUi.deleteFileTitle', message: 'filesViewUi.deleteFileMessage' },
  folder: { title: 'filesViewUi.deleteFolderTitle', message: 'filesViewUi.deleteFolderMessage' },
  selected: { title: 'filesViewUi.deleteSelectedTitle', message: 'filesViewUi.deleteSelectedMessage' },
  'permanent-file': { title: 'filesViewUi.permanentDeleteFileTitle', message: 'filesViewUi.permanentDeleteFileMessage' },
  'permanent-folder': { title: 'filesViewUi.permanentDeleteFolderTitle', message: 'filesViewUi.permanentDeleteFolderMessage' },
  'permanent-selected': { title: 'filesViewUi.permanentDeleteSelectedTitle', message: 'filesViewUi.permanentDeleteSelectedMessage' },
}

export function confirmFileDeletion(kind: DeleteConfirmKind, params: Record<string, unknown> = {}) {
  const copy = keys[kind]
  return confirmDialog({
    title: i18n.global.t(copy.title, params),
    message: i18n.global.t(copy.message, params),
    tone: 'danger',
    confirmText: i18n.global.t(kind.startsWith('permanent') ? 'filesViewUi.permanentDelete' : 'filesViewUi.moveToTrash'),
  })
}
