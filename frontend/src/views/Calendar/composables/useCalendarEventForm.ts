import { computed, nextTick, ref, watch, type ComputedRef, type Ref } from 'vue'
import { eventsApi } from '@/services/api'
import { showAppError, showAppNotice } from '@/composables/useAppToast'
import {
  useEventEditForm, defaultTimeRange, LEAD_OPTIONS, CHAN_LABEL,
  isNextDay, onToggleAllDay,
} from '@/composables/useEventEditForm'
import type { EventDraft } from '@/composables/useEventEditForm'
import type { CalendarRenderItem, CalendarTimeSelection } from '../domain/calendarTypes'
import type { components } from '@/types/api'
import { InteractionSync } from '@/interaction/sync/InteractionSync'

type EventResponse = components['schemas']['EventResponse']

interface NewEventForm extends EventDraft {}

interface EventFormOptions {
  selectedDate: Ref<string | null>
  todayIso: Ref<string>
  viewMode: Ref<string>
  selectedSlot: Ref<CalendarTimeSelection | null>
  cursor: Ref<Date>
  extraEvents: Ref<CalendarRenderItem[]>
  nextMonthEvents: Ref<CalendarRenderItem[]>
  spilloverEvents: Ref<CalendarRenderItem[]>
  projectTimelines: ComputedRef<CalendarRenderItem[]>
  refreshUpcoming: (projects: CalendarRenderItem[], events: CalendarRenderItem[]) => void
  cacheMonth: (date: Date, items: CalendarRenderItem[]) => void
  normalizeCalendarEvent: (event: EventResponse) => CalendarRenderItem
  fetchEvents: () => Promise<void>
  fetchNextMonthEvents: () => Promise<void>
  fetchSpilloverEvents: () => Promise<void>
  clampPopupIntoView: (elRef: { value: HTMLElement | null }, styleRef: { value: Record<string, string | number | undefined> }) => void
}

