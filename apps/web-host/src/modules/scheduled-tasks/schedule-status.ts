const SCHEDULE_KINDS = new Set(['cron', 'interval', 'once'])

export class ScheduleValidationError extends Error {
  constructor(message: string, readonly field = 'schedule') {
    super(message)
    this.name = 'ScheduleValidationError'
  }
}

export interface ScheduledTaskStatusRecord {
  schedule_kind: unknown
  end_at: Date | string | null
  enabled: boolean
}

export function taskScheduleKind(task: Pick<ScheduledTaskStatusRecord, 'schedule_kind'>): string {
  const kind = task.schedule_kind
  if (typeof kind !== 'string' || !SCHEDULE_KINDS.has(kind)) {
    throw new ScheduleValidationError('数据库中的 schedule_kind 非法', 'schedule_kind')
  }
  return kind
}

function timestamp(value: Date | string): number {
  const result = value instanceof Date ? value.getTime() : Date.parse(
    /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ? value : `${value}Z`,
  )
  if (!Number.isFinite(result)) throw new RangeError('定时任务时间无效')
  return result
}

/** 与 Python `is_task_ended` 一致：once 不因 end_at 结束，naive 时间按 UTC 解释。 */
export function isTaskEnded(
  task: Pick<ScheduledTaskStatusRecord, 'schedule_kind' | 'end_at'>,
  now: Date | string | number = Date.now(),
): boolean {
  const endAt = task.end_at
  if (endAt === null || taskScheduleKind(task) === 'once') return false
  const current = now instanceof Date || typeof now === 'string' ? timestamp(now) : now
  if (!Number.isFinite(current)) throw new RangeError('当前时间无效')
  return timestamp(endAt) <= current
}

export function scheduleStatus(
  task: ScheduledTaskStatusRecord,
  now: Date | string | number = Date.now(),
): 'ended' | 'disabled' | 'active' {
  if (isTaskEnded(task, now)) return 'ended'
  if (!task.enabled) return 'disabled'
  return 'active'
}
