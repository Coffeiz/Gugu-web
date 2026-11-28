/**
 * 项目卡片展示层的纯派生数据——看板项目卡（ProjectCard.vue）和画布项目引用卡
 * （ProjectRefCard.vue）共用同一套只读展示口径（名字底色、当前阶段文案/进度、
 * 截止日期文案），但两边的交互（优先级星级、推进按钮、待办弹层、文件拖拽上传）
 * 完全不同，特意不共享组件、只共享这一份没有 DOM 的纯逻辑，避免两边为了复用组件
 * 又要靠一堆 canvasMode 分支互相迁就。
 */
import { computed, type Ref } from 'vue'
import type { Project } from '@/types/project'
import { projectProgress } from '@/utils/projectProgress'

function formatProjectCardDate(iso: string, today: Date) {
  if (!iso) return ''
  const date = new Date(iso + 'T00:00:00')
  const monthDay = `${date.getMonth() + 1}/${date.getDate()}`
  return date.getFullYear() !== today.getFullYear() ? `${date.getFullYear()}/${monthDay}` : monthDay
}

export function projectDeadlinePresentation(project: Pick<Project, 'deadline' | 'status'>, now = new Date()) {
  const date = project.deadline
  if (!date) return { label: '—', urgent: false, overdue: false }
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const remaining = Math.ceil((new Date(date + 'T00:00:00').getTime() - today.getTime()) / 86400000)
  if (!Number.isFinite(remaining)) return { label: '—', urgent: false, overdue: false }
  const overdue = project.status !== 'done' && remaining < 0
  const urgent = project.status !== 'done' && remaining <= 3
  const label = overdue ? `逾期 ${-remaining} 天`
    : remaining === 0 ? '今天截止'
    : remaining === 1 ? '明天'
    : remaining > 1 && remaining <= 7 ? `${remaining}天后`
    : formatProjectCardDate(date, today)
  return { label, urgent, overdue }
}

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
  const stageProgress = computed(() => projectProgress(project.value))

  const nameColor = computed(() => {
    const hex = project.value.color?.match(/#[0-9a-fA-F]{6}/)?.[0] ?? '#7b7fb2'
    const r = Math.round(parseInt(hex.slice(1, 3), 16) * 0.40)
    const g = Math.round(parseInt(hex.slice(3, 5), 16) * 0.40)
    const b = Math.round(parseInt(hex.slice(5, 7), 16) * 0.40)
    return `rgb(${r},${g},${b})`
  })

  const deadline = computed(() => projectDeadlinePresentation(project.value))
  const isUrgent = computed(() => deadline.value.urgent)
  const deadlineLabel = computed(() => deadline.value.label)
  const fmtDate = (iso: string) => formatProjectCardDate(iso, new Date())

  return { currentStageLabel, curTodoTotal, curDoneCount, stageProgress, nameColor, isUrgent, fmtDate, deadlineLabel }
}
