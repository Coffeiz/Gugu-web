/**
 * 项目卡片展示层的纯派生数据——看板项目卡（ProjectCard.vue）和画布项目引用卡
 * （ProjectRefCard.vue）共用同一套只读展示口径（名字底色、当前阶段文案/进度、
 * 截止日期文案），但两边的交互（优先级星级、推进按钮、待办弹层、文件拖拽上传）
 * 完全不同，特意不共享组件、只共享这一份没有 DOM 的纯逻辑，避免两边为了复用组件
 * 又要靠一堆 canvasMode 分支互相迁就。
 */
import { computed, type Ref } from 'vue'
import type { Project } from '@/types/project'
import { projectTodoProgress } from '@/utils/projectStages'

export function useProjectCardBasics(project: Ref<Project>) {
  const currentStageIndex = computed(() =>
    project.value.stages.findIndex(s => s.key === project.value.currentStage)
  )
  const currentStageLabel = computed(() => project.value.stages[currentStageIndex.value]?.label ?? '')
  const currentStage = computed(() => project.value.stages[currentStageIndex.value] ?? null)
  const currentTodos = computed(() => currentStage.value?.todos ?? [])
  const curTodoTotal = computed(() => currentTodos.value.length)
  const curDoneCount = computed(() => currentTodos.value.filter(t => t.done).length)

  // 总完成度 = 所有阶段待办里已完成 / 总数（与总览页、项目编辑卡头部口径一致）；无待办则退回阶段位置
  const stageProgress = computed(() => projectTodoProgress(project.value.stages, project.value.currentStage))

  const nameColor = computed(() => {
    const hex = project.value.color?.match(/#[0-9a-fA-F]{6}/)?.[0] ?? '#7b7fb2'
    const r = Math.round(parseInt(hex.slice(1, 3), 16) * 0.40)
    const g = Math.round(parseInt(hex.slice(3, 5), 16) * 0.40)
    const b = Math.round(parseInt(hex.slice(5, 7), 16) * 0.40)
    return `rgb(${r},${g},${b})`
  })

  const daysLeft = computed(() => {
    if (!project.value.deadline) return null
    const today = new Date(); today.setHours(0, 0, 0, 0)
    const dl = new Date(project.value.deadline + 'T00:00:00')
    return Math.ceil((dl.getTime() - today.getTime()) / 86400000)
  })
  const isUrgent = computed(() => project.value.status !== 'done' && (daysLeft.value ?? Infinity) <= 3)
  const thisYear = new Date().getFullYear()
  function fmtDate(iso: string) {
    if (!iso) return ''
    const d = new Date(iso + 'T00:00:00')
    const mm = `${d.getMonth() + 1}/${d.getDate()}`
    return d.getFullYear() !== thisYear ? `${d.getFullYear()}/${mm}` : mm
  }
  const deadlineLabel = computed(() => {
    if (!project.value.deadline) return '—'
    const d = daysLeft.value
    if (d == null) return '—'
    if (d < 0) {
      if (project.value.status !== 'done') return `逾期 ${-d} 天`
      return fmtDate(project.value.deadline)
    }
    if (d === 0) return '今天截止'
    if (d === 1) return '明天'
    if (d <= 7) return `${d}天后`
    return fmtDate(project.value.deadline)
  })

  return { currentStageLabel, curTodoTotal, curDoneCount, stageProgress, nameColor, isUrgent, fmtDate, deadlineLabel }
}
