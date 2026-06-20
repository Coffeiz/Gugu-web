import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { projectsApi, eventsApi } from '@/services/api'

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
      stages:       fields.stages.map((label, i) => ({ key: `s${i}`, label })),
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

  async function moveProject(id, newStatus) {
    const p = projects.value.find(p => p.id === id)
    if (!p) return
    const oldStatus = p.status
    p.status = newStatus

    if (newStatus === 'done' && !p.doneAt) {
      p.doneAt = new Date().toISOString()
    }

    if (newStatus === 'done' && oldStatus !== 'done' && p.stages?.length) {
      // 进入已完成：记住当前阶段，推进到最后阶段（100%）
      p._stageBeforeDone = p.currentStage
      const lastKey = p.stages[p.stages.length - 1].key
      p.currentStage = lastKey
      p.progress = 100
      await projectsApi.update(id, { status: newStatus, currentStage: lastKey, progress: 100 })
      return
    }

    if (oldStatus === 'done' && newStatus !== 'done' && p.stages?.length) {
      // 离开已完成：还原之前记住的阶段
      const restored = p._stageBeforeDone ?? p.stages[0].key
      p._stageBeforeDone = undefined
      p.currentStage = restored
      const idx = p.stages.findIndex(s => s.key === restored)
      const progress = idx >= 0 ? Math.round((idx + 1) / p.stages.length * 100) : 0
      p.progress = progress
      await projectsApi.update(id, { status: newStatus, currentStage: restored, progress })
      return
    }

    await projectsApi.update(id, { status: newStatus })
  }

  async function setStage(id, stageKey) {
    const p = projects.value.find(p => p.id === id)
    if (!p) return
    p.currentStage = stageKey
    const idx = p.stages.findIndex(s => s.key === stageKey)
    const progress = p.stages.length > 0
      ? Math.round((idx + 1) / p.stages.length * 100)
      : 0
    p.progress = progress
    await projectsApi.update(id, { currentStage: stageKey, progress })
  }

  async function updateStages(id, newStages) {
    const p = projects.value.find(p => p.id === id)
    if (!p) return
    p.stages = newStages
    if (!newStages.find(s => s.key === p.currentStage)) {
      p.currentStage = newStages[0]?.key ?? ''
    }
    await projectsApi.update(id, { stages: newStages, currentStage: p.currentStage })
  }

  async function updateProject(id, fields) {
    const p = projects.value.find(p => p.id === id)
    if (p) Object.assign(p, fields)
    await projectsApi.update(id, fields)
  }

  const modalProject = ref(null)

  function openModal(project) { modalProject.value = project }
  function closeModal()       { modalProject.value = null }

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

  return {
    kanbanColumns, projects, loading, error,
    activeCount, totalCount, upcomingCount, urgentProjects,
    fetchProjects, addProject, deleteProject, moveProject,
    setStage, updateStages, updateProject,
    modalProject, openModal, closeModal,
    upcomingCalEvents, fetchUpcomingCalEvents,
  }
})
