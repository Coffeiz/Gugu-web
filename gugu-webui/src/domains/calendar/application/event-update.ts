import { randomUUID } from 'node:crypto'

export type CalendarEventUpdateFields = Partial<{
  title: string | null
  date: string | null
  time: string | null
  end_time: string | null
  type: string | null
  client: string | null
  project_id: number | null
  description: string | null
}>

export interface CalendarEventUpdateRecord {
  id: number
  title: string
  date: string
  time: string | null
  end_time: string | null
  type: string
  client: string | null
  project_id: number | null
  description: string | null
  version: number
  deleted_at: string | null
}

export interface EventUpdateReminderRecord {
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

export interface EventUpdateReminderSchedule {
  cron: string
  startAt: Date
  scheduleKind: 'once'
  reminderLeadMinutes: number
  channels: string
}

export interface EventUpdateUndoRecord {
  contextId: string
  resource: 'calendar'
  action: 'update'
  targetRefs: Array<{ kind: 'event' | 'task'; id: number }>
  beforeState: { items: Record<string, Record<string, unknown>> }
  afterState: { items: Record<string, Record<string, unknown>> }
  baseVersions: Record<string, { version: number }>
}

export interface EventUpdateTransaction {
  findOwnedActiveEvent(eventId: number): Promise<CalendarEventUpdateRecord | null>
  projectExistsForOwner(projectId: number): Promise<boolean>
  listOwnedEventReminders(eventId: number): Promise<EventUpdateReminderRecord[]>
  updateEventIfVersion(
    eventId: number,
    version: number,
    fields: CalendarEventUpdateFields,
  ): Promise<CalendarEventUpdateRecord | null>
  stageReminderCron(taskId: number, cron: string): Promise<void>
  updateReminder(
    taskId: number,
    update: { name: string; payload: string; schedule?: EventUpdateReminderSchedule },
  ): Promise<void>
  recordUndo(record: EventUpdateUndoRecord): Promise<void>
}

export interface EventUpdatePublication {
  ownerId: string
  resource: 'calendar'
  origin: string | null
  operation: 'update'
  entityId: number
  payload: {
    id: number
    title: string
    date: string
    time: string | null
    endTime: string | null
    type: string
    client: string | null
    projectId: number | null
    description: string | null
    version: number
  }
}

export interface EventUpdateStore {
  transaction<T>(ownerId: string, work: (tx: EventUpdateTransaction) => Promise<T>): Promise<T>
  publishCalendarEvent(publication: EventUpdatePublication): Promise<void>
}

export interface UpdateCalendarEventOptions {
  ownerId: string
  eventId: number
  body: unknown
  undoContextId?: string | null
  clientId?: string | null
}

export class EventUpdateError extends Error {
  constructor(readonly statusCode: 400 | 404 | 409 | 422, message: string) {
    super(message)
    this.name = 'EventUpdateError'
  }
}

const fieldAliases = [
  ['title', 'title'], ['date', 'date'], ['time', 'time'],
  ['end_time', 'endTime'], ['type', 'type'], ['client', 'client'],
  ['project_id', 'projectId'], ['description', 'description'],
] as const

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseVersion(value: unknown): number {
  const version = typeof value === 'string' && /^\d+$/.test(value.trim())
    ? Number(value)
    : value
  if (typeof version !== 'number' || !Number.isSafeInteger(version))
    throw new EventUpdateError(422, 'version 必须是整数')
  return version
}

function parseStringField(value: unknown, field: string): string | null {
  if (value === null) return null
  if (typeof value !== 'string') throw new EventUpdateError(422, `${field} 必须是字符串`)
  return value
}

function parseProjectId(value: unknown): number | null {
  if (value === null) return null
  const parsed = typeof value === 'string' && /^[-+]?\d+$/.test(value.trim())
    ? Number(value)
    : value
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed))
    throw new EventUpdateError(422, 'project_id 必须是整数')
  return parsed
}

function parseUpdate(body: unknown): { version: number; fields: CalendarEventUpdateFields } {
  if (!isObject(body)) throw new EventUpdateError(422, '请求内容必须是对象')
  const version = parseVersion(body.version)
  const fields: CalendarEventUpdateFields = {}
  for (const [snake, camel] of fieldAliases) {
    const key: string = body[snake] !== undefined ? snake : camel
    if (!(key in body)) continue
    const value = body[key]
    switch (snake) {
      case 'project_id': fields.project_id = parseProjectId(value); break
      case 'title': fields.title = parseStringField(value, snake); break
      case 'date': fields.date = parseStringField(value, snake); break
      case 'time': fields.time = parseStringField(value, snake); break
      case 'end_time': fields.end_time = parseStringField(value, snake); break
      case 'type': fields.type = parseStringField(value, snake); break
      case 'client': fields.client = parseStringField(value, snake); break
      case 'description': fields.description = parseStringField(value, snake); break
    }
  }
  return { version, fields }
}

