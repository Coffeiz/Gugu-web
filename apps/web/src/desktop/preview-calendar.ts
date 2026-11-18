import type { DesktopBridge } from '@gugu/core/desktop'

export const desktopPreviewCalendarEndpoint = '/__desktop-preview/calendar'

export const desktopPreviewCalendarMethods = [
  'calendar',
  'createCalendarEvent',
  'updateCalendarEvent',
  'deleteCalendarEvent',
  'undoPreview',
  'undoApply',
  'undoRedo',
  'receipt',
] as const satisfies readonly (keyof DesktopBridge)[]
