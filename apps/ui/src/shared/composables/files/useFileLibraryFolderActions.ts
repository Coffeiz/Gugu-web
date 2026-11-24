import { ref, type Ref } from 'vue'
import type { PathFileRef } from '@/services/api'
import { usePathFileAccess } from '@/services/pathFileAccess'
import { errorMessage, showAppError } from '@/composables/core/useAppToast'
import { useI18n } from 'vue-i18n'

interface FolderActionsOptions {
  pathTarget: Readonly<Ref<PathFileRef | null>>
  reloadWorkspace: () => void
}

/** 文件库路径目录的新建操作。目录身份只使用目录范围与相对路径。 */
export function useFileLibraryFolderActions(options: FolderActionsOptions) {
  const pathFilesApi = usePathFileAccess()
  const { t } = useI18n()
  const newFolderName = ref('')
  const newFolderLoading = ref(false)
  const showNewFolderInput = ref(false)

  async function createFolder() {
    const name = newFolderName.value.trim()
    const target = options.pathTarget.value
    if (!name || !target || newFolderLoading.value) return

    newFolderLoading.value = true
    try {
      if (/[\/\\]/.test(name)) throw new Error(t('projects.invalidName'))
      await pathFilesApi.createFolder({
        directoryId: target.directoryId,
        relativePath: [target.relativePath, name].filter(Boolean).join('/'),
      })
      newFolderName.value = ''
      showNewFolderInput.value = false
      options.reloadWorkspace()
    } catch (error) {
      showAppError(errorMessage(error))
    } finally {
      newFolderLoading.value = false
    }
  }

  return { newFolderName, newFolderLoading, showNewFolderInput, createFolder }
}