function toIso(value: Date | string | null): string | null {
  if (value === null) return null
  return value instanceof Date ? value.toISOString() : value
}

function eventSnapshot(event: CalendarEventUpdateRecord): Record<string, unknown> {
  return {
    id: event.id,
    title: event.title,
    date: event.date,
    time: event.time,
    end_time: event.end_time,
    type: event.type,
    client: event.client,
    project_id: event.project_id,
    description: event.description,
    version: Number(event.version || 1),
    deleted_at: event.deleted_at,
  }
}

function taskSnapshot(task: EventUpdateReminderRecord): Record<string, unknown> {
  return {
    id: task.id,
    enabled: Boolean(task.enabled),
    name: task.name,
    payload: task.payload,
    cron: task.cron,
    schedule_kind: task.schedule_kind,
    start_at: toIso(task.start_at),
    reminder_lead_minutes: task.reminder_lead_minutes,
    channels: task.channels,
    delivery_targets: task.delivery_targets,
  }
}

function eventBaseMillis(event: Pick<CalendarEventUpdateRecord, 'date' | 'time'>): number {
  if (!event.date) throw new EventUpdateError(422, '事件日期无效，无法重排提醒')
  const [year, month, day] = event.date.split('-').map(Number)
  const [hour, minute] = (event.time || '09:00').split(':').map(Number)
  if (![year, month, day, hour, minute].every(Number.isInteger)
    || year < 1 || month < 1 || month > 12 || day < 1 || day > 31
    || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new EventUpdateError(422, '事件日期或时间无效，无法重排提醒')
  }
  const local = new Date(0)
  local.setUTCFullYear(year, month - 1, day)
  local.setUTCHours(hour, minute, 0, 0)
  if (local.getUTCFullYear() !== year || local.getUTCMonth() !== month - 1 || local.getUTCDate() !== day)
    throw new EventUpdateError(422, '事件日期无效，无法重排提醒')
  return local.getTime()
}

function normalizeReminderChannels(value: string | null): string {
  const allowed = new Set(['web', 'feishu', 'qq', 'wechat', 'telegram'])
  const channels = [...new Set((value || 'web').split(',').filter((channel) => allowed.has(channel)))]
  return channels.length > 0 ? channels.join(',') : 'web'
}

function leadMinutes(task: EventUpdateReminderRecord, previousBase: number): number | null {
  if (task.reminder_lead_minutes !== null) return task.reminder_lead_minutes
  if (task.schedule_kind !== 'once' || task.start_at === null) return null
  const fireUtc = task.start_at instanceof Date ? task.start_at.getTime() : Date.parse(task.start_at)
  if (!Number.isFinite(fireUtc)) return null
  // The Python scheduler stores local Asia/Shanghai wall time as an aware datetime.
  return Math.round((previousBase - (fireUtc + 8 * 60 * 60 * 1000)) / 60_000)
}

function reminderSchedule(
  event: CalendarEventUpdateRecord,
  task: EventUpdateReminderRecord,
  lead: number,
): EventUpdateReminderSchedule {
  if (!Number.isInteger(lead)) throw new EventUpdateError(422, 'lead_minutes 需为整数分钟（0=活动开始时）')
  if (lead < 0) throw new EventUpdateError(422, 'lead_minutes 不能为负')
  const fireLocal = eventBaseMillis(event) - lead * 60_000
  const nowShanghaiWall = Date.now() + 8 * 60 * 60 * 1000
  if (task.enabled && fireLocal <= nowShanghaiWall) {
    const fire = new Date(fireLocal)
    const formatted = `${fire.getUTCFullYear()}-${String(fire.getUTCMonth() + 1).padStart(2, '0')}-${String(fire.getUTCDate()).padStart(2, '0')} ${String(fire.getUTCHours()).padStart(2, '0')}:${String(fire.getUTCMinutes()).padStart(2, '0')}`
    throw new EventUpdateError(422, `提前 ${lead} 分钟（${formatted}）已过，跳过`)
  }
  const startAt = new Date(fireLocal - 8 * 60 * 60 * 1000)
  if (!Number.isFinite(startAt.getTime())) throw new EventUpdateError(422, '提醒时间无效')
  const iso = startAt.toISOString().replace('.000Z', '+00:00')
  return {
    cron: `@once:${iso}`,
    startAt,
    scheduleKind: 'once',
    reminderLeadMinutes: lead,
    channels: normalizeReminderChannels(task.channels),
  }
}

function response(event: CalendarEventUpdateRecord): EventUpdatePublication['payload'] {
  return {
    id: event.id,
    title: event.title,
    date: event.date,
    time: event.time,
    endTime: event.end_time,
    type: event.type,
    client: event.client,
    projectId: event.project_id,
    description: event.description,
    version: Number(event.version || 1),
  }
}

