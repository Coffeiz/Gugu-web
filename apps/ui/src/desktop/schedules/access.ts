import type { ScheduleAccess } from '@/services/scheduleAccess'
import { desktopSchedules } from '../bridge/bridge'

export const desktopScheduleAccess: ScheduleAccess = {
  ...desktopSchedules,
  storesSchedulesLocally: true,
  update: (id, fields, change) => desktopSchedules.update(id, fields, change?.eventId),
}
