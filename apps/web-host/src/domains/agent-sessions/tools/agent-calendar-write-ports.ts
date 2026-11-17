import type { Pool } from 'pg'
import type { SqlDataRuntime } from '@gugu/core/data'
import { createKyselyCalendarAgentReadPort, type EventCreatePublication, type EventUpdatePublication } from '@gugu/core/calendar'
import { createCalendarDeletePort, createCalendarEventCreatePort, createCalendarEventUpdatePort } from '@gugu/core/tools'
import type { CalendarDeleteConfirmationPort } from '@gugu/core/tools'
import type { AgentDispatchLease } from '../persistence/agent-run-dispatch-postgres.js'
import type { TaskExternalResolution } from '../../../modules/scheduled-tasks/persistence/task-resolver-postgres.js'
import { createWebCalendarReminderTargets } from './agent-calendar-reminder-targets.js'

/** 同一 Web lease 的日历读写与提醒目标，供可信 Run 资源装配方使用。 */
export function createWebAgentCalendarWritePorts(options: {
  core: SqlDataRuntime
  pool: Pick<Pool, 'connect'>
  lease: AgentDispatchLease
  delivery: Pick<TaskExternalResolution, 'resolveDelivery'>
  publishCreate(event: EventCreatePublication): Promise<void>
  publishUpdate(event: EventUpdatePublication): Promise<void>
  publishDelete?: Parameters<typeof createCalendarDeletePort>[1]
  deleteConfirmation?: CalendarDeleteConfirmationPort
}) {
  const targets = createWebCalendarReminderTargets(options)
  const events = createKyselyCalendarAgentReadPort(options.core.db, options.core.backend)
  return {
    calendarCreate: createCalendarEventCreatePort(options.core, options.publishCreate, targets),
    calendarUpdate: createCalendarEventUpdatePort(options.core, options.publishUpdate, events, targets),
    ...(options.publishDelete && options.deleteConfirmation ? {
      calendarDelete: createCalendarDeletePort(options.core, options.publishDelete, options.deleteConfirmation),
    } : {}),
  }
}
