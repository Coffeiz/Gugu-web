import type { Ref } from 'vue'
import { firstIncompleteStageIdx } from '@/utils/projectStages'
import type { ProjectStage, ProjectTodo } from '@/types/project'

interface ProjectStagesOptions {
  stages: Ref<ProjectStage[]>
  currentStage: Ref<string>
  saveStages: () => void
  saveTodos: () => void
  setStage: (key: string, index: number) => void
}

/**
 * 阶段和待办的响应式操作编排。
 * 阶段拖拽的指针、ghost 和落点计算仍由 ProjectModal 保留；这里不接触 DOM。
 */
export function useProjectStages(options: ProjectStagesOptions) {
  const { stages, currentStage, saveStages, saveTodos, setStage } = options

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

  function toggleTodo(todo: ProjectTodo) {
    todo.done = !todo.done
    todo.autoCompleted = false
    saveTodos()
    // 不在这里推进阶段，避免递归更新；由 saveTodos 触发后的 watch 或 saveTodos 内部处理
  }

  return { addStage, removeStage, addTodo, removeTodo, toggleTodo }
}
