import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import { projectsApi, eventsApi } from '@/services/api'
import { useLiveStore } from '@/stores/live'
import { mapProjectResponse, type Project, type ProjectStage, type ProjectStatus } from '@/types/project'
import {
  normalizeStages, transitionProjectStage, transitionProjectStatus, transitionProjectTodos,
} from '@/utils/projectStages'
import { DEFAULT_PROJECT_COLOR } from '@/utils/projectColors'
import type { components } from '@/types/api'
import { getAccountBoundaryEpoch } from '@/utils/accountBoundary'
import { InteractionSyncEventQueue } from '@/interaction/sync/InteractionSyncEventQueue'
import { InteractionSync } from '@/interaction/sync/InteractionSync'
import type { LiveEventPayload } from '@/types/live-events'

type EventResponse = components['schemas']['EventResponse']

// 新建项目表单草案：stages 允许字符串（只有名字）或 {label, todos} 对象，与 Project 的结构化 stage 不同。
interface ProjectDraft {
  name: string
  client?: string | null
  status?: string
  stages: Array<string | { label: string; todos?: ProjectStage['todos'] }>
  currentStageIdx?: number
  startDate?: string | null
  deadline?: string | null
  color?: string
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export const useProjectStore = defineStore('projects', () => {

  const kanbanColumns = [
    { key: 'pending', label: '待开始' },
    { key: 'active',  label: '进行中' },
    { key: 'done',    label: '已完成' },
  ]

  const projects = ref<Project[]>([])
  const loading  = ref(false)
  const error    = ref<string | null>(null)
  const projectsLoaded = ref(false)

  const archivedProjects = ref<Project[]>([])
  const archivedLoading  = ref(false)
  const archivedLoaded   = ref(false)
  // 每个项目只允许一个在途写入：后续操作在拿到前一次的新版本后再发送，避免快速点击时
  // 所有请求都带着同一个旧 version。confirmed 是服务端最后确认的快照，失败就从这里回滚。
  const confirmedProjects = new Map<number, Project>()
  const projectWrites = new Map<number, Promise<void>>()
  // optimistic revision 在“请求排队”时就递增，而不是等请求真正发出。这样 landing 中 regrab
  // 产生第二次 move 后，第一笔请求即使随后失败，也知道自己已经不是最新用户意图，不能回滚
  // 第二次 move 已经同步写进 projects 的状态。
  const projectWriteRevisions = new Map<number, number>()
  const delayedProjectUpdates = new Map<number, {
    fields: Partial<Project>
    timer: ReturnType<typeof setTimeout> | null
  }>()

  function cloneProject(project: Project): Project {
    return JSON.parse(JSON.stringify(project)) as Project
  }

  function rememberConfirmed(project: Project) {
    confirmedProjects.set(project.id, cloneProject(project))
  }

  function restoreConfirmed(id: number) {
    const confirmed = confirmedProjects.get(id)
    const index = projects.value.findIndex(project => project.id === id)
    if (confirmed && index >= 0) projects.value.splice(index, 1, cloneProject(confirmed))
  }

  const activeCount = computed(() =>
    projects.value.filter(p => p.status === 'active').length
  )
  const totalCount = computed(() => projects.value.length)

  const upcomingCount = computed(() => {
    const today = new Date(); today.setHours(0, 0, 0, 0)
    return projects.value.filter(p => {
      if (!p.deadline) return false
      const days = (new Date(p.deadline + 'T00:00:00').getTime() - today.getTime()) / 86400000
      return days >= 0 && days <= 7
    }).length
  })

  const urgentProjects = computed(() => {
    const today = new Date(); today.setHours(0, 0, 0, 0)
    return projects.value.filter(p => {
      if (!p.deadline) return false
      const days = (new Date(p.deadline + 'T00:00:00').getTime() - today.getTime()) / 86400000
      return days <= 3
    })
  })

  async function fetchProjects() {
    loading.value = true
    error.value   = null
    const requestEpoch = getAccountBoundaryEpoch()
    try {
      const nextProjects = (await projectsApi.list()).map(mapProjectResponse)
      if (requestEpoch !== getAccountBoundaryEpoch()) return
      projects.value = nextProjects
      projects.value.forEach(rememberConfirmed)
      projectsLoaded.value = true
    } catch (e) {
      error.value = errMsg(e)
    } finally {
      loading.value = false
    }
  }

  async function addProject(fields: ProjectDraft) {
    const status: ProjectStatus = fields.status === 'active' || fields.status === 'done'
      ? fields.status
      : 'pending'
    const payload = {
      name:         fields.name,
      client:       fields.client || null,
      status,
      // normalizeStages 产出具名 ProjectStage[]，create 的 wire 类型要松散索引签名数组，边界收口
      stages:       normalizeStages(fields.stages) as unknown as Record<string, unknown>[],
      currentStage: fields.stages[0] ? `s${fields.currentStageIdx ?? 0}` : null,
      progress:     0,
      startDate:    fields.startDate || null,
      deadline:     fields.deadline  || null,
      color:        fields.color || DEFAULT_PROJECT_COLOR,
    }
    const created = mapProjectResponse(await projectsApi.create(payload))
    projects.value.unshift(created)
    rememberConfirmed(created)
    return created
  }

  async function deleteProject(id: number) {
    await projectsApi.delete(id)
    projects.value = projects.value.filter(p => p.id !== id)
  }

  async function archiveProject(id: number) {
    const p = projects.value.find(p => p.id === id)
    await projectsApi.update(id, { archived: true, version: p?.version })
    projects.value = projects.value.filter(p => p.id !== id)
  }

  async function fetchArchivedProjects() {
    if (archivedLoading.value) return
    // 已加载过就静默后台刷新（内容仍展示旧数据，不切「加载中」）——只有真·首次（archivedLoaded
    // 还是 false）才让弹层显示加载态。配合页面挂载即预取，用户点开归档按钮时数据大概率已经在，
    // 不会再看到那下加载闪烁（见 views/Projects/index.vue onMounted）。
    archivedLoading.value = true
    const requestEpoch = getAccountBoundaryEpoch()
    try {
      const nextProjects = (await projectsApi.list(true)).map(mapProjectResponse)
      if (requestEpoch !== getAccountBoundaryEpoch()) return
      archivedProjects.value = nextProjects
      archivedLoaded.value = true
    } catch (e) {
      error.value = errMsg(e)
    } finally {
      archivedLoading.value = false
    }
  }

  async function unarchiveProject(id: number) {
    const p = archivedProjects.value.find(p => p.id === id)
    await projectsApi.update(id, { archived: false, version: p?.version })
    archivedProjects.value = archivedProjects.value.filter(p => p.id !== id)
    await fetchProjects()
  }

  async function _patchProject(id: number, payload: Partial<Project>) {
    const revision = (projectWriteRevisions.get(id) ?? 0) + 1
    projectWriteRevisions.set(id, revision)
    const previous = projectWrites.get(id) ?? Promise.resolve()
    const write = previous.catch(() => undefined).then(async () => {
      const project = projects.value.find(item => item.id === id)
      const confirmed = confirmedProjects.get(id)
      const version = project?.version ?? confirmed?.version
      try {
        // payload 用紧类型 Partial<Project>（stages 结构化），wire 的 ProjectUpdate 是松类型，边界处一次性收
        const updated = await InteractionSync.execute({
          scope: 'project.update',
          entityKey: `project:${id}`,
          apply: () => {},
          rollback: () => {
            if (projectWriteRevisions.get(id) === revision) restoreConfirmed(id)
          },
          request: mutation => projectsApi.update(
            id,
            { ...payload, version } as unknown as components['schemas']['ProjectUpdate'],
            { mutationId: mutation.mutationId },
          ),
        })
        if (!updated) return
        rememberConfirmed(mapProjectResponse(updated))
        const current = projects.value.find(item => item.id === id)
        if (current) {
          // 即使这笔已被 regrab 的新写入 supersede，version 仍必须推进：排队中的下一笔请求
          // 要拿服务端刚确认的新版本。其它服务端字段只能由最新 revision 回填，否则旧响应会
          // 覆盖新 move 的乐观状态（doneAt 是跨 pending/active/done 最明显的一处）。
          current.version = updated.version
          if (projectWriteRevisions.get(id) === revision) current.doneAt = updated.doneAt
        }
      } catch (e) {
        const isLatestIntent = projectWriteRevisions.get(id) === revision
        // A→B 尚未确认时 regrab 到 C：A→B 的失败不能把 C 回滚成 A。最新一笔如果失败
        // 仍按 confirmed 快照回滚，因此单次拖拽和最终失败的原语义保持不变。
        if (!isLatestIntent) return
        restoreConfirmed(id)
        if ((e as { status?: number }).status === 409) {
          await fetchProjects()
          error.value = '项目已被其他端修改，已刷新到最新内容'
          return
        }
        error.value = `项目保存失败：${errMsg(e)}`
      }
    })
    projectWrites.set(id, write)
    try {
      await write
    } finally {
      if (projectWrites.get(id) === write) projectWrites.delete(id)
      if (projectWriteRevisions.get(id) === revision && projectWrites.get(id) !== write) {
        projectWriteRevisions.delete(id)
      }
    }
  }

  async function moveProject(id: number, newStatusRaw: string) {
    // 调用方来自看板列 key / DOM data-col-status，运行时保证是三态之一，边界收紧
    const newStatus = newStatusRaw as ProjectStatus
    const p = projects.value.find(p => p.id === id)
    if (!p) return
    const oldStatus = p.status
    const transition = transitionProjectStatus(p, newStatus)
    const becameDone = oldStatus !== 'done' && transition.status === 'done'
    Object.assign(p, transition)
    p._stageBeforeDone = transition.stageBeforeDone

    if (becameDone) {
      p.doneAt = new Date().toISOString()
    } else if (oldStatus === 'done' && transition.status !== 'done') {
      p.doneAt = null
    }
    await _patchProject(id, {
      status: transition.status, currentStage: transition.currentStage,
      progress: transition.progress, stages: transition.stages,
    })
  }

  async function setStage(id: number, stageKey: string, progress?: number) {
    const p = projects.value.find(p => p.id === id)
    if (!p) return

    const transition = transitionProjectStage(p, stageKey, progress ?? 0)
    const oldStatus = p.status
    const becameDone = oldStatus !== 'done' && transition.status === 'done'
    Object.assign(p, transition)
    p._stageBeforeDone = transition.stageBeforeDone
    if (becameDone) {
      p.doneAt = new Date().toISOString()
    } else if (transition.status !== 'done' && oldStatus === 'done') {
      p.doneAt = null
    }
    await _patchProject(id, {
      currentStage: transition.currentStage, progress: transition.progress,
      stages: transition.stages, status: transition.status,
    })
  }

  async function updateStages(id: number, newStages: ProjectStage[]) {
    const p = projects.value.find(p => p.id === id)
    if (!p) return
    p.stages = newStages
    if (!newStages.find(s => s.key === p.currentStage)) {
      p.currentStage = newStages[0]?.key ?? ''
    }
    await _patchProject(id, { stages: newStages, currentStage: p.currentStage })
  }

  async function saveTodos(id: number, newStages: ProjectStage[], progress: number, advanceTo?: string) {
    const p = projects.value.find(project => project.id === id)
    if (!p) return
    const state = { ...p, stages: newStages }
    const transition = advanceTo
      ? transitionProjectStage(state, advanceTo, progress)
      : transitionProjectTodos(state, newStages, progress)
    const oldStatus = p.status
    const becameDone = oldStatus !== 'done' && transition.status === 'done'
    Object.assign(p, transition)
    p._stageBeforeDone = transition.stageBeforeDone
    if (becameDone) {
      p.doneAt = new Date().toISOString()
    }
    if (transition.status !== 'done' && oldStatus === 'done') p.doneAt = null
    await _patchProject(id, {
      stages: transition.stages, currentStage: transition.currentStage,
      progress: transition.progress, status: transition.status,
    })
  }

  async function updateProject(id: number, fields: Partial<Project>) {
    const p = projects.value.find(p => p.id === id)
    if (p) {
      Object.assign(p, fields)
    }
    await _patchProject(id, fields)
  }

  function updateProjectDebounced(id: number, fields: Partial<Project>, delay = 400) {
    const p = projects.value.find(project => project.id === id)
    if (p) {
      Object.assign(p, fields)
    }
    const pending = delayedProjectUpdates.get(id)
    if (pending) {
      Object.assign(pending.fields, fields)
      if (pending.timer) clearTimeout(pending.timer)
      pending.timer = setTimeout(() => {
        delayedProjectUpdates.delete(id)
        void _patchProject(id, pending.fields)
      }, delay)
      return
    }
    const next = { fields: { ...fields }, timer: null as ReturnType<typeof setTimeout> | null }
    next.timer = setTimeout(() => {
      delayedProjectUpdates.delete(id)
      void _patchProject(id, next.fields)
    }, delay)
    delayedProjectUpdates.set(id, next)
  }

  const modalProjectId = ref<number | null>(null)
  // computed 保证 fetchProjects 刷新后 modal 始终指向最新对象，不持有旧引用
  const modalProject = computed(() =>
    modalProjectId.value != null
      ? (projects.value.find(p => p.id === modalProjectId.value) ?? null)
      : null
  )

  function openModal(project: { id?: number } | null | undefined) { modalProjectId.value = project?.id ?? null }
  function closeModal()       { modalProjectId.value = null }

  // 近期节点日历事件缓存（在 store 里，SPA 导航不重置）
  const upcomingCalEvents = ref<EventResponse[]>([])
  async function fetchUpcomingCalEvents() {
    const requestEpoch = getAccountBoundaryEpoch()
    try {
      const today = new Date()
      const y = today.getFullYear(), m = today.getMonth() + 1
      const thisMonth = await eventsApi.list(y, m)
      const nextMonth = await eventsApi.list(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1)
      if (requestEpoch === getAccountBoundaryEpoch()) upcomingCalEvents.value = [...thisMonth, ...nextMonth]
    } catch { /* ignore */ }
  }

  function resetAccountState() {
    delayedProjectUpdates.forEach(({ timer }) => { if (timer) clearTimeout(timer) })
    delayedProjectUpdates.clear()
    projectWrites.clear()
    projectWriteRevisions.clear()
    confirmedProjects.clear()
    projects.value = []
    archivedProjects.value = []
    upcomingCalEvents.value = []
    projectsLoaded.value = false
    archivedLoaded.value = false
    modalProjectId.value = null
    error.value = null
  }

  // 实时：咕咕/IM 改了项目或日历事件 → 只要主列表加载过，即使为空也刷新。
  const live = useLiveStore()
  const eventQueue = new InteractionSyncEventQueue()
  let lastHandledEventTick = 0
  function applyCanonicalProjectEvent(event: LiveEventPayload): boolean {
    const id = Number(event.entity_id)
    const payload = event.payload as components['schemas']['ProjectResponse'] | undefined
    if (!Number.isFinite(id)) return false
    if (event.operation === 'delete') {
      projects.value = projects.value.filter(project => project.id !== id)
      confirmedProjects.delete(id)
      return true
    }
    if (!payload || Number(payload.id) !== id) return false
    try {
      const next = mapProjectResponse(payload)
      const index = projects.value.findIndex(project => project.id === id)
      if (event.operation === 'create' && index === -1) projects.value = [next, ...projects.value]
      else if (index >= 0) projects.value.splice(index, 1, next)
      else return false
      rememberConfirmed(next)
      return true
    } catch { return false }
  }
  eventQueue.register('projects', applyCanonicalProjectEvent, () => { void fetchProjects() })
  watch(() => live.resourceEvent, event => {
    if (!event || event.resource !== 'projects' || !projectsLoaded.value) return
    lastHandledEventTick = event._t
    eventQueue.receive(event)
  })
  watch(() => live.rev.projects, () => {
    if (!projectsLoaded.value) return
    const currentEvent = live.resourceEvent
    if (currentEvent?.resource === 'projects' && currentEvent._t === lastHandledEventTick) {
      lastHandledEventTick = 0
      return
    }
    eventQueue.enqueue('projects')
  })
  watch(() => live.rev.calendar, () => fetchUpcomingCalEvents())

  return {
    kanbanColumns, projects, loading, error, projectsLoaded,
    activeCount, totalCount, upcomingCount, urgentProjects,
    fetchProjects, addProject, deleteProject, archiveProject, moveProject,
    setStage, updateStages, saveTodos, updateProject, updateProjectDebounced,
    modalProject, openModal, closeModal, resetAccountState,
    upcomingCalEvents, fetchUpcomingCalEvents,
    archivedProjects, archivedLoading, archivedLoaded, fetchArchivedProjects, unarchiveProject,
  }
})
