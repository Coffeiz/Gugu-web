import { normalizeSchedule, type ScheduleInput, type ScheduleSpec } from './normalize-schedule.js'

export type TaskPatch = Partial<ScheduleInput> & Record<string, unknown>
export interface CurrentTask { schedule_kind: string; cron: string; interval_minutes: number | null; start_at: string | null; end_at: string | null; event_id: number | null }
export interface TaskUpdateDependencies<T> {
  validateCron(cron: string): void
  /** 行锁、授权撤销、目标及附件验证、冲突检查和写入均由同一事务完成。 */
  transaction(ownerId: string, id: number, update: (current: CurrentTask) => Promise<{ patch: TaskPatch; schedule: ScheduleSpec | null }>): Promise<T>
  validate(ownerId: string, current: CurrentTask, patch: TaskPatch, schedule: ScheduleSpec | null): Promise<void>
  publish(ownerId: string, task: T, origin: string | null): Promise<void>
}
const scheduleFields = ['schedule_kind', 'cron', 'interval_minutes', 'start_at', 'end_at'] as const
const owns = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key)

export async function updateScheduledTask<T>(deps: TaskUpdateDependencies<T>, ownerId: string, id: number, patch: TaskPatch, origin: string | null, now = Date.now()): Promise<T> {
  const task = await deps.transaction(ownerId, id, async current => {
    let schedule: ScheduleSpec | null = null
    if (scheduleFields.some(field => owns(patch, field))) {
      const kind = owns(patch, 'schedule_kind') ? patch.schedule_kind : current.schedule_kind
      const changed = kind !== current.schedule_kind
      const value = (field: 'cron' | 'interval_minutes' | 'start_at' | 'end_at') => owns(patch, field) ? patch[field] : changed ? null : current[field]
      schedule = normalizeSchedule({
        schedule_kind: kind as string,
        cron: owns(patch, 'cron') ? patch.cron : changed || kind !== 'cron' ? null : current.cron,
        interval_minutes: value('interval_minutes') as number | null,
        start_at: value('start_at') as string | null,
        end_at: value('end_at') as string | null,
      }, deps.validateCron, now)
      if (current.event_id != null && schedule.schedule_kind !== 'once') throw new TypeError('日历活动提醒必须使用 once 类型')
    }
    await deps.validate(ownerId, current, patch, schedule)
    return { patch, schedule }
  })
  await deps.publish(ownerId, task, origin)
  return task
}
