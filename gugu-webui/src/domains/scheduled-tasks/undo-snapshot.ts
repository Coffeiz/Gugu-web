export interface ScheduledTaskUndoSnapshotInput {
  id: number
  enabled: boolean
  name: string
  payload: string
  cron: string
  schedule_kind: string
  start_at: Date | string | null
  reminder_lead_minutes: number | null
  channels: string | null
  delivery_targets: unknown
}

function isoStartAt(value: Date | string | null): string | null {
  if (value === null) return null
  return value instanceof Date ? value.toISOString() : value
}

/** 为日历和项目 Undo 生成相同的 scheduled_tasks 快照字段。 */
export function scheduledTaskUndoSnapshot(
  task: ScheduledTaskUndoSnapshotInput,
  formatStartAt: (value: Date | string | null) => string | null = isoStartAt,
): Record<string, unknown> {
  return {
    id: task.id,
    enabled: Boolean(task.enabled),
    name: task.name,
    payload: task.payload,
    cron: task.cron,
    schedule_kind: task.schedule_kind,
    start_at: formatStartAt(task.start_at),
    reminder_lead_minutes: task.reminder_lead_minutes,
    channels: task.channels,
    delivery_targets: task.delivery_targets,
  }
}
