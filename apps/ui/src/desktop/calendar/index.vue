<script setup lang="ts">
import SkeletonGate from '@/components/common/feedback/skeleton/SkeletonGate.vue'
import { showAppError } from '@/composables/core/useAppToast'
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { CalendarRow } from '@desktop/bridge/bridge'
import PopupMenu from '@/components/common/overlays/PopupMenu.vue'
import EventFormPanel from '@/components/events/EventFormPanel.vue'
import { defaultTimeRange, useEventEditForm, type EventDraft } from '@/composables/calendar/useEventEditForm'
import CalendarContextMenu from '@/views/Calendar/components/CalendarContextMenu.vue'
import CalendarMorePopup from '@/views/Calendar/components/CalendarMorePopup.vue'
import CalendarSkeleton from '@/views/Calendar/components/CalendarSkeleton.vue'
import CalendarSidebar from '@/views/Calendar/components/CalendarSidebar.vue'
import CalendarToolbar from '@/views/Calendar/components/CalendarToolbar.vue'
import MonthGrid from '@/views/Calendar/components/MonthGrid.vue'
import WeekTimeline from '@/views/Calendar/components/WeekTimeline.vue'
import YearMonthPicker from '@/views/Calendar/components/YearMonthPicker.vue'
import { useCalendarNotes } from '@/composables/calendar/useCalendarNotes'
import { buildUpcomingList } from '@/composables/calendar/useCalendarUpcoming'
import { useUiStore } from '@/stores/ui'
import { useProjectStore } from '@/stores/projects'
import { usePreferencesStore } from '@/stores/preferences'
import { layout, useDesktopCalendarLayout } from './composables/useDesktopCalendarLayout'
import { useDesktopWeekEventDrag } from './composables/useDesktopWeekEventDrag'
import type { EventDetails } from './composables/useDesktopCalendar'
import { useCalendarDrag, type CalendarDragState } from '@/composables/calendar/useCalendarDrag'
import { useCalendarNav } from '@/composables/calendar/useCalendarNav'
import { useCalendarWeekInteraction } from '@/composables/calendar/useCalendarWeekInteraction'
import { timedLayoutFor as calculateTimedLayout } from '@/views/Calendar/utils/calendarLayout'
import { browserDayKey, buildCalendarMonthDays, localDayKey } from '@/utils/dateAttribution'
import { capBg, darkenHex } from '@/utils/calendarColors'
import type { CalendarContext } from '@/views/Calendar/domain/calendarContext'
import type { CalendarMonthDay, CalendarRenderItem, CalendarWeekDay } from '@/views/Calendar/domain/calendarTypes'

const props = defineProps<{
  events: CalendarRow[]
  busy: boolean
  initialLoading: boolean
  saveEvent: (event: CalendarRow | null, title: string, date: string, details: EventDetails) => Promise<CalendarRow | null>
  removeEvent: (event: CalendarRow) => Promise<boolean>
}>()
const emit = defineEmits<{
  'add-project': [range: { start: string; end: string }]
  'open-note': [id: number]
  'move-project': [id: number, range: { start: string; end: string }]
}>()

const projectStore = useProjectStore()
const preferences = usePreferencesStore()
const { locale } = useI18n()
const todayIso = computed(() => localDayKey(new Date()))
const selectedDate = ref<string | null>(todayIso.value)
const cursor = ref(new Date(`${todayIso.value.slice(0, 7)}-01T00:00:00`))
const weekRef = ref(new Date(`${todayIso.value}T00:00:00`))
const firstDay = computed(() => preferences.calendarWeekStart === 'sunday' ? 0 : 1)
const monthDays = computed(() => buildCalendarMonthDays(cursor.value, firstDay.value).map(day => ({
  ...day,
  isToday: !day.other && day.iso === todayIso.value,
})))
const monthWeeks = computed<CalendarMonthDay[][]>(() => {
  const weeks: CalendarMonthDay[][] = []
  for (let i = 0; i < monthDays.value.length; i += 7) weeks.push(monthDays.value.slice(i, i + 7))
  return weeks
})
const weekDays = computed<CalendarWeekDay[]>(() => {
  const start = new Date(weekRef.value)
  start.setDate(start.getDate() - ((start.getDay() - firstDay.value + 7) % 7))
  return Array.from({ length: 7 }, (_, index) => {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index)
    const iso = browserDayKey(day)
    return {
      iso,
      dateNum: day.getDate(),
      cn: new Intl.DateTimeFormat(locale.value, { weekday: 'narrow' }).format(day),
      md: `${day.getMonth() + 1}/${day.getDate()}`,
      isToday: iso === todayIso.value,
      isWeekend: day.getDay() === 0 || day.getDay() === 6,
    }
  })
})
const { viewMode, periodLabel, prev, next, goToday, setView, pickerOpen, pickerYear, pickerCursor, pickerStyle, togglePicker, selectYearMonth } = useCalendarNav({
  cursor,
  selectedDate,
  todayIso,
  weekRef,
  weekDays,
  locale,
})

