import { describe, expect, it } from 'vitest'
import { useProjectDraft } from './useProjectDraft'
import type { Project, ProjectStage } from '@/types/project'

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 1, name: '原名称', status: 'active', client: '', color: '',
    startDate: '2026-08-04', deadline: '2026-08-20', currentStage: 'C.4',
    stages: [{ key: 'C.4', label: 'C.4', todos: [{ id: 't1', text: '待办一', done: false }] }],
    ...overrides,
  } as Project
}

describe('useProjectDraft.syncExternal', () => {
  it('用户未动过的字段采用服务端最新值且不产生脏标记', () => {
    const draft = useProjectDraft()
    draft.reset(project())

    draft.syncExternal(project({
      name: '咕咕改的新名称',
      stages: [{
        key: 'C.4', label: 'C.4',
        todos: [{ id: 't1', text: '待办一', done: true }, { id: 't2', text: '咕咕新加的待办', done: false }],
      }],
    }))

    expect(draft.localName.value).toBe('咕咕改的新名称')
    expect(draft.localStages.value[0].todos).toHaveLength(2)
    expect(draft.localStages.value[0].todos[0].done).toBe(true)
    expect(draft.isDirty.value).toBe(false)
  })

  it('用户已编辑的字段保留草稿，保存时用户编辑胜出', () => {
    const draft = useProjectDraft()
    draft.reset(project())

    draft.localName.value = '我正在改的名称'
    expect(draft.isDirty.value).toBe(true)

    draft.syncExternal(project({ name: '咕咕同时改的名称', deadline: '2026-09-01' }))

    // 用户编辑保留，未动字段（deadline）同步，baseline 推进到服务端值
    expect(draft.localName.value).toBe('我正在改的名称')
    expect(draft.localDeadline.value).toBe('2026-09-01')
    expect(draft.isDirty.value).toBe(true)
  })

  it('外部同步后用户再撤销自己的编辑，会落到服务端最新值', () => {
    const draft = useProjectDraft()
    draft.reset(project())

    draft.localStatus.value = 'done'
    draft.syncExternal(project({ name: '新名称' }))
    draft.localStatus.value = 'active' // 恰好改回与服务端一致的值

    expect(draft.isDirty.value).toBe(false)
    expect(draft.localName.value).toBe('新名称')
  })
})
