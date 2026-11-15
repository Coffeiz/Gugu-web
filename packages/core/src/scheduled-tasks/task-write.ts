import { normalizeSchedule, type ScheduleInput, type ScheduleSpec } from './normalize-schedule.js'

export interface ScheduledTaskCreateInput extends ScheduleInput {
  name: unknown
  event_id?: unknown
  [key: string]: unknown
}

export type ScheduledTaskPatch = Omit<Partial<ScheduleInput>, 'schedule_kind'> & {
  schedule_kind?: string | null
} & Record<string, unknown>

export interface ScheduledTaskCurrent {
  schedule_kind: string
  cron: string
  interval_minutes: number | null
  start_at: string | null
  end_at: string | null
  event_id: number | null
}

export interface ScheduledTaskPreparedUpdate {
  patch: ScheduledTaskPatch
  schedule: ScheduleSpec | null
}

type ScheduledTaskUpdateValidator = (
  current: ScheduledTaskCurrent,
  patch: ScheduledTaskPatch,
  schedule: ScheduleSpec | null,
) => Promise<void>

const scheduleFields = ['schedule_kind', 'cron', 'interval_minutes', 'start_at', 'end_at'] as const
const owns = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key)

/** 纯业务 DTO 规则；PG 持锁与事务由适配器提供，事务内仍调用此 Core 用例。 */
export function validateScheduledTaskWriteFields(input: Record<string, unknown>, create: boolean): void {
  if (create || input.name != null) {
    if (typeof input.name !== 'string' || (create && (!input.name.length || [...input.name].length > 100)))
      throw new TypeError('任务名称无效')
  }
  if (input.payload != null && typeof input.payload !== 'string') throw new TypeError('任务内容无效')
  if (input.enabled != null && typeof input.enabled !== 'boolean') throw new TypeError('enabled 必须是布尔值')
  if (input.channels != null && (!Array.isArray(input.channels) || input.channels.some(item => typeof item !== 'string')))
    throw new TypeError('channels 必须是字符串数组')
  if (input.authorized_tools != null && (!Array.isArray(input.authorized_tools) || input.authorized_tools.some(item => typeof item !== 'string')))
    throw new TypeError('authorized_tools 必须是字符串数组')
}

export function normalizeScheduledTaskChannels(value: unknown): string {
  const allowed = new Set(['web', 'email', 'feishu', 'qq', 'wechat', 'telegram', 'im', 'chat'])
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new TypeError('channels 必须是字符串数组')
  const result = [...new Set(value.filter((item): item is string => typeof item === 'string' && allowed.has(item)))]
  return result.length ? result.join(',') : 'web'
}

export function normalizeScheduledTaskTools(value: unknown): string[] {
  if (value == null) return []
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new TypeError('authorized_tools 必须是字符串数组')
  return value.includes('send_email') ? ['send_email'] : []
}

export function normalizeScheduledTaskContext(value: string | null): string | null {
  return value?.trim().slice(0, 128) || null
}

export interface ScheduledTaskCreateDependencies<T, I extends ScheduledTaskCreateInput> {
  validateCron(cron: string): void
  /** 完整 owner 校验、事务写入与重复活动提醒复用必须在适配器的一次事务中完成。 */
  persist(ownerId: string, input: I, schedule: ScheduleSpec, contextId: string | null): Promise<{ task: T; created: boolean }>
  publish(ownerId: string, task: T, origin: string | null): Promise<void>
}

/** 创建用例统一执行校验、调度规则、持久化及仅首次提交后的通知。 */
export async function createScheduledTask<T, I extends ScheduledTaskCreateInput>(
  deps: ScheduledTaskCreateDependencies<T, I>, ownerId: string, input: I,
  contextId: string | null, origin: string | null, now = Date.now(),
): Promise<{ task: T; created: boolean }> {
  validateScheduledTaskWriteFields(input, true)
  const schedule = normalizeSchedule(input, deps.validateCron, now)
  if (input.event_id != null && schedule.schedule_kind !== 'once') throw new TypeError('日历活动提醒必须使用 once 类型')
  const result = await deps.persist(ownerId, input, schedule, contextId)
  if (result.created) await deps.publish(ownerId, result.task, origin)
  return result
}

export interface ScheduledTaskUpdateDependencies<T> {
  validateCron(cron: string): void
  /** 实现方必须以 owner 限定行锁提供 current、校验回调和写入的同一事务。 */
  persist(
    ownerId: string,
    id: number,
    patch: ScheduledTaskPatch,
    prepare: (current: ScheduledTaskCurrent, validate: ScheduledTaskUpdateValidator) => Promise<ScheduledTaskPreparedUpdate>,
  ): Promise<T>
  publish(ownerId: string, task: T, origin: string | null): Promise<void>
}

/** 更新调度切换语义在 Core；引用、冲突锁及具体 SQL 由事务适配器完成。 */
export async function updateScheduledTask<T>(
  deps: ScheduledTaskUpdateDependencies<T>, ownerId: string, id: number,
  patch: ScheduledTaskPatch, origin: string | null, now = Date.now(),
): Promise<T> {
  validateScheduledTaskWriteFields(patch, false)
  const task = await deps.persist(ownerId, id, patch, async (current, validate) => {
    let schedule: ScheduleSpec | null = null
    if (scheduleFields.some(field => owns(patch, field))) {
      const kind = owns(patch, 'schedule_kind') ? patch.schedule_kind : current.schedule_kind
      const changed = kind !== current.schedule_kind
      const value = (field: 'interval_minutes' | 'start_at' | 'end_at') => owns(patch, field)
        ? patch[field]
        : changed ? null : current[field]
      schedule = normalizeSchedule({
        schedule_kind: kind as string,
        cron: owns(patch, 'cron') ? patch.cron : changed || kind !== 'cron' ? null : current.cron,
        interval_minutes: value('interval_minutes') as number | null,
        start_at: value('start_at') as string | null,
        end_at: value('end_at') as string | null,
      }, deps.validateCron, now)
      if (current.event_id != null && schedule.schedule_kind !== 'once')
        throw new TypeError('日历活动提醒必须使用 once 类型')
    }
    await validate(current, patch, schedule)
    return { patch, schedule }
  })
  await deps.publish(ownerId, task, origin)
  return task
}
