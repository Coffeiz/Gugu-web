import type { Ref } from 'vue'
import type { ProjectStage, ProjectStatus } from '@/types/project'
import { calculateStageProgress } from '@/composables/projects/useProjectProgress'
import { transitionProjectStage } from '@/utils/projectStages'

interface ProjectStagesOptions {
  stages: Ref<ProjectStage[]>
  saveStages?: () => void
  currentStage?: Ref<string>
  status?: Ref<ProjectStatus | string>
}

/**
 * 项目阶段的响应式操作编排。
 * 阶段拖拽的指针、ghost 和落点计算仍由 ProjectStagesPanel 保留；这里不接触 DOM。
 * 待办操作由 useProjectTodos 单独负责，避免两个 composable 同时写入同一份 stages。
 */
export function useProjectStages(options: ProjectStagesOptions) {
  const { stages, saveStages = () => undefined, currentStage, status } = options

  function addStage() {
    const key = `stage_${Date.now()}`
    stages.value.push({ key, label: '新阶段', todos: [] })
    saveStages()
    return key
  }

  function removeStage(key: string) {
    if (stages.value.length <= 1) return false
    stages.value = stages.value.filter(stage => stage.key !== key)
    saveStages()
    return true
  }

  /** 返回当前阶段之前、因手动完成待办而锁定的阶段位置。 */
  function lockedStageIndices(currentStage: string): Set<number> {
    const locked = new Set<number>()
    const current = stages.value.findIndex(stage => stage.key === currentStage)
    for (let target = 0; target < current; target++) {
      for (let index = target; index < current; index++) {
        const todos = stages.value[index].todos ?? []
        if (todos.length > 0 && todos.every(todo => todo.done && !todo.autoCompleted)) {
          locked.add(target)
          break
        }
      }
    }
    return locked
  }

  /**
   * 统一执行阶段切换，并保留前进自动完成、后退快照还原和完成状态切换语义。
   * 未提供当前阶段/状态引用时只用于阶段面板的增删排序，不执行切换。
   */
  function transitionStage(targetStage: string) {
    if (!currentStage || !status) return null

    const oldIndex = stages.value.findIndex(stage => stage.key === currentStage.value)
    const newIndex = stages.value.findIndex(stage => stage.key === targetStage)
    if (newIndex < 0) return null

    if (newIndex < oldIndex && lockedStageIndices(currentStage.value).has(newIndex)) return null

    const progress = calculateStageProgress(stages.value, targetStage)
    const transition = transitionProjectStage({
      stages: stages.value,
      currentStage: currentStage.value || null,
      progress,
      status: status.value as ProjectStatus,
    }, targetStage, progress)

    stages.value = transition.stages
    currentStage.value = transition.currentStage ?? ''
    status.value = transition.status
    return { oldIndex, newIndex, progress }
  }

  return { addStage, removeStage, lockedStageIndices, transitionStage }
}
