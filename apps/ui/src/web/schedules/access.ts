import type { ScheduleAccess } from '@/services/scheduleAccess'
import { scheduledTasksApi } from '@/services/api'
import { showBrowserReminder } from '@/composables/schedules/browserNotifications'

export const webScheduleAccess: ScheduleAccess = {
  storesSchedulesLocally: false,
  list: eventId => eventId === undefined ? scheduledTasksApi.list() : scheduledTasksApi.listForEvent(eventId),
  create: (fields, eventId) => scheduledTasksApi.create(eventId === undefined ? fields : { ...fields, event_id: eventId }),
  update(id, fields, change) {
    if (change?.eventId !== undefined) return scheduledTasksApi.updateForEvent(change.eventId, id, fields)
    return change?.meta ? scheduledTasksApi.update(id, fields, change.meta) : scheduledTasksApi.update(id, fields)
  },
  delete: id => scheduledTasksApi.delete(id),
  run: scheduledTasksApi.run,
  showBrowserReminder,
}
