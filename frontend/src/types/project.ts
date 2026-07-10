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
