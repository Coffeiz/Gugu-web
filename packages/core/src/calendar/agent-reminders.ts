import { EventCreateError, type CalendarEventCreateInput, type EventCreateReminderRecord, type PreparedEventReminder } from './application/event-create.js'

export interface CalendarReminderIntent {
  lead_minutes: number
  channels?: readonly string[]
  delivery_mode?: 'owner_private' | 'current_group'
  enabled?: boolean
}

export interface ResolvedCalendarReminder {
  channels: readonly string[]
  deliveryTargets: unknown
  enabled: boolean
}

const channels = new Set(['web', 'feishu', 'qq', 'wechat'])

/** 时区规则与 Python SCHEDULE_TZ 一致：事件日期/时间按 Asia/Shanghai 墙上时间计算。 */
export function prepareCalendarEventReminder(
  event: CalendarEventCreateInput,
  intent: CalendarReminderIntent,
  resolved: ResolvedCalendarReminder,
  now: number,
): PreparedEventReminder {
  const lead = intent.lead_minutes
  if (!Number.isSafeInteger(lead)) throw new EventCreateError(422, 'lead_minutes 需为整数分钟（0=活动开始时）')
  if (lead < 0) throw new EventCreateError(422, 'lead_minutes 不能为负')
  const date = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(event.date)
  if (!date) throw new EventCreateError(422, '事件日期无效')
  const [year, month, day] = date.slice(1).map(Number) as [number, number, number]
  const [hour, minute] = (event.time || '09:00').split(':').map(Number) as [number, number]
  const base = new Date(0)
  base.setUTCFullYear(year, month - 1, day); base.setUTCHours(hour, minute, 0, 0)
  if (base.getUTCFullYear() !== year || base.getUTCMonth() !== month - 1 || base.getUTCDate() !== day
    || !Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59)
    throw new EventCreateError(422, '事件日期或时间无效')
  const fireWall = base.getTime() - lead * 60_000, fireUtc = fireWall - 8 * 60 * 60 * 1000
  if (resolved.enabled && fireUtc <= now) {
    const fire = new Date(fireWall)
    const formatted = `${fire.getUTCFullYear()}-${String(fire.getUTCMonth() + 1).padStart(2, '0')}-${String(fire.getUTCDate()).padStart(2, '0')} ${String(fire.getUTCHours()).padStart(2, '0')}:${String(fire.getUTCMinutes()).padStart(2, '0')}`
    throw new EventCreateError(422, `提前 ${lead} 分钟（${formatted}）已过，跳过`)
  }
  const normalizedChannels = [...new Set(resolved.channels.filter(value => channels.has(value)))]
  if (!normalizedChannels.length) normalizedChannels.push('web')
  const startAt = new Date(fireUtc)
  return {
    leadMinutes: lead,
    channels: normalizedChannels.join(','),
    deliveryTargets: resolved.deliveryTargets,
    enabled: resolved.enabled,
    cron: `@once:${startAt.toISOString().replace('.000Z', '+00:00')}`,
    startAt,
    scheduleKind: 'once',
    name: `${event.title} 提醒`,
    payload: `提醒：${event.title}（${event.date}${event.time ? ` ${event.time}` : ''}）`,
  }
}

export function calendarReminderBrief(reminder: EventCreateReminderRecord) {
  const selected = reminder.channels.split(',').filter(Boolean)
  const targets = reminder.deliveryTargets as { qq?: { chat_type?: string } } | null
  return {
    lead_minutes: reminder.leadMinutes,
    channels: selected,
    enabled: reminder.enabled,
    ...(selected.includes('qq') ? { delivery_mode: targets?.qq?.chat_type === 'group' ? 'current_group' : 'owner_private' } : {}),
  }
}
