import { normalizeSchedule, type ScheduleInput, type ScheduleSpec } from './normalize-schedule.js'

export interface TaskCreateInput extends ScheduleInput {
  name: string; payload?: string; channels?: string[]; enabled?: boolean; event_id?: number | null
  workspace_id?: number | null; authorized_tools?: string[]; email_attachment_file_ids?: number[]
  im_delivery?: Record<string, unknown> | null; qq_delivery?: Record<string, unknown> | null
}
export interface TaskCreateDependencies<T> {
  validateCron(cron: string): void
  /** 检查 workspace、附件、活动 owner，解析 IM 目标；失败时不得写入。 */
  validate(ownerId: string, input: TaskCreateInput, schedule: ScheduleSpec): Promise<Record<string, unknown>>
  /** 在同一事务执行提醒幂等、写入与日历 Undo 合并；重复请求返回原记录且 created=false。 */
  insert(ownerId: string, input: TaskCreateInput, schedule: ScheduleSpec, validated: Record<string, unknown>, contextId: string | null): Promise<{ task: T; created: boolean }>
  publish(ownerId: string, task: T, origin: string | null): Promise<void>
}

export async function createScheduledTask<T>(deps: TaskCreateDependencies<T>, ownerId: string, input: TaskCreateInput, contextId: string | null, origin: string | null, now = Date.now()): Promise<T> {
  if (typeof input.name !== 'string' || input.name.length < 1 || input.name.length > 100) throw new TypeError('任务名称长度必须为 1 至 100')
  const schedule = normalizeSchedule(input, deps.validateCron, now)
  if (input.event_id != null && schedule.schedule_kind !== 'once') throw new TypeError('日历活动提醒必须使用 once 类型')
  const validated = await deps.validate(ownerId, input, schedule)
  const { task, created } = await deps.insert(ownerId, input, schedule, validated, contextId)
  if (created) await deps.publish(ownerId, task, origin)
  return task
}
