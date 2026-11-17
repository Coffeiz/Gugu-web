import { CoreError, dataContext } from '../../contracts/index.js'
import { calendarEventResponse } from '../event-projection.js'
import type { CalendarEventProjectionInput } from '../event-projection.js'
import type { EventUpdateReminderRecord } from './event-update.js'
import { utc } from '../../data/codec.js'

export interface CalendarReadOptions { readonly signal?: AbortSignal }
export interface AgentEventQuery { from?: string; to?: string; type?: string; limit: number }
export interface CalendarAgentReadPort {
  list(ownerId: string, query: AgentEventQuery, signal?: AbortSignal): Promise<{
    events: readonly CalendarEventProjectionInput[]
    reminders: ReadonlyMap<number, readonly EventUpdateReminderRecord[]>
  }>
  getById?(ownerId: string, eventId: number, signal?: AbortSignal): Promise<CalendarEventProjectionInput | null>
  findByTitle?(ownerId: string, title: string, signal?: AbortSignal): Promise<readonly CalendarEventProjectionInput[]>
}

/** Python round 的 half-even，保留旧提醒的微秒，不用 JS Math.round 改变半分钟边界。 */
function reminderLead(event: CalendarEventProjectionInput, task: EventUpdateReminderRecord): number | null {
  if (task.reminder_lead_minutes !== null) return task.reminder_lead_minutes
  if (task.schedule_kind !== 'once' || task.start_at === null) return null
  const [hour, minutePart] = (event.time || '09:00').split(':')
  const wallTime = `${Number(hour).toString().padStart(2, '0')}:${Number(minutePart).toString().padStart(2, '0')}`
  const base = new Date(`${event.date}T${wallTime}:00Z`)
  if (!Number.isFinite(base.getTime()) || base.toISOString().slice(0, 10) !== event.date) throw new Error('活动时间无效')
  const stamp = utc(task.start_at instanceof Date ? task.start_at.toISOString() : task.start_at)
  const fire = new Date(stamp.replace(' ', 'T'))
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(fire).map(part => [part.type, part.value]))
  const wall = new Date(`${parts.year!.padStart(4, '0')}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`)
  const micros = BigInt(/\.(\d{6})/.exec(stamp)?.[1] ?? '0')
  const difference = BigInt(base.getTime() - wall.getTime()) * 1000n - micros
  const magnitude = difference < 0n ? -difference : difference, minute = 60_000_000n
  let rounded = magnitude / minute
  const remainder = magnitude % minute
  if (remainder * 2n > minute || remainder * 2n === minute && rounded % 2n !== 0n) rounded++
  return Number(difference < 0n ? -rounded : rounded)
}

/** Agent与管理读取共用领域边界；这里只转换活动+提醒，不触发任务清理或调度。 */
export function agentCalendarEventResponse(event: CalendarEventProjectionInput, tasks: readonly EventUpdateReminderRecord[] = []) {
  return { id: event.id, title: event.title, date: event.date, time: event.time,
    end_time: event.end_time, type: event.type, project_id: event.project_id, description: event.description,
    reminders: tasks.map(task => {
      const channels = (task.channels || '').split(',').filter(Boolean)
      const targets = task.delivery_targets as { qq?: { chat_type?: string } } | null
      return { lead_minutes: reminderLead(event, task), channels, enabled: task.enabled,
        ...(channels.includes('qq') ? { delivery_mode: targets?.qq?.chat_type === 'group' ? 'current_group' : 'owner_private' } : {}) }
    }),
  }
}
export function createAgentCalendarReader(port: CalendarAgentReadPort) {
  return async (rawOwner: string, query: AgentEventQuery, signal?: AbortSignal) => {
    signal?.throwIfAborted()
    const result = await port.list(dataContext(rawOwner).ownerId, query, signal)
    signal?.throwIfAborted()
    return result.events.map(event => agentCalendarEventResponse(event, result.reminders.get(event.id) ?? []))
  }
}
export interface CalendarEventReadPort {
  list(ownerId: string, datePrefix: string | undefined, signal?: AbortSignal): Promise<readonly CalendarEventProjectionInput[]>
  get(ownerId: string, eventId: number, signal?: AbortSignal): Promise<CalendarEventProjectionInput | null>
}
function owner(raw: string): string {
  try { return dataContext(raw).ownerId }
  catch { throw new CoreError('invalid_request', '用户 ID 无效') }
}
function integer(value: number | undefined, label: string): void {
  if (value !== undefined && !Number.isSafeInteger(value)) throw new CoreError('invalid_request', `${label}无效`)
}

/** 现有Web管理查询，不附带Agent提醒聚合或修改其year/month兼容行为。 */
export function createCalendarEventReader(port: CalendarEventReadPort) {
  return {
    async list(rawOwner: string, year?: number, month?: number, options: CalendarReadOptions = {}) {
      const signal = options.signal
      signal?.throwIfAborted()
      const ownerId = owner(rawOwner)
      integer(year, '年份'); integer(month, '月份')
      // 与Python及旧Host一致：两者均为非零整数时才按文本前缀筛选。
      const prefix = year && month ? `${year}-${String(month).padStart(2, '0')}` : undefined
      const rows = await port.list(ownerId, prefix, signal).finally(() => signal?.throwIfAborted())
      return rows.map(calendarEventResponse)
    },
    async get(rawOwner: string, eventId: number, options: CalendarReadOptions = {}) {
      const signal = options.signal
      signal?.throwIfAborted()
      const ownerId = owner(rawOwner)
      if (!Number.isSafeInteger(eventId)) throw new CoreError('invalid_request', '事件标识无效')
      const event = await port.get(ownerId, eventId, signal).finally(() => signal?.throwIfAborted())
      return event === null ? null : calendarEventResponse(event)
    },
  }
}
