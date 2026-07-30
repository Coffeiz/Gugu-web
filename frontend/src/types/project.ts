// 项目看板领域模型——Projects 模块的单一类型来源（P1-b TS 严格化）。
// 服务端字段绑定 OpenAPI 生成的 ProjectResponse（避免手抄漂移），只在前端收紧两处 + 追加瞬态：
//   - status：后端是宽松 string，前端收紧成三态联合；
//   - stages：后端是 `{[k]:unknown}[]`（未结构化），前端收紧成 ProjectStage[]。
// 收紧发生在 api 边界（stores/projects.ts 的 fetch/create 处一次性 cast），下游全用紧类型。
// 下划线前缀（_savedDone / _stageBeforeDone）= 纯前端瞬态，不落库，仅供乐观更新/还原逻辑用。
import type { components } from '@/types/api'

type ProjectWire = components['schemas']['ProjectResponse']

export type ProjectStatus = 'pending' | 'active' | 'done'

export interface ProjectTodo {
  id: string
  text: string
  done: boolean
  /** 阶段前进/项目收尾时被自动打勾的标记，拖回时据此还原 */
  autoCompleted?: boolean
  /** 自动打勾前的原 done 快照，用于还原 */
  _savedDone?: boolean
}

export interface ProjectStage {
  key: string
  label: string
  todos: ProjectTodo[]
}

export interface Project extends Omit<ProjectWire, 'status' | 'stages'> {
  status: ProjectStatus
  stages: ProjectStage[]
  /** 拖入「已完成」前的当前阶段，拖回进行中时还原（纯前端瞬态） */
  _stageBeforeDone?: string | null
}

function isProjectStatus(value: unknown): value is ProjectStatus {
  return value === 'pending' || value === 'active' || value === 'done'
}

function mapTodo(value: unknown): ProjectTodo {
  if (!value || typeof value !== 'object') throw new Error('项目待办数据格式异常')
  const todo = value as Record<string, unknown>
  if (typeof todo.id !== 'string' || typeof todo.text !== 'string' || typeof todo.done !== 'boolean') {
    throw new Error('项目待办数据格式异常')
  }
  const mapped: ProjectTodo = { id: todo.id, text: todo.text, done: todo.done }
  if (typeof todo.autoCompleted === 'boolean') mapped.autoCompleted = todo.autoCompleted
  if (typeof todo._savedDone === 'boolean') mapped._savedDone = todo._savedDone
  return mapped
}

function mapStage(value: unknown): ProjectStage {
  if (!value || typeof value !== 'object') throw new Error('项目阶段数据格式异常')
  const stage = value as Record<string, unknown>
  if (typeof stage.key !== 'string' || typeof stage.label !== 'string' || !Array.isArray(stage.todos)) {
    throw new Error('项目阶段数据格式异常')
  }
  return { key: stage.key, label: stage.label, todos: stage.todos.map(mapTodo) }
}

/** API 响应进入前端领域层的唯一入口，拒绝宽松 JSON 静默流入项目交互代码。 */
export function mapProjectResponse(wire: ProjectWire): Project {
  if (!isProjectStatus(wire.status) || !Array.isArray(wire.stages)) {
    throw new Error('项目数据格式异常')
  }
  return { ...wire, status: wire.status, stages: wire.stages.map(mapStage) }
}
