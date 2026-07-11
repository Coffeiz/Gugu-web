/**
 * 项目「阶段 + 待办」纯领域函数——**仅前端**：统一 UI / Store 的状态变换。
 *
 * 这套逻辑此前散在 stores/projects.ts（moveProject / setStage）、ProjectModal 等前端各处各写一遍，
 * 这里抽成**纯函数**（输入→输出、无 Vue 响应式、无副作用、无网络），便于单测与前端各处共用；
 * 真正需要响应式编排时再在外面包一层薄 composable。
 *
 * ⚠️ 不是「前后端单一代码源」：后端 Agent（Python）import 不了这份 TS，保持它**自己的领域实现**，
 *    靠 **API 契约 + 对称测试**保证与前端语义一致，别伪装成同一份代码。
 * ⚠️ 行为约定必须与 stores/projects.ts 现有实现逐字一致（迁移前端调用点时才不会引入回归）：
 *   - _savedDone / autoCompleted 是纯前端瞬态（见 types/project.ts）；
 *   - 「自动完成」= 阶段前进/项目收尾时把未完成待办勾上并快照原状态，拖回时按快照还原。
 */
import type { ProjectStage, ProjectTodo, ProjectStatus } from '@/types/project'

/**
 * 自动完成快照：未完成的待办标记为 autoCompleted 并勾上，快照原 done（false）到 _savedDone；
 * 已完成的原样保留（不动其真实状态）。返回新数组，不改原引用。
 * 对应 store.moveProject 收尾 / setStage 前进经过的阶段。
 */
export function autoCompleteTodos(todos: ProjectTodo[] = []): ProjectTodo[] {
  return todos.map(t => (t.done ? t : { ...t, _savedDone: false, done: true, autoCompleted: true }))
}

/**
 * 还原自动完成：把 autoCompleted 的待办恢复到快照 _savedDone（缺省 false）并清掉标记；
 * 非自动完成的原样保留。返回新数组。对应 store 撤销完成 / setStage 后退的阶段。
 */
export function restoreTodos(todos: ProjectTodo[] = []): ProjectTodo[] {
  return todos.map(t =>
    t.autoCompleted ? { ...t, done: t._savedDone ?? false, autoCompleted: false, _savedDone: undefined } : t,
  )
}

/** 勾选/取消指定 id 的待办，返回新数组（不改原引用）。 */
export function toggleTodoDone(todos: ProjectTodo[], id: string): ProjectTodo[] {
  return todos.map(t => (t.id === id ? { ...t, done: !t.done } : t))
}

/** 状态推进：pending → active → done；done 及未知无下一步，返回 null。 */
const _NEXT_STATUS: Record<string, ProjectStatus> = { pending: 'active', active: 'done' }
export function nextStatus(status: ProjectStatus): ProjectStatus | null {
  return _NEXT_STATUS[status] ?? null
}

/** 按阶段位置算进度：(当前阶段序号 + 1) / 阶段数 * 100；越界或空阶段返回 0。 */
export function stageProgressByIndex(idx: number, total: number): number {
  if (idx < 0 || total <= 0) return 0
  return Math.round(((idx + 1) / total) * 100)
}

// 规范化输入：阶段可以是纯字符串（只有名字）或 {key?, label?, todos?} 松对象
type LooseTodo = { id?: string; text?: string; done?: boolean; autoCompleted?: boolean; _savedDone?: boolean }
type LooseStage = string | { key?: string; label?: string; todos?: LooseTodo[] }

/**
 * 阶段规范化：把「字符串 / 松对象」混合输入统一成结构化 ProjectStage[]——
 * 补齐 key（缺省 s0/s1…）、label、todos 数组，每个 todo 补 id/text/done。
 * 用于新建项目、应用模板等入口，消除各处各自拼装。
 */
export function normalizeStages(raw: LooseStage[] = []): ProjectStage[] {
  return raw.map((s, i) => {
    const isStr = typeof s === 'string'
    const label = isStr ? s : (s.label ?? '')
    const key = !isStr && s.key ? s.key : `s${i}`
    const todos = isStr ? [] : (s.todos ?? [])
    return {
      key,
      label,
      todos: todos.map((t, j) => {
        const todo: ProjectTodo = { id: t.id ?? `td_${i}_${j}`, text: t.text ?? '', done: !!t.done }
        if (t.autoCompleted) todo.autoCompleted = true
        if (t._savedDone !== undefined) todo._savedDone = t._savedDone
        return todo
      }),
    }
  })
}
