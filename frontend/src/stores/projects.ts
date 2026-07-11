import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import { projectsApi, eventsApi } from '@/services/api'
import { useLiveStore } from '@/stores/live'
import type { Project, ProjectStage, ProjectStatus } from '@/types/project'
import { autoCompleteTodos, restoreTodos, stageProgressByIndex } from '@/utils/projectStages'
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

  const archivedProjects = ref<Project[]>([])
  const archivedLoading  = ref(false)

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
      // api 边界收紧：ProjectResponse（status:string / stages 未结构化）→ Project（见 types/project.ts）
      projects.value = await projectsApi.list() as unknown as Project[]
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
      stages:       fields.stages.map((s, i) => ({ key: `s${i}`, label: typeof s === 'string' ? s : s.label, todos: typeof s === 'string' ? [] : (s.todos ?? []) })),
      currentStage: fields.stages[0] ? `s${fields.currentStageIdx ?? 0}` : null,
      progress:     0,
      startDate:    fields.startDate || null,
      deadline:     fields.deadline  || null,
      color:        fields.color || 'linear-gradient(135deg,#7b7fb2,#c4afc8)',
    }
    const created = await projectsApi.create(payload) as unknown as Project
    projects.value.unshift(created)
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
    archivedLoading.value = true
    try {
      archivedProjects.value = await projectsApi.list(true) as unknown as Project[]
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
    const p = projects.value.find(p => p.id === id)
    try {
      // payload 用紧类型 Partial<Project>（stages 结构化），wire 的 ProjectUpdate 是松类型，边界处一次性收
      const updated = await projectsApi.update(id, { ...payload, version: p?.version } as unknown as components['schemas']['ProjectUpdate'])
      if (p && updated) {
        if (updated.version) p.version = updated.version
        if ('doneAt' in updated) p.doneAt = updated.doneAt
      }
    } catch (e) {
      if ((e as { status?: number }).status === 409) {
        await fetchProjects()
        throw new Error('数据已被其他用户修改，已自动刷新')
      }
      throw e
    }
  }

  async function moveProject(id: number, newStatusRaw: string) {
    // 调用方来自看板列 key / DOM data-col-status，运行时保证是三态之一，边界收紧
    const newStatus = newStatusRaw as ProjectStatus
    const p = projects.value.find(p => p.id === id)
    if (!p) return
    const oldStatus = p.status
    p.status = newStatus

    if (newStatus === 'done' && oldStatus !== 'done') {
      p.doneAt = new Date().toISOString()
      // 新手引导回头看(08)：完成第 5 个项目时弹一句（claim-once 只一次）
      if (projects.value.filter(x => x.status === 'done').length >= 5) {
        import('@/composables/useOnboarding').then(m => m.fireLookback()).catch(() => {})
      }
    } else if (oldStatus === 'done' && newStatus !== 'done') {
      p.doneAt = null
    }

    if (newStatus === 'done' && oldStatus !== 'done' && p.stages?.length) {
      if (!p._stageBeforeDone) p._stageBeforeDone = p.currentStage  // 若 setStage 已提前存好则不覆盖
      const lastKey = p.stages[p.stages.length - 1].key
      p.currentStage = lastKey
      p.progress = 100
      // 拖到「已完成」= 全项目收尾：自动勾选所有阶段里未完成的待办（快照原状态 +
      // autoCompleted 标记，拖回进行中时按此还原）。与 setStage 前进时同一套约定。
      const stages = JSON.parse(JSON.stringify(p.stages))
      for (const stage of stages) stage.todos = autoCompleteTodos(stage.todos ?? [])
      p.stages = stages
      await _patchProject(id, { status: newStatus, currentStage: lastKey, progress: 100, doneAt: p.doneAt, stages })
      return
    }

    if (oldStatus === 'done' && newStatus !== 'done' && p.stages?.length) {
      const restored = p._stageBeforeDone ?? p.stages[0].key
      p._stageBeforeDone = undefined
      p.currentStage = restored
      const idx = p.stages.findIndex(s => s.key === restored)
      const progress = stageProgressByIndex(idx, p.stages.length)
      p.progress = progress
      // 还原所有 autoCompleted 的 todo 到快照状态
      const stages = JSON.parse(JSON.stringify(p.stages))
      for (const stage of stages) stage.todos = restoreTodos(stage.todos ?? [])
      p.stages = stages
      await _patchProject(id, { status: newStatus, currentStage: restored, progress, stages })
      return
    }

    await _patchProject(id, { status: newStatus })
  }

  async function setStage(id: number, stageKey: string, progress?: number) {
    const p = projects.value.find(p => p.id === id)
    if (!p) return

    const originalStageKey = p.currentStage  // 记录修改前的阶段，用于 _stageBeforeDone
    const oldIdx = p.stages.findIndex(s => s.key === p.currentStage)
    const newIdx = p.stages.findIndex(s => s.key === stageKey)

    let stages = p.stages
    if (oldIdx !== newIdx && oldIdx >= 0 && newIdx >= 0) {
      stages = JSON.parse(JSON.stringify(p.stages))
      if (newIdx > oldIdx) {
        // 前进：对经过的阶段（不含新当前阶段）快照并自动打勾
        for (let i = oldIdx; i < newIdx; i++) stages[i].todos = autoCompleteTodos(stages[i].todos ?? [])
      } else {
        // 后退：从目标阶段开始（含目标阶段自身）还原 autoCompleted 到快照状态
        for (let i = newIdx; i < stages.length; i++) stages[i].todos = restoreTodos(stages[i].todos ?? [])
      }
      p.stages = stages
    }

    p.currentStage = stageKey
    p.progress = progress ?? 0

    const isLastFull = newIdx === p.stages.length - 1 && p.progress === 100

    if (isLastFull && p.status !== 'done') {
      // 最后阶段 + 进度满 → 立即乐观更新 status/doneAt，一次 API 全部写入
      p._stageBeforeDone = originalStageKey
      p.status = 'done'
      p.doneAt = new Date().toISOString()
      await _patchProject(id, { currentStage: stageKey, progress: p.progress, stages, status: 'done' })
    } else if (!isLastFull && p.status === 'done') {
      // 退出最后阶段或进度不满 → 从已完成回退到进行中
      p.status = 'active'
      p.doneAt = null
      await _patchProject(id, { currentStage: stageKey, progress: p.progress, stages, status: 'active', doneAt: null })
    } else {
      await _patchProject(id, { currentStage: stageKey, progress: p.progress, stages })
    }
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

  async function updateProject(id: number, fields: Partial<Project>) {
    const p = projects.value.find(p => p.id === id)
    if (p) Object.assign(p, fields)
    await _patchProject(id, fields)
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

  // 实时：咕咕/IM 改了项目或日历事件 → 自动重新拉取（只刷已加载过的数据）
  const live = useLiveStore()
  watch(() => live.rev.projects, () => { if (projects.value.length || loading.value) fetchProjects() })
  watch(() => live.rev.calendar, () => fetchUpcomingCalEvents())

  return {
    kanbanColumns, projects, loading, error,
    activeCount, totalCount, upcomingCount, urgentProjects,
    fetchProjects, addProject, deleteProject, archiveProject, moveProject,
    setStage, updateStages, updateProject,
    modalProject, openModal, closeModal,
    upcomingCalEvents, fetchUpcomingCalEvents,
    archivedProjects, archivedLoading, fetchArchivedProjects, unarchiveProject,
  }
})
