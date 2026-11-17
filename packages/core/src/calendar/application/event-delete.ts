import { scheduledTaskUndoSnapshot } from '../undo-snapshot.js'
import { calendarEventSnapshot } from '../event-projection.js'

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

export interface DeleteCalendarEventsOptions {
  ownerId: string
  eventIds: readonly number[]
  undoContextId?: string | null
  clientId?: string | null
}

export class EventDeleteError extends Error {
  constructor(readonly statusCode: 404 | 409, message: string) {
    super(message)
    this.name = 'EventDeleteError'
  }
}

function makeUndoRecord(
  contextId: string,
  events: Array<{ before: CalendarEventDeleteRecord; after: CalendarEventDeleteRecord; reminders: CalendarEventReminderRecord[] }>,
): CalendarEventDeleteUndoRecord {
  const beforeItems: Record<string, Record<string, unknown>> = {}
  const afterItems: Record<string, Record<string, unknown>> = {}
  const targetRefs: Array<{ kind: 'event' | 'task'; id: number }> = []
  const baseVersions: Record<string, { version: number }> = {}
  for (const { before, after, reminders } of events) {
    const eventRef = `event:${before.id}`
    beforeItems[eventRef] = calendarEventSnapshot(before)
    afterItems[eventRef] = calendarEventSnapshot(after)
    targetRefs.push({ kind: 'event', id: before.id })
    baseVersions[eventRef] = { version: before.version || 1 }
    for (const task of reminders) {
      const taskRef = `task:${task.id}`
      const taskState = scheduledTaskUndoSnapshot(task)
      beforeItems[taskRef] = taskState
      afterItems[taskRef] = { ...taskState, enabled: false }
      targetRefs.push({ kind: 'task', id: task.id })
      baseVersions[taskRef] = { version: 0 }
    }
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
  if (!Number.isSafeInteger(options.eventId) || !Number.isSafeInteger(options.version))
    throw new EventDeleteError(409, '事件版本无效')
  await deleteCalendarEvents(store, { ...options, eventIds: [options.eventId], expectedVersions: new Map([[options.eventId, options.version]]) })
}

export async function deleteCalendarEvents(
  store: CalendarEventDeleteStore,
  options: DeleteCalendarEventsOptions & { expectedVersions?: ReadonlyMap<number, number> },
): Promise<Array<{ eventId: number; title: string; deletedReminders: number }>> {
  const ids = [...options.eventIds]
  if (!ids.length || ids.some(id => !Number.isSafeInteger(id)) || new Set(ids).size !== ids.length)
    throw new EventDeleteError(404, '事件不存在')
  const clientId = options.clientId?.trim() || null
  const deleted = await store.transaction(options.ownerId, async (tx) => {
    const targets: Array<{ event: CalendarEventDeleteRecord; reminders: CalendarEventReminderRecord[] }> = []
    for (const id of ids) {
      const event = await tx.findOwnedActiveEvent(id)
      if (!event) throw new EventDeleteError(404, '事件不存在')
      const expectedVersion = options.expectedVersions?.get(id)
      if (expectedVersion !== undefined && event.version !== expectedVersion)
        throw new EventDeleteError(409, '数据已被其他端修改，请刷新后重试')
      targets.push({ event, reminders: await tx.listOwnedEventReminders(event.id) })
    }
    const committed: Array<{ before: CalendarEventDeleteRecord; after: CalendarEventDeleteRecord; reminders: CalendarEventReminderRecord[] }> = []
    for (const { event, reminders } of targets) {
      const after = await tx.softDeleteEventIfVersion(event.id, event.version)
      if (!after) throw new EventDeleteError(409, '数据已被其他端修改，未删除，请重试')
      await tx.disableReminders(event.id, reminders.map(task => task.id))
      committed.push({ before: event, after, reminders })
    }
    const contextId = options.undoContextId?.trim()
    if (contextId) await tx.recordUndo(makeUndoRecord(contextId, committed))
    return committed.map(({ before, reminders }) => ({ eventId: before.id, title: before.title, taskIds: reminders.map(task => task.id), deletedReminders: reminders.length }))
  })

  for (const event of deleted) {
    try {
      await store.publishResourceChanged({
        ownerId: options.ownerId, resource: 'calendar', origin: clientId, operation: 'delete', entityId: event.eventId,
      })
    } catch {
      // The database commit is authoritative; live notification is best-effort.
    }
  }
  const taskIds = deleted.flatMap(event => event.taskIds)
  if (taskIds.length > 0) {
    try {
      await store.publishResourceChanged({
        ownerId: options.ownerId,
        resource: 'scheduled_tasks',
        origin: clientId,
        operation: 'update',
        entityIds: taskIds,
      })
    } catch {
      // Keep the successful delete result if the task notification is unavailable.
    }
  }
  return deleted.map(({ eventId, title, deletedReminders }) => ({ eventId, title, deletedReminders }))
}
