import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import { projectsApi, eventsApi } from '@/services/api'
import { useLiveStore } from '@/stores/live'
import { mapProjectResponse, type Project, type ProjectStage, type ProjectStatus } from '@/types/project'
import {
  normalizeStages, transitionProjectStage, transitionProjectStatus, transitionProjectTodos,
} from '@/utils/projectStages'
import type { components } from '@/types/api'

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
    try {
      projects.value = (await projectsApi.list()).map(mapProjectResponse)
      projects.value.forEach(rememberConfirmed)
      projectsLoaded.value = true
    } catch (e) {
      error.value = errMsg(e)
    } finally {
      loading.value = false
    }
  }

  async function addProject(fields: ProjectDraft) {
    const payload = {
      name:         fields.name,
      client:       fields.client || null,
      status:       fields.status || 'pending',
      // normalizeStages 产出具名 ProjectStage[]，create 的 wire 类型要松散索引签名数组，边界收口
      stages:       normalizeStages(fields.stages) as unknown as Record<string, unknown>[],
      currentStage: fields.stages[0] ? `s${fields.currentStageIdx ?? 0}` : null,
      progress:     0,
      startDate:    fields.startDate || null,
      deadline:     fields.deadline  || null,
      color:        fields.color || 'linear-gradient(135deg,#7b7fb2,#c4afc8)',
    }
    const created = mapProjectResponse(await projectsApi.create(payload))
    projects.value.unshift(created)
    rememberConfirmed(created)
    // 新手引导：手动新建第一个项目后弹一句（claim-once 保证只第一次）
    import('@/composables/useOnboarding').then(m => m.fireHint('todo_newproj')).catch(() => {})
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
    try {
      archivedProjects.value = (await projectsApi.list(true)).map(mapProjectResponse)
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
    const previous = projectWrites.get(id) ?? Promise.resolve()
    const write = previous.catch(() => undefined).then(async () => {
      const project = projects.value.find(item => item.id === id)
      const confirmed = confirmedProjects.get(id)
      const version = project?.version ?? confirmed?.version
      try {
        // payload 用紧类型 Partial<Project>（stages 结构化），wire 的 ProjectUpdate 是松类型，边界处一次性收
        const updated = await projectsApi.update(id, { ...payload, version } as unknown as components['schemas']['ProjectUpdate'])
        if (!updated) return
        rememberConfirmed(mapProjectResponse(updated))
        const current = projects.value.find(item => item.id === id)
        if (current) {
          current.version = updated.version
          current.doneAt = updated.doneAt
        }
      } catch (e) {
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
    try {
      const today = new Date()
      const y = today.getFullYear(), m = today.getMonth() + 1
      const thisMonth = await eventsApi.list(y, m)
      const nextMonth = await eventsApi.list(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1)
      upcomingCalEvents.value = [...thisMonth, ...nextMonth]
    } catch { /* ignore */ }
  }

  // 实时：咕咕/IM 改了项目或日历事件 → 只要主列表加载过，即使为空也刷新。
  const live = useLiveStore()
  watch(() => live.rev.projects, () => { if (projectsLoaded.value) fetchProjects() })
  watch(() => live.rev.calendar, () => fetchUpcomingCalEvents())

  return {
    kanbanColumns, projects, loading, error, projectsLoaded,
    activeCount, totalCount, upcomingCount, urgentProjects,
    fetchProjects, addProject, deleteProject, archiveProject, moveProject,
    setStage, updateStages, saveTodos, updateProject, updateProjectDebounced,
    modalProject, openModal, closeModal,
    upcomingCalEvents, fetchUpcomingCalEvents,
    archivedProjects, archivedLoading, archivedLoaded, fetchArchivedProjects, unarchiveProject,
  }
})
