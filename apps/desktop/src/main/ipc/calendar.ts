import { DESKTOP_CHANNELS } from '@gugu/core/desktop'
import type { IpcHost, IpcHandlers } from './types.js'

export function calendarHandlers(host: IpcHost): IpcHandlers {
  return {
    [DESKTOP_CHANNELS.calendar]: () => host.request('calendar.list'),
    [DESKTOP_CHANNELS.createCalendarEvent]: (title: unknown, date: unknown, details?: unknown) =>
      host.request('calendar.create', { title, date, ...(details && typeof details === 'object' ? details : {}) }),
    [DESKTOP_CHANNELS.updateCalendarEvent]: (id: unknown, body: unknown) =>
      host.request('calendar.update', { id, body }),
    [DESKTOP_CHANNELS.deleteCalendarEvent]: (id: unknown, version: unknown) =>
      host.request('calendar.delete', { id, version }),
  }
}