watch(todayIso, (_today, previous) => { if (selectedDate.value === previous) goToday() })
const weekdays = computed(() => weekDays.value.map(day => day.cn))
const renderEvents = computed<CalendarRenderItem[]>(() => props.events.map(event => ({
  id: event.id,
  _uid: `desktop-event-${event.id}`,
  calendarType: 'event',
  name: event.title,
  date: event.date,
  time: event.time ?? undefined,
  endTime: event.endTime ?? undefined,
  description: event.description ?? undefined,
  accent: '#7b7fb2',
  version: event.version,
})))
const weekHeights = reactive<Record<number, number>>({})
const { selectedNotes, loading: notesLoading, failed: notesFailed } = useCalendarNotes(selectedDate)
const selectedDateLabel = computed(() => selectedDate.value
  ? new Intl.DateTimeFormat(locale.value, { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' }).format(new Date(`${selectedDate.value}T00:00:00`))
  : '')

const rangeSelect = reactive<{ active: boolean; anchor: string | null }>({ active: false, anchor: null })
const hoverRangeEnd = ref<string | null>(null)
const selectedRange = ref<{ start: string; end: string } | null>(null)
const drag = reactive<CalendarDragState>({ active: false, type: null, item: null, offsetDays: 0 })
const dragOverIso = ref<string | null>(null)
const hoveredDateIso = ref<string | null>(null)
const hoveredBarId = ref<string | number | null>(null)
const weekRowElements: HTMLElement[] = []
const weekRowObserver = new ResizeObserver(entries => {
  for (const entry of entries) weekHeights[Number((entry.target as HTMLElement).dataset.wi)] = entry.contentRect.height
})
const dragRange = computed(() => {
  const item = drag.item
  const target = dragOverIso.value
  if (!drag.active || !item || !target) return null
  if (drag.type === 'event' || drag.type === 'proj-chip') return { start: target, end: target }
  if (!item.startDate || !item.endDate) return null
  if (drag.type === 'proj-resize-start' && target <= item.endDate) return { start: target, end: item.endDate }
  if (drag.type === 'proj-resize-end' && target >= item.startDate) return { start: item.startDate, end: target }
  if (drag.type === 'proj-bar') {
    const start = addDays(target, -drag.offsetDays)
    return { start, end: addDays(start, daysBetween(item.startDate, item.endDate)) }
  }
  return null
})
const monthDragPreview = computed(() => {
  if (!drag.item || !dragRange.value) return null
  return { item: drag.item, range: dragRange.value }
})
const { projects, dayLayout, weekBarsCapped, wvAllDayH, weekAllDayShown, wvShownRows, allDayItemsFor, weekMoreFor, pbarStyle } =
  useDesktopCalendarLayout(renderEvents, monthWeeks, weekDays, weekHeights, monthDragPreview)
const selectedEvents = computed(() => {
  const date = selectedDate.value
  if (!date) return []
  return [
    ...projects.value.filter(project => (project.startDate ?? '') <= date && (project.endDate ?? '') >= date),
    ...renderEvents.value.filter(event => event.date === date),
  ]
})
const upcomingList = computed(() => buildUpcomingList(projects.value, renderEvents.value))
const activeRange = computed(() => {
  if (rangeSelect.active && rangeSelect.anchor && hoverRangeEnd.value) {
    const [start, end] = [rangeSelect.anchor, hoverRangeEnd.value].sort()
    return start === end ? null : { start, end }
  }
  return selectedRange.value
})

const eventFormOpen = ref(false)
const confirmingDelete = ref(false)
const eventPopupPosition = ref<{ x: number; y: number } | null>(null)
const eventPopupAnchor = ref<HTMLElement | null>(null)
const eventPopupCentered = ref(false)
const eventDraft = reactive<EventDraft>({ name: '', date: todayIso.value, ...defaultTimeRange(), description: '', allDay: false })
const eventForm = useEventEditForm()
const reminderError = ref('')
const savingEventForm = ref(false)
const editingEvent = ref<CalendarRow | null>(null)
const pickerRef = ref<InstanceType<typeof YearMonthPicker> | null>(null)
const contextMenuRef = ref<InstanceType<typeof CalendarContextMenu> | null>(null)
const context = ref<CalendarContext | null>(null)
const contextPosition = reactive({ x: 0, y: 0 })
const morePopupRef = ref<InstanceType<typeof CalendarMorePopup> | null>(null)
const morePopup = ref<{ open: boolean; items: CalendarRenderItem[]; dateLabel: string }>({ open: false, items: [], dateLabel: '' })
const moreAnchor = ref<HTMLElement | null>(null)

function eventFor(item: CalendarRenderItem) {
  return props.events.find(event => event.id === Number(item.id)) ?? null
}
function setWeekRef(el: Element | { $el?: Element } | null, index: number) {
  const row = el as HTMLElement | null
  const existing = weekRowElements[index]
  if (existing === row) return
  if (existing) weekRowObserver.unobserve(existing)
  if (row) {
    weekRowElements[index] = row
    weekRowObserver.observe(row)
  } else delete weekRowElements[index]
}
function isoFromPoint(x: number, y: number) {
  for (let index = 0; index < monthWeeks.value.length; index++) {
    const row = weekRowElements[index]
    if (!row) continue
    const rect = row.getBoundingClientRect()
    if (y < rect.top || y >= rect.bottom || x < rect.left || x > rect.right) continue
    const col = Math.max(0, Math.min(6, Math.floor((x - rect.left) / (rect.width / 7))))
    return monthWeeks.value[index]?.[col]?.iso ?? null
  }
  return null
}
function isInActiveRange(iso: string) {
  return !!activeRange.value && iso >= activeRange.value.start && iso <= activeRange.value.end
}
function onCellMouseDown(day: CalendarMonthDay, event: MouseEvent) {
  if (event.button !== 0 || drag.active || (event.target as HTMLElement).closest('.event-chip,.chip-more-btn,.project-bar,.bar-rh')) return
  event.preventDefault()
  context.value = null
  const startIso = day.iso
  let dragging = false
  const move = (moveEvent: MouseEvent) => {
    const iso = isoFromPoint(moveEvent.clientX, moveEvent.clientY)
    if (!iso) return
    if (!dragging && iso !== startIso) {
      dragging = true
      rangeSelect.active = true
      rangeSelect.anchor = startIso
    }
    if (dragging) hoverRangeEnd.value = iso
  }
  const up = (upEvent: MouseEvent) => {
    document.removeEventListener('mousemove', move)
    document.removeEventListener('mouseup', up)
    const endIso = isoFromPoint(upEvent.clientX, upEvent.clientY) ?? startIso
    rangeSelect.active = false
    hoverRangeEnd.value = null
    if (dragging && endIso !== startIso) {
      const [start, end] = [startIso, endIso].sort()
      selectedRange.value = { start, end }
      document.addEventListener('click', click => click.stopPropagation(), { capture: true, once: true })
    } else {
      selectedRange.value = null
      selectedDate.value = startIso
    }
  }
  document.addEventListener('mousemove', move)
  document.addEventListener('mouseup', up)
}
function onMonthContextMenu(event: MouseEvent, week: CalendarMonthDay[]) {
  if ((event.target as HTMLElement).closest('.event-chip,.chip-more-btn,.project-bar')) return
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const col = Math.max(0, Math.min(6, Math.floor((event.clientX - rect.left) / (rect.width / 7))))
  const date = week[col]?.iso
  if (!date) return
  context.value = { type: 'month-cell', date, range: activeRange.value }
  contextPosition.x = event.clientX
  contextPosition.y = event.clientY
}
function openMore(event: MouseEvent, iso: string, items: CalendarRenderItem[]) {
  const anchor = event.currentTarget as HTMLElement
  if (morePopup.value.open && moreAnchor.value === anchor) {
    morePopup.value.open = false
    moreAnchor.value = null
    return
  }
  moreAnchor.value = anchor
  morePopup.value = {
    open: true,
    items,
    dateLabel: new Intl.DateTimeFormat(locale.value, { month: 'long', day: 'numeric' }).format(new Date(`${iso}T00:00:00`)),
  }
}
function closeMore() {
  morePopup.value.open = false
  moreAnchor.value = null
}
function openContext(event: MouseEvent, date: string, type: 'month-cell' | 'allday' = 'month-cell') {
  context.value = { type, date, range: activeRange.value }
  contextPosition.x = event.clientX
  contextPosition.y = event.clientY
}
function onAllDayContextMenu(event: MouseEvent) {
  if ((event.target as HTMLElement).closest('.wv-pbar,.wv-allday-ev,.wv-more')) return
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const index = (event.currentTarget as HTMLElement).classList.contains('wv-dhead')
    ? weekHeaderIndex(event)
    : Math.max(0, Math.min(6, Math.floor((event.clientX - rect.left) / (rect.width / 7))))
  const iso = weekDays.value[index]?.iso
  if (iso) openContext(event, iso, 'allday')
}
function onWeekColumnContextMenu(event: MouseEvent, day: CalendarWeekDay) {
  if ((event.target as HTMLElement).closest('.wv-ev')) return
  const slot = weekInteraction.wvSelectedSlot.value
  const hour = Math.max(0, Math.min(23, Math.floor((event.clientY - (event.currentTarget as HTMLElement).getBoundingClientRect().top) / layout.hourHeight)))
  const start = slot?.iso === day.iso ? Math.min(slot.h0, slot.h1) : hour
  const end = slot?.iso === day.iso ? Math.max(slot.h0, slot.h1) + 1 : hour + 1
  context.value = { type: 'week-column', date: day.iso, time: hourLabel(start), endTime: hourLabel(end) }
  contextPosition.x = event.clientX
  contextPosition.y = event.clientY
}
function popupPositionFromPoint(x: number, y: number) {
  const width = 240
  const height = 260
  const top = window.innerHeight - y - 8 >= height ? y + 8 : y - height - 8
  return {
    x: Math.max(8, Math.min(x - width / 2, window.innerWidth - width - 8)),
    y: Math.max(8, top),
  }
}
function openCreateEvent(date = selectedDate.value ?? todayIso.value, time = defaultTimeRange(), allDay = false, position?: { x: number; y: number }) {
  editingEvent.value = null
  Object.assign(eventDraft, { name: '', date, ...time, description: '', allDay })
  reminderError.value = ''
  eventForm.resetReminder()
  void eventForm.loadImTargets().catch(() => { reminderError.value = '提醒渠道加载失败' })
  eventPopupAnchor.value = null
  eventPopupCentered.value = false
  eventPopupPosition.value = position ?? popupPositionFromPoint(window.innerWidth / 2, window.innerHeight / 2)
  eventFormOpen.value = true
}
function openEditEvent(
  item: CalendarRenderItem,
  event?: MouseEvent,
  anchor = event?.currentTarget instanceof HTMLElement ? event.currentTarget : null,
) {
  const row = eventFor(item)
  if (!row) return
  if (event && eventFormOpen.value && editingEvent.value?.id === row.id) {
    if (!props.busy) eventFormOpen.value = false
    return
  }
  selectedDate.value = row.date
  editingEvent.value = row
  Object.assign(eventDraft, {
    name: row.title,
    date: row.date,
    time: row.time ?? '',
    endTime: row.endTime ?? '',
    description: row.description ?? '',
    allDay: !row.time,
  })
  reminderError.value = ''
  eventForm.resetReminder()
  eventPopupAnchor.value = anchor
  eventPopupCentered.value = !event && !anchor
  eventPopupPosition.value = event && !anchor ? popupPositionFromPoint(event.clientX, event.clientY) : null
  eventFormOpen.value = true
  void Promise.all([eventForm.loadReminders(row), eventForm.loadImTargets()]).catch(error => {
    if (editingEvent.value?.id === row.id) reminderError.value = error instanceof Error ? error.message : '活动提醒加载失败'
  })
}
const uiStore = useUiStore()
const calendarGrid = ref<HTMLElement | null>(null)
const calendarSidebar = ref<HTMLElement | null>(null)
watch([() => uiStore.pendingCalendarEvent, renderEvents], async ([target, events], _previous, onCleanup) => {
  if (!target) return
  const item = events.find(event => event.id === target.id)
  if (!item) return
  let cancelled = false
  onCleanup(() => { cancelled = true })
  const date = new Date(`${item.date}T00:00:00`)
  if (!Number.isNaN(date.getTime())) {
    cursor.value = new Date(date.getFullYear(), date.getMonth(), 1)
    weekRef.value = date
  }
  selectedDate.value = item.date
  await nextTick()
  if (cancelled || uiStore.pendingCalendarEvent !== target) return
  const selector = `[data-calendar-edit-event="${item.id}"]`
  const anchor = calendarGrid.value?.querySelector<HTMLElement>(selector)
    ?? calendarSidebar.value?.querySelector<HTMLElement>(selector)
    ?? null
  anchor?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  uiStore.pendingCalendarEvent = null
  openEditEvent(item, undefined, anchor)
}, { immediate: true })

function onSidebarEdit(payload: { item: CalendarRenderItem; event: MouseEvent }) {
  openEditEvent(payload.item, payload.event)
}
async function saveEvent() {
  const title = eventDraft.name.trim()
  if (!title || props.busy || savingEventForm.value || eventForm.loadingReminders.value || reminderError.value) return
  const details = {
    time: eventDraft.allDay ? null : eventDraft.time || null,
    endTime: eventDraft.allDay ? null : eventDraft.endTime || null,
    description: eventDraft.description.trim() || null,
  }
  savingEventForm.value = true
  try {
    const saved = await props.saveEvent(editingEvent.value, title, eventDraft.date, details)
    if (!saved) return
    editingEvent.value = saved
    if (eventDraft.date >= todayIso.value)
      await eventForm.applyReminders(saved.id, title, saved.date, details.time ?? undefined)
    eventFormOpen.value = false
  } catch (error) {
    showAppError(error instanceof Error ? error.message : '活动提醒保存失败')
  } finally {
    savingEventForm.value = false
  }
}
async function deleteEditedEvent() {
  const event = editingEvent.value
  if (!event || props.busy || confirmingDelete.value) return
  confirmingDelete.value = true
  try {
    if (await props.removeEvent(event)) eventFormOpen.value = false
  } finally {
    confirmingDelete.value = false
  }
}
function ctxAddEvent() {
  const value = context.value
  context.value = null
  const popupPosition = popupPositionFromPoint(contextPosition.x, contextPosition.y)
  if (value?.type === 'week-column') {
    openCreateEvent(value.date, { time: value.time, endTime: value.endTime }, false, popupPosition)
    return
  }
  openCreateEvent(value?.date ?? selectedDate.value ?? todayIso.value, value?.type === 'allday' ? { time: '', endTime: '' } : defaultTimeRange(), value?.type === 'allday', popupPosition)
}
function ctxAddProject() {
  const value = context.value
  context.value = null
  const date = value?.date ?? selectedDate.value ?? todayIso.value
  emit('add-project', value && (value.type === 'month-cell' || value.type === 'allday') && value.range
    ? value.range
    : { start: date, end: date })
}
function sidebarAddProject() {
  emit('add-project', activeRange.value ?? { start: selectedDate.value ?? todayIso.value, end: selectedDate.value ?? todayIso.value })
}

const weekInteraction = useCalendarWeekInteraction({
  viewMode,
  hourHeight: layout.hourHeight,
  weekDays,
  activeRange,
  rangeSelect,
  hoverRangeEnd,
  selRange: selectedRange,
  selectedDate,
  clearContext: () => { context.value = null },
  onSlotSelected: (slot, previous, event) => {
    selectedDate.value = slot.iso
    const isRepeatedSingleHour = slot.h0 === slot.h1 && previous?.iso === slot.iso && previous.h0 === slot.h0 && previous.h1 === slot.h1
    if (isRepeatedSingleHour) {
      openCreateEvent(slot.iso, { time: hourLabel(slot.h0), endTime: hourLabel(slot.h1 + 1) }, false, popupPositionFromPoint(event.clientX, event.clientY))
    }
  },
})
const weekEventDrag = useDesktopWeekEventDrag({
  hourHeight: layout.hourHeight,
  weekDates: () => weekDays.value.map(day => day.iso),
  blocked: () => props.busy,
  open: openEditEvent,
  async commit(item, { date, time, endTime }) {
    const row = eventFor(item)
    if (row && await props.saveEvent(row, row.title, date, { time, endTime })) selectedDate.value = date
  },
})
const weeklyEvents = computed(() => {
  const preview = weekEventDrag.preview.value
  return preview ? renderEvents.value.map(item => item.id === preview.id ? { ...item, ...preview.timing } : item) : renderEvents.value
})
function timedEventsFor(iso: string) {
  return calculateTimedLayout(weeklyEvents.value, iso, layout.hourHeight)
}
function onWeekEventHover(event: MouseEvent) {
  weekInteraction.onColLeave()
  weekEventDrag.hover(event)
}
function openAddFromSidebar(anchor: HTMLElement | null) {
  if (eventFormOpen.value) {
    eventFormOpen.value = false
    return
  }
  if (!anchor) {
    openCreateEvent()
    return
  }
  const buttonRect = anchor.getBoundingClientRect()
  const sidebarRect = anchor.closest('.cal-sidebar')?.getBoundingClientRect()
  const width = 240
  const height = 260
  const centerX = sidebarRect ? sidebarRect.left + sidebarRect.width / 2 : buttonRect.right - width / 2
  const top = window.innerHeight - buttonRect.bottom - 8 >= height ? buttonRect.bottom + 8 : buttonRect.top - height - 8
  openCreateEvent(selectedDate.value ?? todayIso.value, defaultTimeRange(), false, {
    x: Math.max(8, Math.min(centerX - width / 2, window.innerWidth - width - 8)),
    y: Math.max(8, top),
  })
}
function hourLabel(hour: number) {
  return String(hour % 24).padStart(2, '0') + ':00'
}
function daysBetween(start: string, end: string) {
  return (Date.parse(end) - Date.parse(start)) / 86400000
}
function addDays(iso: string, days: number) {
  return new Date(Date.parse(iso) + days * 86400000).toISOString().slice(0, 10)
}
function projectId(item: CalendarRenderItem) {
  return Number(String(item.id).slice(1))
}
function openProject(item: CalendarRenderItem) {
  closeMore()
  projectStore.openModal({ id: projectId(item) })
}
function commitDrag() {
  const item = drag.item
  const range = dragRange.value
  if (!item || !range || props.busy) return
  if (item.calendarType === 'event') {
    const row = eventFor(item)
    if (row && row.date !== range.start) void props.saveEvent(row, row.title, range.start, {})
  } else if (range.start !== item.startDate || range.end !== item.endDate) {
    emit('move-project', projectId(item), range)
  }
}
const calendarDrag = useCalendarDrag({ drag, dragOverIso, isoFromPoint, daysBetween, commitDrag, closeMorePopup: closeMore })
function selectMoreEvent(payload: { item: CalendarRenderItem; event: MouseEvent }) {
  const anchor = moreAnchor.value
  closeMore()
  openEditEvent(payload.item, payload.event, anchor)
}
function weekHeaderIndex(event: MouseEvent) {
  const head = (event.target as HTMLElement).closest('.wv-dhead')
  if (!head?.parentElement) return -1
  return Array.from(head.parentElement.querySelectorAll('.wv-dhead')).indexOf(head)
}
function selectWeekday(event: MouseEvent) {
  const day = weekDays.value[weekHeaderIndex(event)]
  if (!day) return
  selectedRange.value = null
  selectedDate.value = day.iso
}
function closePopupsOutside(event: MouseEvent) {
  const target = event.target as HTMLElement
  const addEventButton = target.closest('.cal-sidebar .add-event-btn:not(.add-proj-btn)')
  const eventTrigger = target.closest('[data-calendar-edit-event]')
  // 同一活动的点击（周视图中为 mouseup）负责切换弹层，按下时保留打开状态。
  const togglesCurrentEvent = event.button === 0 && editingEvent.value
    && eventTrigger?.getAttribute('data-calendar-edit-event') === String(editingEvent.value.id)
    && !target.closest('.ev-del-btn')
  if (eventFormOpen.value && !props.busy && !addEventButton && !togglesCurrentEvent && !target.closest('.desktop-calendar-add-popup, .dp-popup')) eventFormOpen.value = false
  if (pickerOpen.value && !pickerRef.value?.contains(target) && !target.closest('.period-btn')) pickerOpen.value = false
  if (context.value && !contextMenuRef.value?.contains(target)) context.value = null
  if (morePopup.value.open && !moreAnchor.value?.contains(target) && !morePopupRef.value?.contains(target)) closeMore()
}
function onEventPopupAfterLeave() {
  // 快速关闭后重开时，旧实例的离场回调可能晚于新一轮打开；不要清掉新弹层的位置。
  if (!eventFormOpen.value) {
    eventPopupAnchor.value = null
    eventPopupPosition.value = null
  }
}
onMounted(() => document.addEventListener('mousedown', closePopupsOutside, true))
onUnmounted(() => {
  weekRowObserver.disconnect()
  document.removeEventListener('mousedown', closePopupsOutside, true)
})
</script>

<template>
  <CalendarToolbar
    :period-label="periodLabel"
    :view-mode="viewMode"
    :picker-open="pickerOpen"
    @prev="prev"
    @next="next"
    @today="goToday"
    @set-view="setView"
    @toggle-picker="togglePicker"
  />
  <div class="desktop-cal-layout">
    <section ref="calendarGrid" class="desktop-cal-grid glass-card" :class="{ 'is-initial-loading': initialLoading }" :aria-label="$t('pageUi.monthCalendar')">
      <div class="desktop-cal-month" :class="{ 'is-week-view': viewMode === 'week' }">
        <MonthGrid
          v-if="viewMode === 'month'"
          :weekdays="weekdays"
          :month-weeks="monthWeeks"
          :selected-date="selectedDate"
          :active-range="activeRange"
          :hovered-date-iso="hoveredDateIso"
          :hovered-bar-id="hoveredBarId"
          :drag="drag"
          :header-height="layout.headerHeight"
          :bar-height="layout.barHeight"
          :hday-type="() => null"
          :is-in-active-range="isInActiveRange"
          :day-layout="dayLayout"
          :week-bars-capped="weekBarsCapped"
          :deadline-warn-layer="() => null"
          :darken-hex="darkenHex"
          :set-week-ref="setWeekRef"
          @week-mousemove="(event, week) => { const rect = (event.currentTarget as HTMLElement).getBoundingClientRect(); const col = Math.max(0, Math.min(6, Math.floor((event.clientX - rect.left) / rect.width * 7))); hoveredDateIso = week[col]?.iso ?? null }"
          @week-mouseleave="hoveredDateIso = null"
          @week-contextmenu="onMonthContextMenu"
          @cell-mousedown="onCellMouseDown"
          @edit-event="openEditEvent"
          @start-event-drag="calendarDrag.startEventDrag"
          @open-project="openProject"
          @start-project-chip-drag="calendarDrag.startProjectChipDrag"
          @start-bar-drag="calendarDrag.startBarDrag"
          @start-bar-resize="calendarDrag.startBarResize"
          @show-more="openMore"
          @bar-mouseenter="hoveredBarId = $event"
          @bar-mouseleave="hoveredBarId = null"
        />
        <WeekTimeline
          v-else
          :week-days="weekDays"
          :range-select-active="rangeSelect.active"
          :wv-all-day-h="wvAllDayH"
          :wv-sel-cols="weekInteraction.wvSelCols.value"
          :wv-ad-hover="weekInteraction.wvAdHover.value"
          :week-all-day-shown="weekAllDayShown"
          :wv-shown-rows="wvShownRows"
          :all-day-items-for="allDayItemsFor"
          :week-more-for="weekMoreFor"
          :pbar-style="pbarStyle"
          :cap-bg="capBg"
          :darken-hex="darkenHex"
          :set-all-day-grid-ref="weekInteraction.setAllDayGridRef"
          :hour-height="layout.hourHeight"
          :selected-slot="weekInteraction.wvSelectedSlot.value"
          :hover="weekInteraction.wvHover.value"
          :dragging="weekInteraction.wvDragging.value"
          :now-top="(new Date().getHours() + new Date().getMinutes() / 60) * layout.hourHeight"
          :timed-layout-for="timedEventsFor"
          :is-day-selected="weekInteraction.wvDaySelected"
          @all-day-down="event => { selectWeekday(event); weekInteraction.onAllDayDown(event) }"
          @open-project="openProject"
          @show-more="openMore"
          @event-down="weekEventDrag.start"
          @event-hover="onWeekEventHover"
          @all-day-hover="weekInteraction.onAllDayHover"
          @all-day-leave="weekInteraction.onAllDayLeave"
          @all-day-contextmenu="onAllDayContextMenu"
          @edit-event="openEditEvent"
          @column-down="weekInteraction.onColDown"
          @column-move="weekInteraction.onColMove"
          @column-leave="weekInteraction.onColLeave"
          @column-contextmenu="onWeekColumnContextMenu"
        />
      </div>
      <SkeletonGate v-if="initialLoading">
        <CalendarSkeleton :rows="viewMode === 'month' ? monthWeeks.length : 12" />
      </SkeletonGate>
    </section>
    <aside ref="calendarSidebar" class="desktop-cal-info">
      <CalendarSidebar
        :selected-date-label="selectedDateLabel"
        :selected-events="selectedEvents"
        :selected-notes="selectedNotes"
        :notes-loading="notesLoading"
        :notes-failed="notesFailed"
        :upcoming-list="upcomingList"
        @add-project="sidebarAddProject"
        @open-project="openProject"
        @open-note="emit('open-note', $event)"
        @add-event="openAddFromSidebar"
        @edit-event="onSidebarEdit"
        @delete-event="item => { const event = eventFor(item); if (event) removeEvent(event) }"
      />
    </aside>
  </div>
  <CalendarMorePopup
    ref="morePopupRef"
    :open="morePopup.open"
    :items="morePopup.items"
    :date-label="morePopup.dateLabel"
    :style="{ width: '250px' }"
    :anchor="moreAnchor"
    @edit-event="selectMoreEvent"
    @open-project="openProject"
    @drag-item="payload => { if (viewMode === 'month') calendarDrag.startMoreItemDrag(payload.item, payload.event) }"
  />
  <Teleport to="body">
    <YearMonthPicker
      ref="pickerRef"
      :open="pickerOpen"
      :year="pickerYear"
      :cursor="pickerCursor"
      :style="pickerStyle"
      @prev-year="pickerYear--"
      @next-year="pickerYear++"
      @select="selectYearMonth"
    />
  </Teleport>
  <CalendarContextMenu
    ref="contextMenuRef"
    :open="context !== null"
    :context="context"
    :position="contextPosition"
    @add-event="ctxAddEvent"
    @add-project="ctxAddProject"
  />
  <PopupMenu
    :show="eventFormOpen && !confirmingDelete"
    :anchor="eventPopupAnchor"
    :position="eventPopupPosition"
    :centered="eventPopupCentered"
    placement="auto"
    :style="{ width: '240px' }"
    popup-class="desktop-calendar-add-popup"
    :transparent="true"
    :animated-blur="true"
    @after-leave="onEventPopupAfterLeave"
  >
    <p v-if="reminderError" role="alert">{{ reminderError }}</p>
    <EventFormPanel
      :event="eventDraft"
      :form="eventForm"
      :is-past-date="date => !!date && date < todayIso"
      :title="editingEvent ? $t('pageUi.editEvent') : $t('pageUi.addEvent')"
      :saving="busy || savingEventForm || eventForm.loadingReminders.value || !!reminderError"
      :show-delete="!!editingEvent"
      autofocus
      surface
      @save="saveEvent"
      @delete="deleteEditedEvent"
      @close="eventFormOpen = false"
    />
  </PopupMenu>
</template>

<style>
.desktop-cal-layout { display: grid; grid-template-columns: minmax(0, 1fr) 260px; gap: var(--space-md); flex: 1; height: auto; min-height: 0; }
.desktop-cal-grid,.desktop-cal-info > .cal-sidebar { min-width: 0; min-height: 0; }
.desktop-cal-grid { display: flex; flex-direction: column; padding: var(--page-content-inset); overflow: hidden; }
.desktop-cal-grid.is-initial-loading { position: relative; }
.desktop-cal-grid.is-initial-loading .desktop-cal-month { visibility: hidden; }
.desktop-cal-month { display: flex; flex: 1; flex-direction: column; min-height: 0; overflow: hidden; user-select: none; -webkit-user-select: none; }
.desktop-cal-month .weekday-row { margin: 0; }
.desktop-cal-month .month-body { min-height: 0; }
.desktop-cal-month .week-row { min-height: 0; }
.desktop-cal-month.is-week-view > .week-view { flex: 1; min-height: 0; }
.desktop-cal-month .month-cell { user-select: none; -webkit-user-select: none; }
.desktop-cal-info { display: flex; min-width: 0; min-height: 0; overflow: hidden; }
.desktop-cal-info > .cal-sidebar { flex: 1; width: 100%; overflow: auto; }
.desktop-calendar-add-popup { width: 240px; max-width: calc(100vw - 16px); }
@media (max-width: 820px) { .desktop-cal-layout { grid-template-columns: minmax(0, 1fr); overflow: auto; }.desktop-cal-grid { min-height: 560px; }.desktop-cal-info { min-height: 280px; overflow: visible; } }
</style>
