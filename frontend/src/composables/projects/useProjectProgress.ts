import type { ProjectStage } from '@/types/project'

/** 按当前阶段位置和该阶段待办完成度计算持久化进度。 */
export function calculateStageProgress(stages: ProjectStage[], currentStageKey: string): number {
  if (!stages.length) return 0
  const index = stages.findIndex(stage => stage.key === currentStageKey)
  if (index < 0) return 0

  const stageWeight = 100 / stages.length
  const todos = stages[index].todos ?? []
  const withinStage = todos.length > 0
    ? (todos.filter(todo => todo.done).length / todos.length) * stageWeight
    : stageWeight

  return Math.round(index * stageWeight + withinStage)
}

/** 顶部展示进度：有待办时按全部阶段待办完成度，否则退回当前阶段位置进度。 */
export function calculateHeaderProgress(stages: ProjectStage[], currentStageKey: string): number {
  if (!stages.length) return 0

  let done = 0
  let total = 0
  for (const stage of stages) {
    const todos = stage.todos ?? []
    done += todos.filter(todo => todo.done).length
    total += todos.length
  }

  return total > 0
    ? Math.round(done / total * 100)
    : calculateStageProgress(stages, currentStageKey)
}
