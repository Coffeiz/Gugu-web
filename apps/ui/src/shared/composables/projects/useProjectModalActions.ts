import { useProjectAccess } from '@/api/projects'
import type { Ref } from 'vue'
import { useProjectStore } from '@/stores/projects'
import type { Project, ProjectStage } from '@/types/project'
import { calculateStageProgress } from '@/composables/projects/useProjectProgress'
import { confirmDialog } from '@/composables/core/useConfirmDialog'
import { showAppError } from '@/composables/core/useAppToast'
import { i18n } from '@/i18n'

interface ProjectModalActionsOptions {
  project: () => Project | null
  localName: Ref<string>
  localColor: Ref<string>
  localStatus: Ref<string>
  localStages: Ref<ProjectStage[]>
  localCurrentStage: Ref<string>
  close: () => void
}

/** 项目编辑卡的项目级动作；文件区动作继续由文件 composable 负责。 */
export function useProjectModalActions(options: ProjectModalActionsOptions) {
  const desktop = useProjectAccess().storesProjectsLocally
  const projectStore = useProjectStore()
  const { project, localName, localColor, localStatus, localStages, localCurrentStage, close } = options

  function saveName() {
    const current = project()
    if (!current) return
    const name = localName.value.trim()
    if (!name) {
      localName.value = current.name
    } else if (name !== current.name) {
      localName.value = name
      projectStore.updateProject(current.id, { name })
    }
  }

  function cancelName() {
    const current = project()
    if (current) localName.value = current.name
  }

  function setColor(color: string) {
    localColor.value = color
    const current = project()
    if (current) projectStore.updateProject(current.id, { color })
  }

  function cycleStatus() {
    const columns = projectStore.kanbanColumns
    const index = columns.findIndex(column => column.key === localStatus.value)
    const next = columns[(index + 1) % columns.length].key
    localStatus.value = next
    const current = project()
    if (current) projectStore.moveProject(current.id, next)
  }

  function saveStages() {
    const current = project()
    if (current) projectStore.updateStages(current.id, localStages.value)
  }

  function saveTodos() {
    const current = project()
    if (!current) return
    const progress = calculateStageProgress(localStages.value, localCurrentStage.value)
    projectStore.saveTodos(current.id, localStages.value, progress)
  }

  async function handleDelete() {
    const current = project()
    if (!current) return

    const message = i18n.global.t(desktop ? 'projects.desktopTrashMessage' : 'projects.deleteContentsMessage', { name: current.name })
    if (!await confirmDialog({
      title: i18n.global.t('projects.deleteTitle'),
      message,
      tone: 'danger',
      confirmText: i18n.global.t('projects.deleteConfirm'),
    })) return

    try {
      await projectStore.deleteProject(current.id)
      close()
    } catch (error) {
      showAppError(error instanceof Error ? error.message : String(error))
    }
  }

  async function handleArchive() {
    const current = project()
    if (!current) return
    try {
      await projectStore.archiveProject(current.id)
      close()
    } catch (error) {
      showAppError(error instanceof Error ? error.message : String(error))
    }
  }

  return { saveName, cancelName, setColor, cycleStatus, saveStages, saveTodos, handleDelete, handleArchive }
}
