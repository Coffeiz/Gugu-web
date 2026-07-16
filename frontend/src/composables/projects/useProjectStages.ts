import type { Ref } from 'vue'
import type { ProjectStage, ProjectTodo } from '@/types/project'

interface ProjectStagesOptions {
  stages: Ref<ProjectStage[]>
  saveStages: () => void
  saveTodos: () => void
}

/**
 * 阶段和待办的响应式操作编排。
 * 阶段拖拽的指针、ghost 和落点计算仍由 ProjectModal 保留；这里不接触 DOM。
 */
export function useProjectStages(options: ProjectStagesOptions) {
  const { stages, saveStages, saveTodos } = options

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

  function addTodo(stage: ProjectStage) {
    if (!stage.todos) stage.todos = []
    stage.todos.push({ id: `td_${Date.now()}`, text: '', done: false })
    saveTodos()
  }

  function removeTodo(stage: ProjectStage, id: string) {
    stage.todos = (stage.todos ?? []).filter(todo => todo.id !== id)
    saveTodos()
  }

  // 不在这里自动 saveTodos——调用方（ProjectStagesPanel.handleToggleTodo）勾完待办后
  // 可能紧接着触发阶段自动推进（setStage），那条路径自己会保存一次完整状态；这里如果也
  // 保存一次，同一个点击事件里 localStages 会被整体替换两次，触发 TransitionGroup 递归
  // 更新（2026-07-17 手动验收环境复现：Maximum recursive updates exceeded in <BaseTransition>）。
  function toggleTodo(todo: ProjectTodo) {
    todo.done = !todo.done
    todo.autoCompleted = false
  }

  return { addStage, removeStage, addTodo, removeTodo, toggleTodo }
}
