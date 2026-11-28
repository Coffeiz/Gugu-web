import { ref, type Ref } from 'vue'
import { firstIncompleteStageIdx } from '@/utils/projectStages'
import type { ProjectStage, ProjectTodo } from '@/types/project'

interface ProjectTodosOptions {
  stages: Ref<ProjectStage[]>
  currentStage: () => string
  saveTodos: () => void
  setStage: (key: string, index: number) => void
}

/**
 * 项目待办的领域操作边界。
 *
 * 这里只改项目草稿并通知宿主保存，不接触 DOM；跨阶段拖拽仍留在阶段面板，
 * 因为它需要面板的拖拽落点和视觉 ghost。勾选待办触发阶段推进时只保存一次，
 * 避免同一 tick 内替换两次 stages 引起 TransitionGroup 递归更新。
 */
export function useProjectTodos(options: ProjectTodosOptions) {
  const { stages, currentStage, saveTodos, setStage } = options
  const editingTodo = ref<string | null>(null)

  function addTodo(stage: ProjectStage) {
    stage.todos ??= []
    stage.todos.push({ id: `td_${Date.now()}`, text: '', done: false })
    saveTodos()
  }

  function removeTodo(stage: ProjectStage, id: string) {
    if (editingTodo.value === id) editingTodo.value = null
    stage.todos = (stage.todos ?? []).filter(todo => todo.id !== id)
    saveTodos()
  }

  function startEditing(todoId: string) {
    editingTodo.value = todoId
  }

  function stopEditing() {
    editingTodo.value = null
  }

  /** 返回 true 表示已触发阶段推进，调用方不要再次保存待办。 */
  function toggleTodo(todo: ProjectTodo): boolean {
    todo.done = !todo.done
    todo.autoCompleted = false
    if (!todo.done) return false

    const currentIndex = stages.value.findIndex(stage => stage.key === currentStage())
    const targetIndex = firstIncompleteStageIdx(stages.value)
    if (targetIndex > currentIndex) {
      setStage(stages.value[targetIndex].key, targetIndex)
      return true
    }
    return false
  }

  return { editingTodo, addTodo, removeTodo, startEditing, stopEditing, toggleTodo }
}