function makeUndoRecord(
  contextId: string,
  beforeEvent: CalendarEventUpdateRecord,
  afterEvent: CalendarEventUpdateRecord,
  beforeTasks: EventUpdateReminderRecord[],
  afterTasks: EventUpdateReminderRecord[],
): EventUpdateUndoRecord {
  const eventRef = `event:${beforeEvent.id}`
  const beforeItems: Record<string, Record<string, unknown>> = { [eventRef]: eventSnapshot(beforeEvent) }
  const afterItems: Record<string, Record<string, unknown>> = { [eventRef]: eventSnapshot(afterEvent) }
  const baseVersions: Record<string, { version: number }> = {
    [eventRef]: { version: Number(beforeEvent.version || 1) },
  }
  for (const task of beforeTasks) {
    const ref = `task:${task.id}`
    beforeItems[ref] = taskSnapshot(task)
    baseVersions[ref] = { version: 0 }
  }
  for (const task of afterTasks) afterItems[`task:${task.id}`] = taskSnapshot(task)
  const targetRefs = Object.keys(afterItems).map((ref) => {
    const [kind, rawId] = ref.split(':', 2)
    return { kind: kind as 'event' | 'task', id: Number(rawId) }
  })
  return {
    contextId: contextId.slice(0, 128),
    resource: 'calendar',
    action: 'update',
    targetRefs,
    beforeState: { items: beforeItems },
    afterState: { items: afterItems },
    baseVersions,
  }
}

export async function updateCalendarEvent(
  store: EventUpdateStore,
  options: UpdateCalendarEventOptions,
): Promise<EventUpdatePublication['payload']> {
  if (!Number.isSafeInteger(options.eventId))
    throw new EventUpdateError(422, '事件标识无效')
  const { version, fields } = parseUpdate(options.body)
  const contextId = options.undoContextId?.trim() || null
  const origin = options.clientId?.trim() || null

  const result = await store.transaction(options.ownerId, async (tx) => {
    const event = await tx.findOwnedActiveEvent(options.eventId)
    if (!event) throw new EventUpdateError(404, '事件不存在')
    if (event.version !== version)
      throw new EventUpdateError(409, '数据已被其他用户修改，请刷新后重试')
    if (Object.keys(fields).length === 0) return { event: response(event), changed: false }

    const beforeTasks = await tx.listOwnedEventReminders(event.id)
    const beforeItems: Record<string, Record<string, unknown>> = {
      [`event:${event.id}`]: eventSnapshot(event),
    }
    for (const task of beforeTasks) beforeItems[`task:${task.id}`] = taskSnapshot(task)

    if (fields.project_id !== undefined && fields.project_id !== null
      && !await tx.projectExistsForOwner(fields.project_id)) {
      throw new EventUpdateError(400, '关联的项目不存在')
    }

    const updated = await tx.updateEventIfVersion(event.id, version, fields)
    if (!updated) throw new EventUpdateError(409, '数据已被其他用户修改，请刷新后重试')
    const timingChanged = Object.hasOwn(fields, 'date') || Object.hasOwn(fields, 'time')
    const metadataChanged = ['title', 'date', 'time'].some((field) => Object.hasOwn(fields, field))
    const beforeBase = eventBaseMillis(event)
    const schedules = new Map<number, EventUpdateReminderSchedule>()
    if (timingChanged) {
      for (const task of beforeTasks) {
        if (!task.enabled) continue
        const lead = leadMinutes(task, beforeBase)
        if (lead === null) continue
        schedules.set(task.id, reminderSchedule(updated, task, lead))
      }
      // Stage all enabled reminder crons before assigning final values; this avoids
      // transient collisions in uq_scheduled_tasks_event_fire during date shifts.
      for (const taskId of schedules.keys())
        await tx.stageReminderCron(taskId, `@once:reschedule-${randomUUID().replaceAll('-', '')}`)
    }

    if (metadataChanged) {
      const when = updated.date + (updated.time ? ` ${updated.time}` : '')
      for (const task of beforeTasks) {
        await tx.updateReminder(task.id, {
          name: `${updated.title} 提醒`,
          payload: `提醒：${updated.title}（${when}）`,
          ...(schedules.has(task.id) ? { schedule: schedules.get(task.id)! } : {}),
        })
      }
    } else {
      for (const task of beforeTasks) {
        const schedule = schedules.get(task.id)
        if (schedule) {
          await tx.updateReminder(task.id, { name: task.name, payload: task.payload, schedule })
        }
      }
    }

    const afterTasks = await tx.listOwnedEventReminders(event.id)
    if (contextId) await tx.recordUndo(makeUndoRecord(contextId, event, updated, beforeTasks, afterTasks))
    return { event: response(updated), changed: true }
  })

  if (result.changed) {
    try {
      await store.publishCalendarEvent({
        ownerId: options.ownerId,
        resource: 'calendar',
        origin,
        operation: 'update',
        entityId: options.eventId,
        payload: result.event,
      })
    } catch {
      // The event and reminders are committed; notification is best-effort.
    }
  }
  return result.event
}
