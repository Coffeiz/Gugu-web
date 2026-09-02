import type { Ref } from 'vue'
import { useProjectStore } from '@/stores/projects'
import { useFilesCacheStore } from '@/stores/filesCache'
import type { Project, ProjectStage } from '@/types/project'
import { calculateStageProgress } from '@/composables/projects/useProjectProgress'
import { confirmDialog } from '@/composables/core/useConfirmDialog'
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
  const projectStore = useProjectStore()
  const fileCacheStore = useFilesCacheStore()
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

    const fileCount = fileCacheStore.loaded
      ? fileCacheStore.allFiles.filter(file => file.projectId === current.id).length
      : (current.fileCount || 0)
    const folderCount = fileCacheStore.loaded
      ? fileCacheStore.allFolders.filter(folder => folder.projectId === current.id).length
      : 0

    const parts = []
    if (fileCount) parts.push(i18n.global.t('projects.fileCount', { count: fileCount }))
    if (folderCount) parts.push(i18n.global.t('projects.folderCount', { count: folderCount }))
    const message = parts.length
      ? i18n.global.t('projects.deleteContentsMessage', { name: current.name, contents: parts.join(i18n.global.t('projects.countSeparator')) })
      : i18n.global.t('projects.deleteMessage', { name: current.name })
    if (!await confirmDialog({
      title: i18n.global.t('projects.deleteTitle'),
      message,
      tone: 'danger',
      confirmText: i18n.global.t('projects.deleteConfirm'),
    })) return

    await projectStore.deleteProject(current.id)
    if (fileCount + folderCount > 0) fileCacheStore.refresh()
    close()
  }

  async function handleArchive() {
    const current = project()
    if (!current) return
    await projectStore.archiveProject(current.id)
    close()
  }

  return { saveName, cancelName, setColor, cycleStatus, saveStages, saveTodos, handleDelete, handleArchive }
}
