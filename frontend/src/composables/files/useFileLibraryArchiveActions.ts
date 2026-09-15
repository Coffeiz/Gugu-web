import { ref, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { FileMeta, FolderMeta } from '@/stores/filesCache'
import { filesApi } from '@/services/api'
import type { FolderCard } from '@/utils/filesNav'
import { errorMessage, showAppError } from '@/composables/core/useAppToast'
import {
  archiveFormatForFile,
  archiveNameForFile,
  extractFolderNameForArchive,
  archiveScopeOfFile,
  archiveScopeOfFolder,
  isExtractableArchive,
} from './archive'

type ArchiveDialogMode = 'compress' | 'extract'

interface ArchiveDialogForm {
  name: string
}

export interface FileLibraryArchiveActionsOptions {
  cacheStore: {
    getFile(id: number): FileMeta | null
    getFolder(id: number): FolderMeta | null
    addFile(file: FileMeta): void
    refresh(): Promise<void>
  }
  selectedFileIds: Ref<Set<number>>
  selectedFolderKeys: Ref<Set<number | string>>
  getVisibleFolders: () => FolderCard[]
  clearSelection: () => void
  createExtractionGhost: (name: string) => () => void
}

export function useFileLibraryArchiveActions(options: FileLibraryArchiveActionsOptions) {
  const dialogOpen = ref(false)
  const mode = ref<ArchiveDialogMode>('compress')
  const busy = ref(false)
  const error = ref('')
  const success = ref('')
  const initialName = ref('')
  const selectedArchive = ref<FileMeta | null>(null)
  const { t } = useI18n()
  const extractable = isExtractableArchive

  function setDialog(nextMode: ArchiveDialogMode, name = '') {
    mode.value = nextMode
    error.value = ''
    success.value = ''
    initialName.value = name
    dialogOpen.value = true
  }

  function openCompressSelected() {
    const files = [...options.selectedFileIds.value]
      .map(id => options.cacheStore.getFile(id))
      .filter((file): file is FileMeta => file != null)
    const visibleFolders = options.getVisibleFolders().filter(folder => options.selectedFolderKeys.value.has(folder.id))
    const folderMetas = visibleFolders
      .filter(folder => folder.type === 'folder' && folder.folderId != null)
      .map(folder => options.cacheStore.getFolder(Number(folder.folderId)))
      .filter((folder): folder is FolderMeta => folder != null)

    if (files.length !== options.selectedFileIds.value.size
      || folderMetas.length !== options.selectedFolderKeys.value.size
      || (!files.length && !folderMetas.length)) {
      error.value = t('filesUi.archiveSelectionChanged')
      mode.value = 'compress'
      dialogOpen.value = true
      return
    }

    const scopes = [
      ...files.map(archiveScopeOfFile),
      ...folderMetas.map(archiveScopeOfFolder),
    ]
    if (scopes.some(scope => scope == null)) {
      error.value = t('filesUi.archiveUnsupportedSpace')
      mode.value = 'compress'
      dialogOpen.value = true
      return
    }
    const scope = scopes[0]!
    if (scopes.some(candidate => JSON.stringify(candidate) !== JSON.stringify(scope))) {
      error.value = t('filesUi.archiveCrossSpace')
      mode.value = 'compress'
      dialogOpen.value = true
      return
    }

    const parentIds = [
      ...files.map(file => file.folderId ?? null),
      ...folderMetas.map(folder => folder.parentId ?? null),
    ]
    if (parentIds.some(parentId => parentId !== parentIds[0])) {
      error.value = t('filesUi.archiveSameParent')
      mode.value = 'compress'
      dialogOpen.value = true
      return
    }
    const firstFile = files[0]
    const name = firstFile
      ? archiveNameForFile(firstFile)
      : folderMetas[0]?.name ?? ''
    setDialog('compress', name)
  }

  function extractFile(file: FileMeta) {
    if (!isExtractableArchive(file)) return
    const scope = archiveScopeOfFile(file)
    if (!scope) {
      mode.value = 'extract'
      error.value = t('filesUi.archiveUnsupportedSpace')
      dialogOpen.value = true
      return
    }
    selectedArchive.value = file
    setDialog('extract', extractFolderNameForArchive(file))
  }

  async function submit(form: ArchiveDialogForm) {
    if (busy.value || success.value) return
    const submittedMode = mode.value
    const name = form.name.trim()
    if (!name) {
      error.value = t(submittedMode === 'compress' ? 'filesUi.archiveInvalidName' : 'filesUi.archiveInvalidFolderName')
      return
    }
    busy.value = true
    error.value = ''
    let removeGhost: (() => void) | null = null
    try {
      if (submittedMode === 'compress') {
        const fileIds = [...options.selectedFileIds.value]
        const folderIds = options.getVisibleFolders()
          .filter(folder => options.selectedFolderKeys.value.has(folder.id) && folder.type === 'folder' && folder.folderId != null)
          .map(folder => Number(folder.folderId))
        const created = await filesApi.archive({
          fileIds,
          folderIds,
          name,
        })
        options.cacheStore.addFile(created as FileMeta)
        options.clearSelection()
        success.value = t('filesUi.archiveCreated', { name: `${created.displayName}.${created.ext}` })
      } else {
        const archive = selectedArchive.value
        if (!archive) throw new Error('压缩包已不可用，请重新打开解压操作。')
        removeGhost = options.createExtractionGhost(name)
        dialogOpen.value = false
        selectedArchive.value = null
        await filesApi.unarchive({
          fileId: archive.id,
          folderName: name,
          format: archiveFormatForFile(archive) ?? undefined,
        })
        await options.cacheStore.refresh()
      }
    } catch (cause) {
      if (submittedMode === 'extract') {
        dialogOpen.value = false
        selectedArchive.value = null
        showAppError(errorMessage(cause, t('filesUi.archiveFailed')))
      } else {
        error.value = cause instanceof Error ? cause.message : t('filesUi.archiveFailed')
      }
    } finally {
      removeGhost?.()
      busy.value = false
    }
  }

  function closeDialog() {
    if (busy.value) return
    dialogOpen.value = false
    error.value = ''
    success.value = ''
    selectedArchive.value = null
  }

  return {
    dialogOpen,
    mode,
    busy,
    error,
    success,
    initialName,
    extractable,
    openCompressSelected,
    extractFile,
    submit,
    closeDialog,
  }
}
