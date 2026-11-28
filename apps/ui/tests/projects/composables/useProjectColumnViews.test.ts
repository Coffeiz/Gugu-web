// @vitest-environment node
import { computed, isReactive, reactive, ref } from 'vue'
import { describe, expect, it } from 'vitest'
import type { Project } from '@/types/project'
import { projectProgress } from '@/utils/projectProgress'
import { useProjectColumnViews } from '@/composables/projects/useProjectColumnViews'

describe('useProjectColumnViews', () => {
  it('切换排序后立即重排同列项目，未排期项目按截止日排序时放在最后', () => {
    const sort = ref<'default' | 'name' | 'deadline'>('default')
    const projects = [
      { id: 1, name: 'B', priority: 'high', deadline: null, status: 'active' },
      { id: 2, name: 'C', priority: 'low', deadline: '2026-11-23', status: 'active' },
      { id: 3, name: 'A', priority: 'low', deadline: '2026-11-28', status: 'active' },
    ] as Project[]
    const views = useProjectColumnViews({
      projects: computed(() => projects),
      liveFileCounts: computed(() => null),
      sort: () => sort.value,
    })
    const ids = () => views.columnProjects('active').map(project => project.id)

    expect(ids()).toEqual([1, 2, 3])
    sort.value = 'name'
    expect(ids()).toEqual([3, 1, 2])
    sort.value = 'deadline'
    expect(ids()).toEqual([2, 3, 1])
  })

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
    const cardProgress = computed(() => projectProgress(cardProject))

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
