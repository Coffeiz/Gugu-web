import { describe, it, expect } from 'vitest'
import {
  autoCompleteTodos, restoreTodos, toggleTodoDone,
  nextStatus, stageProgressByIndex, normalizeStages, firstIncompleteStageIdx, allTodosDone,
} from '@/utils/projectStages'
import type { ProjectTodo } from '@/types/project'

// 阶段/待办纯领域函数（P2 第一刀的地基，见 [[gugu-p2-refactor-plan]]）。
// 行为必须与 stores/projects.ts 现有实现逐字一致——这些断言就是「迁移调用点后行为不变」的护栏。

const td = (over: Partial<ProjectTodo> = {}): ProjectTodo => ({ id: 'x', text: 't', done: false, ...over })

describe('autoCompleteTodos — 自动完成快照', () => {
  it('未完成的待办：勾上 + 标 autoCompleted + 快照原 done 到 _savedDone', () => {
    const [r] = autoCompleteTodos([td({ id: 'a', done: false })])
    expect(r).toMatchObject({ id: 'a', done: true, autoCompleted: true, _savedDone: false })
  })
  it('已完成的待办：原样保留，不动其真实状态', () => {
    const done = td({ id: 'b', done: true })
    const [r] = autoCompleteTodos([done])
    expect(r).toBe(done)                       // 同一引用，未被复制/改写
    expect(r.autoCompleted).toBeUndefined()
  })
  it('返回新数组，不改原引用', () => {
    const src = [td({ done: false })]
    expect(autoCompleteTodos(src)).not.toBe(src)
  })
  it('空/缺省输入返回空数组', () => {
    expect(autoCompleteTodos()).toEqual([])
    expect(autoCompleteTodos([])).toEqual([])
  })
})

describe('restoreTodos — 还原自动完成', () => {
  it('autoCompleted 待办：恢复到快照 _savedDone、清掉标记', () => {
    const [r] = restoreTodos([td({ id: 'a', done: true, autoCompleted: true, _savedDone: false })])
    expect(r).toMatchObject({ id: 'a', done: false, autoCompleted: false, _savedDone: undefined })
  })
  it('_savedDone 缺省按 false 还原', () => {
    const [r] = restoreTodos([td({ done: true, autoCompleted: true })])
    expect(r.done).toBe(false)
  })
  it('非 autoCompleted 待办：原样保留（含用户手动勾的真完成）', () => {
    const manual = td({ id: 'm', done: true })
    const [r] = restoreTodos([manual])
    expect(r).toBe(manual)
  })
})

describe('autoComplete → restore 往返：还原到原始 done 状态', () => {
  it('混合列表往返后各待办 done 与初始一致', () => {
    const orig: ProjectTodo[] = [
      td({ id: 'a', done: false }),
      td({ id: 'b', done: true }),          // 用户真勾的，往返后仍应是 true
      td({ id: 'c', done: false }),
    ]
    const restored = restoreTodos(autoCompleteTodos(orig))
    expect(restored.map(t => t.done)).toEqual([false, true, false])
    expect(restored.every(t => !t.autoCompleted)).toBe(true)
  })
})

describe('toggleTodoDone', () => {
  it('翻转目标待办的 done，其余不变', () => {
    const src = [td({ id: 'a', done: false }), td({ id: 'b', done: true })]
    const out = toggleTodoDone(src, 'a')
    expect(out[0].done).toBe(true)
    expect(out[1]).toBe(src[1])              // 未命中的原样保留引用
  })
  it('id 不存在则全数组原样（值相等）', () => {
    const src = [td({ id: 'a' })]
    expect(toggleTodoDone(src, 'zzz')).toEqual(src)
  })
})

describe('nextStatus — 状态推进', () => {
  it('pending → active → done → null', () => {
    expect(nextStatus('pending')).toBe('active')
    expect(nextStatus('active')).toBe('done')
    expect(nextStatus('done')).toBeNull()
  })
})

