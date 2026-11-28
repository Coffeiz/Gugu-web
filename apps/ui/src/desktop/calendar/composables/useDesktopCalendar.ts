import { DESKTOP_CALENDAR_UNDO_CONTEXT } from '@gugu/core/desktop'
import { ref } from 'vue'
import { desktopData } from '@desktop/bridge/bridge'
import type { CalendarRow } from '@desktop/bridge/bridge'
import { confirmDialog } from '@/composables/core/useConfirmDialog'
import { i18n } from '@/i18n'

type Perform = (action: () => Promise<void>) => Promise<void>
export type EventDetails = { time?: string | null; endTime?: string | null; description?: string | null }
type HistoryState = { undo: string | null; redo: string | null }

export function useDesktopCalendar(perform: Perform) {
  const calendar = ref<CalendarRow[]>([])
  const calendarHistory = ref<HistoryState>({ undo: null, redo: null })
  const initialLoading = ref(false)
  let hasLoaded = false
  async function refresh() {
    if (!hasLoaded) initialLoading.value = true
    try {
      const [events] = await Promise.all([desktopData.calendar(), refreshHistory()])
      calendar.value = events
      hasLoaded = true
    } finally {
      initialLoading.value = false
    }
  }

  async function refreshHistory() {
    try {
      const history = await desktopData.undoPreview(DESKTOP_CALENDAR_UNDO_CONTEXT) as {
        undo?: { operation_id?: unknown; can_undo?: boolean } | null
        redo?: { operation_id?: unknown; can_redo?: boolean } | null
      }
      calendarHistory.value = {
        undo: history?.undo?.can_undo && typeof history.undo.operation_id === 'string' ? history.undo.operation_id : null,
        redo: history?.redo?.can_redo && typeof history.redo.operation_id === 'string' ? history.redo.operation_id : null,
      }
    } catch {
      calendarHistory.value = { undo: null, redo: null }
    }
  }

  function applyHistoryAction(mode: 'undo' | 'redo') {
    return perform(async () => {
      const operationId = calendarHistory.value[mode]
      if (!operationId) return
      const requestId = crypto.randomUUID()
      if (mode === 'undo') await desktopData.undoApply(DESKTOP_CALENDAR_UNDO_CONTEXT, operationId, requestId)
      else await desktopData.undoRedo(DESKTOP_CALENDAR_UNDO_CONTEXT, operationId, requestId)
      await refresh()
    })
  }

  async function save(event: CalendarRow | null, title: string, date: string, details: EventDetails) {
    let saved: CalendarRow | null = null
    await perform(async () => {
      const updated = event
        ? await desktopData.updateCalendarEvent(event.id, { version: event.version, title, date, ...details })
        : await desktopData.createCalendarEvent(title, date, details)
      calendar.value = event
        ? calendar.value.map(row => row.id === updated.id ? updated : row)
        : [...calendar.value, updated]
      saved = updated
      await refreshHistory()
    })
    return saved
  }

  async function remove(event: CalendarRow) {
    let removed = false
    await perform(async () => {
      const title = i18n.global.t('calendar.deleteEvent')
      const confirmed = await confirmDialog({
        title,
        message: i18n.global.t('calendar.deleteEventConfirm', { name: event.title }),
        tone: 'danger',
        confirmText: title,
      })
      if (!confirmed) return
      await desktopData.deleteCalendarEvent(event.id, event.version)
      removed = true
      calendar.value = calendar.value.filter(row => row.id !== event.id)
      await refreshHistory()
    })
    return removed
  }

  return { calendar, calendarHistory, initialLoading, refresh, applyHistoryAction, save, remove }
}
