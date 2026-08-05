import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { useProjectTodos } from '@/composables/projects/useProjectTodos'
import type { ProjectStage } from '@/types/project'

const stages = (): ProjectStage[] => [
  { key: 'one', label: '一', todos: [{ id: 'a', text: 'A', done: false }] },
  { key: 'two', label: '二', todos: [{ id: 'b', text: 'B', done: false }] },
]

describe('useProjectTodos', () => {
  it('新增和删除待办通过统一保存回调通知宿主', () => {
    const state = ref(stages())
    const save = vi.fn()
    const todos = useProjectTodos({ stages: state, currentStage: () => 'one', saveTodos: save, setStage: vi.fn() })
    todos.addTodo(state.value[0])
    expect(state.value[0].todos).toHaveLength(2)
    todos.removeTodo(state.value[0], 'a')
    expect(state.value[0].todos).toHaveLength(1)
    expect(state.value[0].todos[0].text).toBe('')
    expect(save).toHaveBeenCalledTimes(2)
  })

  it('完成当前阶段最后一项时推进阶段且只交给推进回调保存', () => {
    const state = ref(stages())
    const save = vi.fn()
    const setStage = vi.fn()
    const todos = useProjectTodos({ stages: state, currentStage: () => 'one', saveTodos: save, setStage })
    expect(todos.toggleTodo(state.value[0].todos[0])).toBe(true)
    expect(setStage).toHaveBeenCalledWith('two', 1)
    expect(save).not.toHaveBeenCalled()
  })

  it('取消完成或普通勾选不会触发阶段推进', () => {
    const state = ref(stages())
    state.value[0].todos[0].done = true
    const setStage = vi.fn()
    const todos = useProjectTodos({ stages: state, currentStage: () => 'two', saveTodos: vi.fn(), setStage })
    expect(todos.toggleTodo(state.value[0].todos[0])).toBe(false)
    expect(setStage).not.toHaveBeenCalled()
  })

  it('编辑态由待办边界维护，删除当前编辑项时自动结束编辑', () => {
    const state = ref(stages())
    const todos = useProjectTodos({ stages: state, currentStage: () => 'one', saveTodos: vi.fn(), setStage: vi.fn() })
    todos.startEditing('a')
    expect(todos.editingTodo.value).toBe('a')
    todos.removeTodo(state.value[0], 'a')
    expect(todos.editingTodo.value).toBeNull()
  })
})
