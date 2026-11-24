import { computed, onMounted, ref, shallowRef } from 'vue'
import type { DesktopFileDirectory, DesktopFileWorkspace } from '@gugu/core/desktop'
import { i18n } from '@/i18n'
import { requestDesktopFile } from '@desktop/bridge/bridge'
import { confirmDialog } from '@/composables/core/useConfirmDialog'
import { usePreviewStore } from '@/stores/preview'
import { errorMessage, showAppError } from '@/composables/core/useAppToast'

export const desktopWorkspaceRelinked = shallowRef<{ id: DesktopFileDirectory }>()

export async function pickDesktopWorkspace() {
  const { id } = await requestDesktopFile({ action: 'workspace-add' }) as { id: `desktop:${string}` | null }
  return id
}

export function useDesktopWorkspaces() {
  const t = i18n.global.t
  const preview = usePreviewStore()
  const native = 'guguDesktop' in window
  const workspaces = ref<DesktopFileWorkspace[]>([])
  const busy = ref(false)
  const options = computed(() => [
    { value: 'personal' as const, label: t('filesUi.personalFiles') },
    ...workspaces.value.filter(item => item.id !== 'personal').map(item => ({ value: item.id, label: item.name })),
  ])

  async function refresh() {
    workspaces.value = await requestDesktopFile({ action: 'workspace-list' }) as DesktopFileWorkspace[]
  }

  onMounted(() => { void refresh().catch(error => showAppError(errorMessage(error))) })

  async function manage<T>(operation: () => Promise<T>) {
    if (busy.value) return false
    busy.value = true
    try {
      return await operation()
    } catch (error) {
      showAppError(errorMessage(error))
      return false
    } finally {
      busy.value = false
    }
  }

  function closeWorkspacePreviews(id: DesktopFileDirectory) {
    if (preview.singleFile?.workspaceFile?.directoryId === id) preview.close()
    for (const window of preview.windows) {
      if (window.file.workspaceFile?.directoryId === id) preview.closeWindow(window.id)
    }
  }

  function pick(id?: DesktopFileDirectory) {
    return manage(async () => {
      const picked = id
        ? (await requestDesktopFile({ action: 'workspace-relink', directoryId: id }) as { id: DesktopFileDirectory | null }).id
        : await pickDesktopWorkspace()
      if (!picked) return false
      if (id) {
        closeWorkspacePreviews(id)
        desktopWorkspaceRelinked.value = { id }
      }
      await refresh()
      return picked
    })
  }

  function rename(id: DesktopFileDirectory, name: string) {
    return manage(async () => {
      await requestDesktopFile({ action: 'workspace-rename', directoryId: id, name })
      await refresh()
      return true
    })
  }

  function remove(id: DesktopFileDirectory) {
    const name = workspaces.value.find(item => item.id === id)?.name
    if (!name) return
    return manage(async () => {
      if (!await confirmDialog({
        title: t('filesUi.unbindDesktopWorkspace'),
        message: t('filesUi.unbindDesktopWorkspaceMessage', { name }),
        confirmText: t('filesUi.unbindDesktopWorkspace'),
        tone: 'danger',
      })) return
      await requestDesktopFile({ action: 'workspace-remove', directoryId: id })
      closeWorkspacePreviews(id)
      await refresh()
      return true
    })
  }

  return { native, busy, options, pick, rename, remove }
}
