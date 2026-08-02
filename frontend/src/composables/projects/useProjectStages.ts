import type { Ref } from 'vue'
import type { ProjectStage } from '@/types/project'

interface ProjectStagesOptions {
  stages: Ref<ProjectStage[]>
  saveStages: () => void
}

/**
 * 项目阶段的响应式操作编排。
 * 阶段拖拽的指针、ghost 和落点计算仍由 ProjectStagesPanel 保留；这里不接触 DOM。
 * 待办操作由 useProjectTodos 单独负责，避免两个 composable 同时写入同一份 stages。
 */
export function useProjectStages(options: ProjectStagesOptions) {
  const { stages, saveStages } = options

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

  return { addStage, removeStage, lockedStageIndices }
}
