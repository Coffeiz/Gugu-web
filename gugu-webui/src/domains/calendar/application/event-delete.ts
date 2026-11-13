export interface CalendarEventDeleteRecord {
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

export interface CalendarEventReminderRecord {
  id: number
  enabled: boolean
  name: string
  payload: string
  cron: string
  schedule_kind: string
  start_at: Date | string | null
  reminder_lead_minutes: number | null
  channels: string
  delivery_targets: unknown
}

export interface CalendarEventDeleteUndoRecord {
  contextId: string
  resource: 'calendar'
  action: 'delete'
  targetRefs: Array<{ kind: 'event' | 'task'; id: number }>
  beforeState: { items: Record<string, Record<string, unknown>> }
  afterState: { items: Record<string, Record<string, unknown>> }
  baseVersions: Record<string, { version: number }>
}

export interface CalendarEventDeleteTransaction {
  findOwnedActiveEvent(eventId: number): Promise<CalendarEventDeleteRecord | null>
  listOwnedEventReminders(eventId: number): Promise<CalendarEventReminderRecord[]>
  softDeleteEventIfVersion(eventId: number, version: number): Promise<CalendarEventDeleteRecord | null>
  disableReminders(eventId: number, taskIds: number[]): Promise<void>
  recordUndo(record: CalendarEventDeleteUndoRecord): Promise<void>
}

export type CalendarEventDeletePublication =
  | {
    ownerId: string
    resource: 'calendar'
    origin: string | null
    operation: 'delete'
    entityId: number
  }
  | {
    ownerId: string
    resource: 'scheduled_tasks'
    origin: string | null
    operation: 'update'
    entityIds: number[]
  }

export interface CalendarEventDeleteStore {
  transaction<T>(
    ownerId: string,
    work: (tx: CalendarEventDeleteTransaction) => Promise<T>,
  ): Promise<T>
  publishResourceChanged(publication: CalendarEventDeletePublication): Promise<void>
}

export interface DeleteCalendarEventOptions {
  ownerId: string
  eventId: number
  version: number
  undoContextId?: string | null
  clientId?: string | null
}

export class EventDeleteError extends Error {
  constructor(readonly statusCode: 404 | 409, message: string) {
    super(message)
    this.name = 'EventDeleteError'
  }
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null
  return value instanceof Date ? value.toISOString() : value
}

function eventSnapshot(event: CalendarEventDeleteRecord): Record<string, unknown> {
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
    version: event.version || 1,
    deleted_at: event.deleted_at,
  }
}

function taskSnapshot(task: CalendarEventReminderRecord): Record<string, unknown> {
  return {
    id: task.id,
    enabled: Boolean(task.enabled),
    name: task.name,
    payload: task.payload,
    cron: task.cron,
    schedule_kind: task.schedule_kind,
    start_at: iso(task.start_at),
    reminder_lead_minutes: task.reminder_lead_minutes,
    channels: task.channels,
    delivery_targets: task.delivery_targets,
  }
}

function makeUndoRecord(
  contextId: string,
  beforeEvent: CalendarEventDeleteRecord,
  afterEvent: CalendarEventDeleteRecord,
  beforeTasks: CalendarEventReminderRecord[],
): CalendarEventDeleteUndoRecord {
  const eventRef = `event:${beforeEvent.id}`
  const beforeItems: Record<string, Record<string, unknown>> = { [eventRef]: eventSnapshot(beforeEvent) }
  const afterItems: Record<string, Record<string, unknown>> = { [eventRef]: eventSnapshot(afterEvent) }
  const targetRefs: Array<{ kind: 'event' | 'task'; id: number }> = [
    { kind: 'event', id: beforeEvent.id },
  ]
  const baseVersions: Record<string, { version: number }> = {
    [eventRef]: { version: beforeEvent.version || 1 },
  }
  for (const task of beforeTasks) {
    const taskRef = `task:${task.id}`
    const before = taskSnapshot(task)
    beforeItems[taskRef] = before
    afterItems[taskRef] = { ...before, enabled: false }
    targetRefs.push({ kind: 'task', id: task.id })
    baseVersions[taskRef] = { version: 0 }
  }
  return {
    contextId: contextId.slice(0, 128),
    resource: 'calendar',
    action: 'delete',
    targetRefs,
    beforeState: { items: beforeItems },
    afterState: { items: afterItems },
    baseVersions,
  }
}

export async function deleteCalendarEvent(
  store: CalendarEventDeleteStore,
  options: DeleteCalendarEventOptions,
): Promise<void> {
  if (!Number.isSafeInteger(options.eventId) || !Number.isSafeInteger(options.version)) {
    throw new EventDeleteError(409, '事件版本无效')
  }
  const clientId = options.clientId?.trim() || null
  const deleted = await store.transaction(options.ownerId, async (tx) => {
    const event = await tx.findOwnedActiveEvent(options.eventId)
    if (!event) throw new EventDeleteError(404, '事件不存在')
    if (event.version !== options.version)
      throw new EventDeleteError(409, '数据已被其他端修改，请刷新后重试')

    const tasks = await tx.listOwnedEventReminders(event.id)
    const afterEvent = await tx.softDeleteEventIfVersion(event.id, options.version)
    if (!afterEvent) throw new EventDeleteError(409, '数据已被其他端修改，请刷新后重试')
    await tx.disableReminders(event.id, tasks.map((task) => task.id))

    const contextId = options.undoContextId?.trim()
    if (contextId) await tx.recordUndo(makeUndoRecord(contextId, event, afterEvent, tasks))
    return { eventId: event.id, taskIds: tasks.map((task) => task.id) }
  })

  try {
    await store.publishResourceChanged({
      ownerId: options.ownerId,
      resource: 'calendar',
      origin: clientId,
      operation: 'delete',
      entityId: deleted.eventId,
    })
  } catch {
    // The database commit is authoritative; live notification is best-effort.
  }
  if (deleted.taskIds.length > 0) {
    try {
      await store.publishResourceChanged({
        ownerId: options.ownerId,
        resource: 'scheduled_tasks',
        origin: clientId,
        operation: 'update',
        entityIds: deleted.taskIds,
      })
    } catch {
      // Keep the successful delete result if the task notification is unavailable.
    }
  }
}