describe('stageProgressByIndex — 按阶段位置算进度', () => {
  it('(idx+1)/total*100，四舍五入', () => {
    expect(stageProgressByIndex(0, 3)).toBe(33)
    expect(stageProgressByIndex(1, 3)).toBe(67)
    expect(stageProgressByIndex(2, 3)).toBe(100)
  })
  it('越界/空阶段返回 0', () => {
    expect(stageProgressByIndex(-1, 3)).toBe(0)
    expect(stageProgressByIndex(0, 0)).toBe(0)
  })
})

describe('normalizeStages — 规范化', () => {
  it('字符串阶段 → {key:s{i}, label, todos:[]}', () => {
    expect(normalizeStages(['计划', '交付'])).toEqual([
      { key: 's0', label: '计划', todos: [] },
      { key: 's1', label: '交付', todos: [] },
    ])
  })
  it('松对象保留 key/label，todos 补 id/text/done', () => {
    const [s] = normalizeStages([{ label: '执行', todos: [{ text: '写代码' }, { done: true }] }])
    expect(s.key).toBe('s0')
    expect(s.label).toBe('执行')
    expect(s.todos[0]).toMatchObject({ text: '写代码', done: false })
    expect(s.todos[0].id).toBeTruthy()
    expect(s.todos[1].done).toBe(true)
  })
  it('保留已有 key 与瞬态字段（autoCompleted/_savedDone）', () => {
    const [s] = normalizeStages([{ key: 'kX', label: 'L', todos: [{ id: 't1', done: true, autoCompleted: true, _savedDone: false }] }])
    expect(s.key).toBe('kX')
    expect(s.todos[0]).toMatchObject({ id: 't1', autoCompleted: true, _savedDone: false })
  })
  it('空/缺省输入返回空数组', () => {
    expect(normalizeStages()).toEqual([])
  })
})

describe('firstIncompleteStageIdx — 当前应处于的阶段 = 第一个未完成阶段', () => {
  const stage = (todos: Partial<ProjectTodo>[]) => ({ key: 'k', label: 'L', todos: todos.map((t, i) => td({ id: 'i' + i, ...t })) })
  it('阶段1、2完成，阶段3未完成 → 落在阶段3（跳过已完成的中间阶段）', () => {
    const stages = [stage([{ done: true }]), stage([{ done: true }]), stage([{ done: false }])]
    expect(firstIncompleteStageIdx(stages)).toBe(2)
  })
  it('阶段1未完成、阶段2完成 → 落在阶段1（第一个未完成，在前面）', () => {
    const stages = [stage([{ done: false }]), stage([{ done: true }])]
    expect(firstIncompleteStageIdx(stages)).toBe(0)
  })
  it('全部完成 → 落在最后一个阶段', () => {
    const stages = [stage([{ done: true }]), stage([{ done: true }])]
    expect(firstIncompleteStageIdx(stages)).toBe(1)
  })
  it('空阶段（无待办）视为完成、被跳过', () => {
    const stages = [stage([{ done: true }]), stage([]), stage([{ done: false }])]
    expect(firstIncompleteStageIdx(stages)).toBe(2)
  })
  it('单阶段未完成 → 0', () => {
    expect(firstIncompleteStageIdx([stage([{ done: false }])])).toBe(0)
  })
})

describe('allTodosDone — 进入已完成的闸门', () => {
  const stage = (todos: Partial<ProjectTodo>[]) => ({ key: 'k', label: 'L', todos: todos.map((t, i) => td({ id: 'i' + i, ...t })) })
  it('全部打勾 → true', () => {
    expect(allTodosDone([stage([{ done: true }]), stage([{ done: true }])])).toBe(true)
  })
  it('任一未打勾 → false（即便在最后阶段之外）', () => {
    expect(allTodosDone([stage([{ done: false }]), stage([{ done: true }])])).toBe(false)
  })
  it('空阶段 / 全无待办 → true（位置型项目仍可完成）', () => {
    expect(allTodosDone([stage([]), stage([])])).toBe(true)
  })
})
