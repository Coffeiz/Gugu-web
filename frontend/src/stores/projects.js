import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import { projectsApi, eventsApi } from '@/services/api'
import { useLiveStore } from '@/stores/live'

export const useProjectStore = defineStore('projects', () => {

  const kanbanColumns = [
    { key: 'pending', label: '待开始' },
    { key: 'active',  label: '进行中' },
    { key: 'done',    label: '已完成' },
  ]

  const projects = ref([])
  const loading  = ref(false)
  const error    = ref(null)

  const activeCount = computed(() =>
    projects.value.filter(p => p.status === 'active').length
  )
  const totalCount = computed(() => projects.value.length)

  const upcomingCount = computed(() => {
    const today = new Date(); today.setHours(0, 0, 0, 0)
    return projects.value.filter(p => {
      if (!p.deadline) return false
      const days = (new Date(p.deadline + 'T00:00:00') - today) / 86400000
      return days >= 0 && days <= 7
    }).length
  })

  const urgentProjects = computed(() => {
    const today = new Date(); today.setHours(0, 0, 0, 0)
    return projects.value.filter(p => {
      if (!p.deadline) return false
      const days = (new Date(p.deadline + 'T00:00:00') - today) / 86400000
      return days <= 3
    })
  })

  async function fetchProjects() {
    loading.value = true
    error.value   = null
    try {
      projects.value = await projectsApi.list()
    } catch (e) {
      error.value = e.message
    } finally {
      loading.value = false
    }
  }

  async function addProject(fields) {
    const payload = {
      name:         fields.name,
      client:       fields.client || null,
      status:       fields.status || 'pending',
      stages:       fields.stages.map((s, i) => ({ key: `s${i}`, label: typeof s === 'string' ? s : s.label, todos: s.todos ?? [] })),
      currentStage: fields.stages[0] ? 's0' : null,
      progress:     0,
      startDate:    fields.startDate || null,
      deadline:     fields.deadline  || null,
      color:        fields.color || 'linear-gradient(135deg,#7b7fb2,#c4afc8)',
      notes:        '',
    }
    const created = await projectsApi.create(payload)
    projects.value.unshift(created)
    return created
  }

  async function deleteProject(id) {
    await projectsApi.delete(id)
    projects.value = projects.value.filter(p => p.id !== id)
  }

  async function _patchProject(id, payload) {
    const p = projects.value.find(p => p.id === id)
    try {
      const updated = await projectsApi.update(id, { ...payload, version: p?.version })
      if (p && updated) {
        if (updated.version) p.version = updated.version
        if ('doneAt' in updated) p.doneAt = updated.doneAt
      }
    } catch (e) {
      if (e.status === 409) {
        await fetchProjects()
        throw new Error('数据已被其他用户修改，已自动刷新')
      }
      throw e
    }
  }

  async function moveProject(id, newStatus) {
    const p = projects.value.find(p => p.id === id)
    if (!p) return
    const oldStatus = p.status
    p.status = newStatus

    if (newStatus === 'done' && oldStatus !== 'done') {
      p.doneAt = new Date().toISOString()
    } else if (oldStatus === 'done' && newStatus !== 'done') {
      p.doneAt = null
    }

    if (newStatus === 'done' && oldStatus !== 'done' && p.stages?.length) {
      if (!p._stageBeforeDone) p._stageBeforeDone = p.currentStage  // 若 setStage 已提前存好则不覆盖
      const lastKey = p.stages[p.stages.length - 1].key
      p.currentStage = lastKey
      p.progress = 100
      await _patchProject(id, { status: newStatus, currentStage: lastKey, progress: 100, doneAt: p.doneAt })
      return
    }

    if (oldStatus === 'done' && newStatus !== 'done' && p.stages?.length) {
      const restored = p._stageBeforeDone ?? p.stages[0].key
      p._stageBeforeDone = undefined
      p.currentStage = restored
      const idx = p.stages.findIndex(s => s.key === restored)
      const progress = idx >= 0 ? Math.round((idx + 1) / p.stages.length * 100) : 0
      p.progress = progress
      // 还原所有 autoCompleted 的 todo 到快照状态
      const stages = JSON.parse(JSON.stringify(p.stages))
      for (const stage of stages) {
        stage.todos = (stage.todos ?? []).map(t =>
          t.autoCompleted ? { ...t, done: t._savedDone ?? false, autoCompleted: false, _savedDone: undefined } : t
        )
      }
      p.stages = stages
      await _patchProject(id, { status: newStatus, currentStage: restored, progress, stages })
      return
    }

    await _patchProject(id, { status: newStatus })
  }

  async function setStage(id, stageKey, progress) {
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
        for (let i = oldIdx; i < newIdx; i++) {
          stages[i].todos = (stages[i].todos ?? []).map(t =>
            t.done ? t : { ...t, _savedDone: false, done: true, autoCompleted: true }
          )
        }
      } else {
        // 后退：从目标阶段开始（含目标阶段自身）还原 autoCompleted 到快照状态
        for (let i = newIdx; i < stages.length; i++) {
          stages[i].todos = (stages[i].todos ?? []).map(t =>
            t.autoCompleted ? { ...t, done: t._savedDone ?? false, autoCompleted: false, _savedDone: undefined } : t
          )
        }
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

  async function updateStages(id, newStages) {
    const p = projects.value.find(p => p.id === id)
    if (!p) return
    p.stages = newStages
    if (!newStages.find(s => s.key === p.currentStage)) {
      p.currentStage = newStages[0]?.key ?? ''
    }
    await _patchProject(id, { stages: newStages, currentStage: p.currentStage })
  }

  async function updateProject(id, fields) {
    const p = projects.value.find(p => p.id === id)
    if (p) Object.assign(p, fields)
    await _patchProject(id, fields)
  }

  const modalProjectId = ref(null)
  // computed 保证 fetchProjects 刷新后 modal 始终指向最新对象，不持有旧引用
  const modalProject = computed(() =>
    modalProjectId.value != null
      ? (projects.value.find(p => p.id === modalProjectId.value) ?? null)
      : null
  )

  function openModal(project) { modalProjectId.value = project?.id ?? null }
  function closeModal()       { modalProjectId.value = null }

  // 近期节点日历事件缓存（在 store 里，SPA 导航不重置）
  const upcomingCalEvents = ref([])
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
    fetchProjects, addProject, deleteProject, moveProject,
    setStage, updateStages, updateProject,
    modalProject, openModal, closeModal,
    upcomingCalEvents, fetchUpcomingCalEvents,
  }
})
