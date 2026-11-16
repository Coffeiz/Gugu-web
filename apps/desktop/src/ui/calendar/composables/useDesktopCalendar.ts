import { ref } from 'vue'
import { desktopData } from '@/desktop/bridge'
import type { CalendarRow } from '@/desktop/bridge'
import { confirmDialog } from '@/composables/core/useConfirmDialog'

type Perform = (action: () => Promise<void>) => Promise<void>
type EventDetails = { time?: string | null; endTime?: string | null; description?: string | null }
type HistoryState = { undo: string | null; redo: string | null }

export function useDesktopCalendar(perform: Perform, refresh: () => Promise<void>) {
  const calendar = ref<CalendarRow[]>([])
  const calendarHistory = ref<HistoryState>({ undo: null, redo: null })
  const eventTitle = ref('')
  const eventDate = ref(new Date().toISOString().slice(0, 10))
  const editingCalendarEvent = ref<CalendarRow | null>(null)
  const editedEventTitle = ref('')
  const editedEventDate = ref('')

  async function setRows(rows: CalendarRow[]) {
    calendar.value = rows
  }

  async function refreshHistory() {
    try {
      const history = await desktopData.undoPreview('desktop-calendar') as {
        undo?: { operation_id?: unknown; can_undo?: boolean } | null
        redo?: { operation_id?: unknown; can_redo?: boolean } | null
      }
      calendarHistory.value = {
        undo: history.undo?.can_undo && typeof history.undo.operation_id === 'string' ? history.undo.operation_id : null,
        redo: history.redo?.can_redo && typeof history.redo.operation_id === 'string' ? history.redo.operation_id : null,
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
      if (mode === 'undo') await desktopData.undoApply('desktop-calendar', operationId, requestId)
      else await desktopData.undoRedo('desktop-calendar', operationId, requestId)
      await refresh()
      await refreshHistory()
    })
  }

  function create(title?: string, date?: string, details: EventDetails = {}) {
    return perform(async () => {
      if (title !== undefined) eventTitle.value = title
      if (date !== undefined) eventDate.value = date
      await desktopData.createCalendarEvent(eventTitle.value, eventDate.value, details)
      eventTitle.value = ''
      await refresh()
      await refreshHistory()
    })
  }

  function update(eventArg?: CalendarRow, titleArg?: string, dateArg?: string, details: EventDetails = {}) {
    return perform(async () => {
      if (eventArg) editingCalendarEvent.value = eventArg
      if (titleArg !== undefined) editedEventTitle.value = titleArg
      if (dateArg !== undefined) editedEventDate.value = dateArg
      const event = eventArg ?? editingCalendarEvent.value
      if (!event) return
      await desktopData.updateCalendarEvent(event.id, { version: event.version, title: editedEventTitle.value, date: editedEventDate.value, ...details })
      editingCalendarEvent.value = null
      await refresh()
      await refreshHistory()
    })
  }

  function remove(event: CalendarRow) {
    return perform(async () => {
      const confirmed = await confirmDialog({
        title: '删除日程',
        message: `确定删除“${event.title}”吗？删除后可通过撤销恢复。`,
        tone: 'danger',
        confirmText: '删除日程',
      })
      if (!confirmed) return
      await desktopData.deleteCalendarEvent(event.id, event.version)
      await refresh()
      await refreshHistory()
    })
  }

  return { calendar, calendarHistory, eventTitle, eventDate, editingCalendarEvent, editedEventTitle, editedEventDate, setRows, refreshHistory, applyHistoryAction, create, update, remove }
}
