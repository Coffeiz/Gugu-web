import { CoreError } from '../contracts/index.js'
import type { ProjectRecord } from '../contracts/index.js'
import { utc } from '../shared/timestamps.js'

function stages(raw: string): Record<string, unknown>[] {
  let value: unknown
  try { value = JSON.parse(raw) }
  catch (error) { if (error instanceof SyntaxError) return []; throw error }
  // Python Project.stages仅容忍解析失败；合法JSON仍须符合API的list[dict]响应契约。
  if (!Array.isArray(value) || value.some(stage => stage === null || typeof stage !== 'object' || Array.isArray(stage)))
    throw new CoreError('storage_error', '项目阶段数据无效')
  return value as Record<string, unknown>[]
}

/** 管理API共用投影，避免读取与写入回执出现不同的阶段/时间字段。 */
export function projectResponse(project: ProjectRecord, fileCount: number) {
  return {
    id: project.id, name: project.name, client: project.client, status: project.status,
    startDate: project.start_date, deadline: project.deadline, color: project.color, progress: project.progress,
    stages: stages(project.stages_json), currentStage: project.current_stage, archived: project.archived,
    priority: project.priority, version: project.version || 1,
    doneAt: project.done_at == null ? null : utc(project.done_at).replace(' ', 'T'),
    updatedAt: utc(project.updated_at).replace(' ', 'T'),
    deletedAt: project.deleted_at == null ? null : utc(project.deleted_at).replace(' ', 'T'),
    createdAt: utc(project.created_at).slice(0, 10), fileCount,
  }
}