export function useCalendarEventForm(options: EventFormOptions) {
  const { selectedDate, todayIso, viewMode, selectedSlot, cursor, extraEvents, nextMonthEvents, spilloverEvents, projectTimelines, refreshUpcoming, cacheMonth, normalizeCalendarEvent, fetchEvents, fetchNextMonthEvents, fetchSpilloverEvents, clampPopupIntoView } = options
  const showAddForm = ref(false)
  const addInputRef = ref<HTMLInputElement | null>(null)
  const addBtnRef = ref<HTMLElement | null>(null)
  const addFormRef = ref<HTMLElement | null>(null)
  const addFormStyle = ref<Record<string, string | number>>({})
  const newEvent = ref<NewEventForm>({ name: '', date: todayIso.value, ...defaultTimeRange(), description: '', allDay: false })
  const activeFormDate = computed(() => newEvent.value.date)
  const isPastDate = (date: string | null | undefined) => !!date && date < todayIso.value
  const eventForm = useEventEditForm()
  const { reminders, reminderChannels, imChannels, addReminder, removeReminderAt, toggleReminderChannel, resetReminder, applyReminders } = eventForm

  watch(showAddForm, open => { if (open) nextTick(() => addInputRef.value?.focus?.({ preventScroll: true })) })
  watch([() => reminders.value.length, reminderChannels], () => {
    nextTick(() => { if (showAddForm.value) clampPopupIntoView(addFormRef, addFormStyle) })
  })

  function addDefaults() {
    if (viewMode.value === 'week' && selectedSlot.value) {
      const slot = selectedSlot.value
      const start = Math.min(slot.h0, slot.h1), end = Math.max(slot.h0, slot.h1) + 1
      const pad = (value: number) => String(value).padStart(2, '0')
      return { date: slot.iso, time: `${pad(start)}:00`, endTime: end >= 24 ? '00:00' : `${pad(end)}:00` }
    }
    return { date: selectedDate.value || todayIso.value, ...defaultTimeRange() }
  }

  function openAddForm(anchor: HTMLElement | null = null) {
    addBtnRef.value = anchor
    newEvent.value = { name: '', ...addDefaults(), description: '', allDay: false }
    resetReminder()
    const button = addBtnRef.value
    if (button) {
      const buttonRect = button.getBoundingClientRect()
      const popupWidth = 240
      const sidebar = button.closest('.cal-sidebar')
      const sidebarRect = sidebar?.getBoundingClientRect()
      const centerX = sidebarRect ? sidebarRect.left + sidebarRect.width / 2 : buttonRect.right - popupWidth / 2
      const left = Math.max(8, Math.min(centerX - popupWidth / 2, window.innerWidth - popupWidth - 8))
      const popupHeight = 260
      const top = window.innerHeight - buttonRect.bottom - 8 >= popupHeight ? buttonRect.bottom + 8 : buttonRect.top - popupHeight - 8
      addFormStyle.value = { position: 'fixed', top: Math.max(8, top) + 'px', left: left + 'px', width: popupWidth + 'px', zIndex: 1000 }
    }
    showAddForm.value = true
    nextTick(() => clampPopupIntoView(addFormRef, addFormStyle))
  }

  async function deleteEvent(event: { id: string | number; _uid?: string }) {
    const match = (item: CalendarRenderItem) => event._uid != null ? item._uid === event._uid : String(item.id) === String(event.id)
    const previous = {
      extra: [...extraEvents.value], next: [...nextMonthEvents.value], spill: [...spilloverEvents.value],
    }
    await InteractionSync.execute({
      scope: 'calendar.event.delete', entityKey: `calendar-event:${event.id}`,
      apply: () => {
        extraEvents.value = extraEvents.value.filter(item => !match(item))
        nextMonthEvents.value = nextMonthEvents.value.filter(item => !match(item))
        spilloverEvents.value = spilloverEvents.value.filter(item => !match(item))
        refreshUpcoming(projectTimelines.value, [...extraEvents.value, ...nextMonthEvents.value])
        cacheMonth(cursor.value, extraEvents.value)
      },
      rollback: () => {
        extraEvents.value = previous.extra; nextMonthEvents.value = previous.next; spilloverEvents.value = previous.spill
        refreshUpcoming(projectTimelines.value, [...extraEvents.value, ...nextMonthEvents.value])
        cacheMonth(cursor.value, extraEvents.value)
      },
      request: mutation => eventsApi.delete(event.id as number, { mutationId: mutation.mutationId }),
      onCommit: () => { void fetchEvents(); void fetchNextMonthEvents(); void fetchSpilloverEvents() },
    })
  }

  async function saveEvent() {
    if (!newEvent.value.name) return
    if (newEvent.value.allDay) { newEvent.value.time = ''; newEvent.value.endTime = '' }
    const date = newEvent.value.date || selectedDate.value || todayIso.value
    const uid = 'u' + Date.now()
    const localItem: CalendarRenderItem = {
      _uid: uid, id: uid, date, time: newEvent.value.time || '', endTime: newEvent.value.endTime || '',
      name: newEvent.value.name, client: '', type: 'event', calendarType: 'event', accent: '#7b7fb2',
      description: newEvent.value.description || '',
    }
    extraEvents.value.push(localItem)
    selectedDate.value = date
    newEvent.value = { name: '', date: todayIso.value, ...defaultTimeRange(), description: '', allDay: false }
    showAddForm.value = false
    try {
      const created = await eventsApi.create({ title: localItem.name, date, time: localItem.time || undefined, endTime: localItem.endTime || undefined, type: 'event', description: localItem.description || undefined })
      const normalized = { ...normalizeCalendarEvent(created), _uid: uid }
      const index = extraEvents.value.findIndex(item => item._uid === uid)
      if (index !== -1) extraEvents.value[index] = normalized
      if (typeof created?.id === 'number') await applyReminders(created.id, localItem.name, date, localItem.time)
    } catch { /* 保留原有乐观项，下一次刷新会对账 */ }
    cacheMonth(cursor.value, [...extraEvents.value])
  }

  async function testReminderChannels(name?: string) {
    try {
      const result = await eventForm.testReminderChannels(name || '活动提醒')
      showAppNotice(result?.msg || '已发送测试消息')
    } catch { showAppError('测试失败，请稍后重试') }
  }

  return {
    showAddForm, addInputRef, addBtnRef, addFormRef, addFormStyle, newEvent, activeFormDate, isPastDate, eventForm,
    reminders, reminderChannels, imChannels, addReminder, removeReminderAt, toggleReminderChannel,
    resetReminder, testReminderChannels, openAddForm, saveEvent, deleteEvent,
    LEAD_OPTIONS, CHAN_LABEL, isNextDay, onToggleAllDay,
  }
}
