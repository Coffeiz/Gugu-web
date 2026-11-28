import { createKyselyCalendarCreateStore, createKyselyCalendarMutationStores } from '@gugu/core/calendar'
import type { CalendarEventDeletePublication, EventCreatePublication, EventUpdatePublication } from '@gugu/core/calendar'
import type { SqlDataRuntime } from '@gugu/core/data'

/** 使用真实 Core 存储；模拟 Host 的提交后诊断边界。 */
function published<T>(publish: (event: T) => Promise<unknown>, report?: (operation: string) => void) {
  return async (event: T) => {
    try { await publish(event) }
    catch {
      try {
        const resource = (event as { resource?: string }).resource
        report?.(resource === 'scheduled_tasks' ? 'scheduled task notification' : 'calendar event notification')
      } catch { /* 诊断失败不影响已提交事务 */ }
    }
  }
}

export function calendarCreateStore(runtime: SqlDataRuntime, publish: (event: EventCreatePublication) => Promise<unknown>, report?: (operation: string) => void) {
  return createKyselyCalendarCreateStore(runtime.db, 'postgres', published(publish, report))
}
export function calendarUpdateStore(runtime: SqlDataRuntime, publish: (event: EventUpdatePublication) => Promise<unknown>, report?: (operation: string) => void) {
  return createKyselyCalendarMutationStores(runtime.db, 'postgres', published(event => publish(event as EventUpdatePublication), report)).update
}
export function calendarDeleteStore(runtime: SqlDataRuntime, publish: (event: CalendarEventDeletePublication) => Promise<unknown>, report?: (operation: string) => void) {
  return createKyselyCalendarMutationStores(runtime.db, 'postgres', published(event => publish(event as CalendarEventDeletePublication), report)).delete
}
