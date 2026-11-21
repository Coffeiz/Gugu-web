import { hasInjectionContext, inject, type InjectionKey } from 'vue'
import type { RequestMeta } from '@/api/client'
import type { ScheduledTaskInput } from '@/services/api'

export type ScheduledTask = Record<string, any>
type ScheduleFields = Partial<ScheduledTaskInput> & { reminder_lead_minutes?: number }
type SavedSchedule = { id: number; name?: string }
type ScheduleChange = { eventId?: number; meta?: RequestMeta }
type BrowserReminder = { source?: string; id?: number; title?: string; content?: string }

export interface ScheduleAccess {
  storesSchedulesLocally: boolean
  list(eventId?: number): Promise<{ tasks: ScheduledTask[] }>
  create(fields: ScheduleFields, eventId?: number): Promise<SavedSchedule>
  update(id: number, fields: ScheduleFields, change?: ScheduleChange): Promise<SavedSchedule>
  delete(id: number, eventId?: number): Promise<unknown>
  run(id: number): Promise<{ msg: string }>
  onChanged?(listener: () => void): (() => void) | undefined
  showBrowserReminder?(reminder: BrowserReminder): Promise<void>
}

export const scheduleAccessKey: InjectionKey<ScheduleAccess> = Symbol('scheduleAccess')

export function useScheduleAccess() {
  return hasInjectionContext() ? inject(scheduleAccessKey, null) : null
}

export function requireScheduleAccess() {
  const access = useScheduleAccess()
  if (!access) throw new Error('日程接口未装配')
  return access
}
