<template>
  <div class="projects-page">
    <div class="kanban">
      <KanbanColumn
        v-for="col in nonDoneColumns"
        :key="col.key"
        :column="col"
        :projects="columnProjects(col.key)"
        :is-project-detached="isProjectDetached"
        @card-click="projectStore.openModal"
        @add-project="openNewWithStatus"
      />
      <DoneColumn
        :projects="columnProjects('done')"
        :ownership-version-for="ownershipVersion"
        :is-project-detached="isProjectDetached"
        @card-click="projectStore.openModal"
        @open-archived="showArchived = true"
        @open-deleted="showDeleted = true"
      />
    </div>

    <ArchivedProjectsModal :show="showArchived" @close="showArchived = false" />
    <ArchivedProjectsModal :show="showDeleted" mode="deleted" @close="showDeleted = false" />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { runtime, type MoveAction } from '@/interaction/runtime'
import { useRuntimeAction } from '@/interaction/runtime/vue'
import { showAppError } from '@/composables/core/useAppToast'
import { useProjectStore } from '@/stores/projects'
import { useUiStore } from '@/stores/ui'
import { useLiveStore } from '@/stores/live'
import { useProjectColumnViews } from '@/composables/projects/useProjectColumnViews'
import { useProjectFileCounts } from '@/composables/projects/useProjectFileCounts'
import { useProjectCollectionModals } from '@/composables/projects/useProjectCollectionModals'
import type { Project } from '@/types/project'
import { projectIdFromRuntimeObjectId } from '@/utils/projectDrop'
import KanbanColumn from './components/KanbanColumn.vue'
import DoneColumn   from './components/DoneColumn.vue'
import ArchivedProjectsModal from './components/ArchivedProjectsModal.vue'

const projectStore = useProjectStore()
const uiStore      = useUiStore()
const liveStore = useLiveStore()
const { showArchived, showDeleted } = useProjectCollectionModals({
  loadArchived: projectStore.fetchArchivedProjects,
  loadDeleted: projectStore.fetchDeletedProjects,
})
const { counts: liveFileCounts, refresh: refreshProjectFileCounts } = useProjectFileCounts(
  computed(() => liveStore.rev.files),
)
const ownershipRevisions = reactive(new Map<string, number>())
const controlledProjectIds = reactive(new Set<string>())
const stopOwnershipSubscription = runtime.onOwnershipChange((objectId) => {
  const projectId = String(objectId)
  ownershipRevisions.set(projectId, (ownershipRevisions.get(projectId) ?? 0) + 1)
  if (runtime.isControlled(projectId)) controlledProjectIds.add(projectId)
  else controlledProjectIds.delete(projectId)
})

function isProjectDetached(projectId: string): boolean {
  return controlledProjectIds.has(projectId)
}

function ownershipVersion(projects: Project[]): number {
  let revision = 0
  for (const project of projects) revision = (revision * 31 + (ownershipRevisions.get(String(project.id)) ?? 0)) >>> 0
  return revision
}

watch(() => projectStore.error, (message) => {
  if (!message) return
  showAppError(message)
})
onMounted(() => {
  // 看板只需要项目文件计数；不要为此下载完整文件/文件夹清单。
  void refreshProjectFileCounts()
})

useRuntimeAction(action => {
  if (action.type !== 'move') return
  const move = action as MoveAction
  const object = runtime.objects.get(move.objectId)
  const projectSurfaces = new Set(['pending', 'active', 'done'])
  if (object?.type !== 'project-card') return
  if (!projectSurfaces.has(move.fromSurfaceId) || !projectSurfaces.has(move.toSurfaceId)) return
  const projectId = projectIdFromRuntimeObjectId(move.objectId)
  if (projectId == null || move.fromSurfaceId === move.toSurfaceId) return
  if (!projectStore.projects.some(project => project.id === projectId)) return
  void projectStore.moveProject(projectId, move.toSurfaceId)
})
let projectFlashRequest = 0
let projectFlashTimer: ReturnType<typeof setTimeout> | null = null
let activeProjectFlashElement: HTMLElement | null = null

function clearProjectFlash() {
  if (projectFlashTimer) clearTimeout(projectFlashTimer)
  projectFlashTimer = null
  if (activeProjectFlashElement) {
    activeProjectFlashElement.classList.remove('search-highlight')
    activeProjectFlashElement.style.animationDuration = ''
  }
  activeProjectFlashElement = null
}

onUnmounted(() => {
  stopOwnershipSubscription()
  projectFlashRequest++
  clearProjectFlash()
})

// 全局搜索点击项目 → 跳转本页后高亮对应项目卡（不打开编辑弹窗）
watch(() => uiStore.pendingProjectHighlight, (id) => {
  if (id == null) return
  const ms  = uiStore.pendingProjectHighlightMs || 1800
  uiStore.pendingProjectHighlight = null
  uiStore.pendingProjectHighlightMs = null
  _flashProject(id, ms, 'search-highlight')
}, { immediate: true })

function _flashProject(id, ms = 1800, cls = 'search-highlight') {
  const request = ++projectFlashRequest
  clearProjectFlash()
  let attempts = 0
  const findElement = () => {
    if (request !== projectFlashRequest) return
    const el = document.querySelector<HTMLElement>(`[data-project-id="${id}"]`)
    if (!el) {
      if (attempts++ >= 30) return
      projectFlashTimer = setTimeout(findElement, 50)
      return
    }
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el.style.animationDuration = ms + 'ms'
    el.classList.add(cls)
    activeProjectFlashElement = el
    projectFlashTimer = setTimeout(() => {
      if (request !== projectFlashRequest) return
      el.classList.remove(cls)
      el.style.animationDuration = ''
      activeProjectFlashElement = null
      projectFlashTimer = null
    }, ms)
  }
  projectFlashTimer = setTimeout(findElement, 50)
}

const nonDoneColumns = computed(() =>
  projectStore.kanbanColumns.filter(c => c.key !== 'done')
)

const { columnProjects } = useProjectColumnViews({
  projects: computed(() => projectStore.projects),
  liveFileCounts: computed(() => liveFileCounts.value),
})

function openNewWithStatus(status) {
  uiStore.newProjectInitStatus = status ?? null
  uiStore.openNewProject = true
}
</script>

<style scoped>
.projects-page {
  height: calc(100vh - 152px);
}

.kanban {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
  height: 100%;
  align-items: stretch;
}
</style>
