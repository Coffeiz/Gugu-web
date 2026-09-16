// @vitest-environment node
import { computed, isReactive, reactive } from 'vue'
import { describe, expect, it } from 'vitest'
import type { Project } from '@/types/project'
import { projectTodoProgress } from '@/utils/projectStages'
import { useProjectColumnViews } from './useProjectColumnViews'

describe('useProjectColumnViews', () => {
  it('文件数派生副本中的 stage todo 变化会刷新项目卡，同时保留稳定引用', () => {
    const source = reactive({
      id: 7,
      status: 'active',
      fileCount: 4,
      priority: null,
      deadline: null,
      startDate: null,
      doneAt: null,
      currentStage: 's0',
      stages: [{
        key: 's0',
        label: '阶段一',
        todos: [
          { id: 't1', text: '待办一', done: false },
          { id: 't2', text: '待办二', done: true },
        ],
      }],
    } as unknown as Project)
    const views = useProjectColumnViews({
      projects: computed(() => [source]),
      liveFileCounts: computed(() => new Map([[source.id, 0]])),
    })

    const firstList = views.columnProjects('active')
    const cardProject = firstList[0]
    const cardProgress = computed(() => projectTodoProgress(cardProject.stages, cardProject.currentStage))

    expect(cardProject.fileCount).toBe(0)
    expect(isReactive(cardProject)).toBe(true)
    expect(cardProgress.value).toBe(50)

    source.stages = [{
      ...source.stages[0],
      todos: source.stages[0].todos.map(todo => ({ ...todo, done: true })),
    }]

    const updatedList = views.columnProjects('active')
    expect(updatedList).toBe(firstList)
    expect(updatedList[0]).toBe(cardProject)
    expect(cardProgress.value).toBe(100)
  })
})
