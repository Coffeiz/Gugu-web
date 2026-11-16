<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import type { CalendarRow } from '@/desktop/bridge'
import PopupMenu from '@/components/common/overlays/PopupMenu.vue'
import EventFormPanel from '@/components/events/EventFormPanel.vue'
import { defaultTimeRange, useEventEditForm, type EventDraft } from '@/composables/calendar/useEventEditForm'
import CalendarContextMenu from '@/views/Calendar/components/CalendarContextMenu.vue'
import CalendarMorePopup from '@/views/Calendar/components/CalendarMorePopup.vue'
import CalendarSidebar from '@/views/Calendar/components/CalendarSidebar.vue'
import CalendarToolbar from '@/views/Calendar/components/CalendarToolbar.vue'
import MonthGrid from '@/views/Calendar/components/MonthGrid.vue'
import WeekTimeline from '@/views/Calendar/components/WeekTimeline.vue'
import YearMonthPicker from '@/views/Calendar/components/YearMonthPicker.vue'
import { useCalendarDrag, type CalendarDragState } from '@/composables/calendar/useCalendarDrag'
import { useCalendarNav } from '@/composables/calendar/useCalendarNav'
import { useCalendarWeekInteraction } from '@/composables/calendar/useCalendarWeekInteraction'
import { timedLayoutFor as calculateTimedLayout } from '@/views/Calendar/utils/calendarLayout'
import { browserDayKey, buildCalendarMonthDays } from '@/utils/dateAttribution'
import { capBg, darkenHex } from '@/utils/calendarColors'
import type { CalendarContext } from '@/views/Calendar/domain/calendarContext'
import type { CalendarMonthDay, CalendarRenderItem, CalendarWeekDay } from '@/views/Calendar/domain/calendarTypes'

const props = defineProps<{ events: CalendarRow[]; busy: boolean }>()
const emit = defineEmits<{
  create: [title: string, date: string, details: { time: string | null; endTime: string | null; description: string | null }]
  update: [event: CalendarRow, title: string, date: string, details: { time: string | null; endTime: string | null; description: string | null }]
  delete: [event: CalendarRow]
  'add-project': [range: { start: string; end: string }]
}>()

const locale = ref('zh-CN')
const todayIso = ref(browserDayKey(new Date()))
const selectedDate = ref<string | null>(todayIso.value)
const cursor = ref(new Date(new Date().getFullYear(), new Date().getMonth(), 1))
const weekRef = ref(new Date())
const monthDays = computed(() => buildCalendarMonthDays(cursor.value, 1).map(day => ({
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
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7))
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
const { viewMode, periodLabel, prev, next, goToday, setView, pickerOpen, pickerYear, pickerStyle, togglePicker, selectYearMonth } = useCalendarNav({
  cursor,
  selectedDate,
  todayIso,
  weekRef,
  weekDays,
  locale,
})

const weekdays = computed(() => {
  const base = new Date(2024, 0, 1)
  return Array.from({ length: 7 }, (_, index) => new Intl.DateTimeFormat(locale.value, { weekday: 'narrow' }).format(new Date(2024, 0, base.getDate() + index)))
})
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
const selectedEvents = computed(() => renderEvents.value.filter(event => event.date === selectedDate.value))
const upcomingList = computed(() => renderEvents.value
  .filter(event => (event.date ?? '') >= todayIso.value)
  .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''))
  .slice(0, 8))
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
const activeRange = computed(() => {
  if (rangeSelect.active && rangeSelect.anchor && hoverRangeEnd.value) {
    const [start, end] = [rangeSelect.anchor, hoverRangeEnd.value].sort()
    return start === end ? null : { start, end }
  }
  if (drag.active && dragOverIso.value && drag.item?.calendarType === 'event') {
    return { start: dragOverIso.value, end: dragOverIso.value }
  }
  return selectedRange.value
})

const eventFormOpen = ref(false)
const eventPopupPosition = ref<{ x: number; y: number } | null>(null)
const eventDraft = reactive<EventDraft>({ name: '', date: todayIso.value, ...defaultTimeRange(), description: '', allDay: false })
const eventForm = useEventEditForm()
const editingEvent = ref<CalendarRow | null>(null)
const pickerRef = ref<InstanceType<typeof YearMonthPicker> | null>(null)
const contextMenuRef = ref<InstanceType<typeof CalendarContextMenu> | null>(null)
const context = ref<CalendarContext | null>(null)
const contextPosition = reactive({ x: 0, y: 0 })
const morePopupRef = ref<InstanceType<typeof CalendarMorePopup> | null>(null)
const morePopup = ref<{ open: boolean; items: CalendarRenderItem[]; dateLabel: string; style: Record<string, string | number | undefined> }>({ open: false, items: [], dateLabel: '', style: {} })
const moreAnchor = ref<HTMLElement | null>(null)

function eventFor(item: CalendarRenderItem) {
  return props.events.find(event => event.id === Number(item.id)) ?? null
}
function dayLayout(iso: string) {
  const items = renderEvents.value.filter(event => event.date === iso && !event.time)
  return { paddingTop: 0, visibleChips: items.slice(0, 3), moreCount: Math.max(0, items.length - 3), moreItems: items.slice(3) }
}
function setWeekRef(el: Element | { $el?: Element } | null, index: number) {
  const row = el as HTMLElement | null
  if (row) weekRowElements[index] = row
  else delete weekRowElements[index]
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
  const rect = anchor.getBoundingClientRect()
  const width = 250
  const estimatedHeight = Math.min(320, 56 + items.length * 30)
  const top = window.innerHeight - rect.bottom > estimatedHeight + 8 ? rect.bottom + 6 : Math.max(8, rect.top - estimatedHeight - 6)
  const left = Math.max(8, Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - 8))
  moreAnchor.value = anchor
  morePopup.value = {
    open: true,
    items,
    dateLabel: new Intl.DateTimeFormat(locale.value, { month: 'long', day: 'numeric' }).format(new Date(`${iso}T00:00:00`)),
    style: { position: 'fixed', top, left, width, zIndex: 2100 },
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
  const index = Math.max(0, Math.min(6, Math.floor((event.clientX - rect.left) / (rect.width / 7))))
  const iso = weekDays.value[index]?.iso
  if (iso) openContext(event, iso, 'allday')
}
function onWeekColumnContextMenu(event: MouseEvent, day: CalendarWeekDay) {
  if ((event.target as HTMLElement).closest('.wv-ev')) return
  const hour = Math.max(0, Math.min(23, Math.floor((event.clientY - (event.currentTarget as HTMLElement).getBoundingClientRect().top) / 36)))
  context.value = { type: 'week-column', date: day.iso, time: `${String(hour).padStart(2, '0')}:00`, endTime: `${String(Math.min(23, hour + 1)).padStart(2, '0')}:00` }
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
  eventForm.resetReminder()
  eventPopupPosition.value = position ?? popupPositionFromPoint(window.innerWidth / 2, window.innerHeight / 2)
  eventFormOpen.value = true
}
function openEditEvent(item: CalendarRenderItem) {
  const row = eventFor(item)
  if (!row) return
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
  eventForm.resetReminder()
  eventPopupPosition.value = popupPositionFromPoint(window.innerWidth / 2, window.innerHeight / 2)
  eventFormOpen.value = true
}
function onSidebarEdit(payload: { item: CalendarRenderItem; event: MouseEvent }) {
  openEditEvent(payload.item)
}
function saveEvent() {
  const title = eventDraft.name.trim()
  if (!title || props.busy) return
  const details = {
    time: eventDraft.allDay ? null : eventDraft.time || null,
    endTime: eventDraft.allDay ? null : eventDraft.endTime || null,
    description: eventDraft.description.trim() || null,
  }
  if (editingEvent.value) emit('update', editingEvent.value, title, eventDraft.date, details)
  else emit('create', title, eventDraft.date, details)
  eventFormOpen.value = false
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
  hourHeight: 36,
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
      const pad = (hour: number) => String(hour % 24).padStart(2, '0') + ':00'
      openCreateEvent(slot.iso, { time: pad(slot.h0), endTime: pad(slot.h1 + 1) }, false, popupPositionFromPoint(event.clientX, event.clientY))
    }
  },
})
function allDayItemsFor(iso: string) { return renderEvents.value.filter(event => event.date === iso && !event.time) }
function timedEventsFor(iso: string) { return calculateTimedLayout(renderEvents.value, iso, 36) }
function openAddFromSidebar(anchor: HTMLElement | null) {
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
function commitEventDrag() {
  const item = drag.item
  const targetDate = dragOverIso.value
  if (!item || item.calendarType !== 'event' || !targetDate) return
  const row = eventFor(item)
  if (row && row.date !== targetDate) emit('update', row, row.title, targetDate, {
    time: row.time,
    endTime: row.endTime,
    description: row.description,
  })
}
const calendarDrag = useCalendarDrag({
  drag,
  dragOverIso,
  isoFromPoint,
  daysBetween: (start, end) => Math.round((new Date(`${end}T00:00:00`).getTime() - new Date(`${start}T00:00:00`).getTime()) / 86400000),
  commitDrag: commitEventDrag,
  closeMorePopup: closeMore,
})
function selectMoreEvent(payload: { item: CalendarRenderItem }) { closeMore(); openEditEvent(payload.item) }
function selectWeekday(event: MouseEvent) {
  const head = (event.target as HTMLElement).closest('.wv-dhead')
  const headers = Array.from(head?.parentElement?.querySelectorAll('.wv-dhead') ?? [])
  const index = headers.indexOf(head as Element)
  if (index >= 0 && weekDays.value[index]) selectedDate.value = weekDays.value[index].iso
}
function closePopupsOutside(event: MouseEvent) {
  const target = event.target as HTMLElement
  if (eventFormOpen.value && !target.closest('.desktop-calendar-add-popup')) eventFormOpen.value = false
  if (pickerOpen.value && !pickerRef.value?.contains(target) && !target.closest('.period-btn')) pickerOpen.value = false
  if (context.value && !contextMenuRef.value?.contains(target)) context.value = null
  if (morePopup.value.open && !moreAnchor.value?.contains(target) && !morePopupRef.value?.contains(target)) closeMore()
}
onMounted(() => document.addEventListener('mousedown', closePopupsOutside, true))
onUnmounted(() => document.removeEventListener('mousedown', closePopupsOutside, true))
</script>

<template>
  <Teleport to="#desktop-calendar-topbar">
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
  </Teleport>
  <div class="desktop-cal-layout">
    <section class="desktop-cal-grid glass-card" aria-label="月历">
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
          :header-height="0"
          :bar-height="16"
          :hday-type="() => null"
          :is-in-active-range="isInActiveRange"
          :day-layout="iso => dayLayout(iso)"
          :week-bars-capped="() => ({ bars: [] })"
          :deadline-warn-layer="() => null"
          :bar-seg-fill="() => 100"
          :darken-hex="darkenHex"
          :set-week-ref="setWeekRef"
          @week-mousemove="(event, week) => { const rect = (event.currentTarget as HTMLElement).getBoundingClientRect(); const col = Math.max(0, Math.min(6, Math.floor((event.clientX - rect.left) / rect.width * 7))); hoveredDateIso = week[col]?.iso ?? null }"
          @week-mouseleave="hoveredDateIso = null"
          @week-contextmenu="onMonthContextMenu"
          @cell-mousedown="onCellMouseDown"
          @edit-event="item => openEditEvent(item)"
          @start-event-drag="calendarDrag.startEventDrag"
          @show-more="openMore"
          @bar-mouseenter="hoveredBarId = $event"
          @bar-mouseleave="hoveredBarId = null"
        />
        <WeekTimeline
          v-else
          :week-days="weekDays"
          :range-select-active="rangeSelect.active"
          :wv-all-day-h="42"
          :wv-sel-cols="weekInteraction.wvSelCols.value"
          :wv-ad-hover="weekInteraction.wvAdHover.value"
          :week-all-day-shown="[]"
          :wv-shown-rows="0"
          :all-day-items-for="allDayItemsFor"
          :week-more-for="() => []"
          :pbar-style="() => ({})"
          :cap-bg="capBg"
          :darken-hex="darkenHex"
          :set-all-day-grid-ref="weekInteraction.setAllDayGridRef"
          :hour-height="36"
          :selected-slot="weekInteraction.wvSelectedSlot.value"
          :hover="weekInteraction.wvHover.value"
          :dragging="weekInteraction.wvDragging.value"
          :now-top="(new Date().getHours() + new Date().getMinutes() / 60) * 36"
          :timed-layout-for="timedEventsFor"
          :is-day-selected="weekInteraction.wvDaySelected"
          @all-day-down="weekInteraction.onAllDayDown"
          @all-day-hover="weekInteraction.onAllDayHover"
          @all-day-leave="weekInteraction.onAllDayLeave"
          @all-day-contextmenu="onAllDayContextMenu"
          @edit-event="item => openEditEvent(item)"
          @column-down="weekInteraction.onColDown"
          @column-move="weekInteraction.onColMove"
          @column-leave="weekInteraction.onColLeave"
          @column-contextmenu="onWeekColumnContextMenu"
        />
      </div>
    </section>
    <aside class="desktop-cal-info">
      <CalendarSidebar
        :selected-date-label="selectedDateLabel"
        :selected-events="selectedEvents"
        :selected-notes="[]"
        :notes-loading="false"
        :notes-failed="false"
        :upcoming-list="upcomingList"
        @add-project="sidebarAddProject"
        @add-event="openAddFromSidebar"
        @edit-event="onSidebarEdit"
        @delete-event="item => { const event = eventFor(item); if (event) emit('delete', event) }"
      />
    </aside>
  </div>
  <CalendarMorePopup
    ref="morePopupRef"
    :open="morePopup.open"
    :items="morePopup.items"
    :date-label="morePopup.dateLabel"
    :style="morePopup.style"
    @edit-event="selectMoreEvent"
    @drag-item="payload => { closeMore(); calendarDrag.startEventDrag(payload.item, payload.event) }"
  />
  <Teleport to="body">
    <YearMonthPicker
      ref="pickerRef"
      :open="pickerOpen"
      :year="pickerYear"
      :cursor="cursor"
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
    :show="eventFormOpen"
    :position="eventPopupPosition"
    :style="{ width: '240px' }"
    popup-class="desktop-calendar-add-popup"
    :transparent="true"
    @after-leave="eventPopupPosition = null"
  >
    <EventFormPanel
      :event="eventDraft"
      :form="eventForm"
      :is-past-date="() => false"
      :title="editingEvent ? '编辑活动' : '添加活动'"
      :saving="busy"
      :show-reminders="false"
      autofocus
      surface
      @save="saveEvent"
      @close="eventFormOpen = false"
    />
  </PopupMenu>
</template>

<style>
.desktop-cal-layout { display: grid; grid-template-columns: minmax(0, 1fr) 260px; gap: 14px; height: 100%; min-height: 0; }
.desktop-cal-grid,.desktop-cal-info > .cal-sidebar { min-width: 0; min-height: 0; border-radius: var(--radius-lg, 16px); }
.desktop-cal-grid { display: flex; flex-direction: column; padding: var(--space-md, 16px); overflow: hidden; }
.desktop-cal-month { display: flex; flex: 1; flex-direction: column; min-height: 0; overflow: hidden; user-select: none; -webkit-user-select: none; }
.desktop-cal-month .weekday-row { margin: 0; }
.desktop-cal-month .month-body { min-height: 0; }
.desktop-cal-month .week-row { min-height: 0; }
.desktop-cal-month.is-week-view > .week-view { flex: 1; min-height: 0; }
.desktop-cal-month .month-cell { user-select: none; -webkit-user-select: none; }
.desktop-cal-info { display: flex; min-width: 0; min-height: 0; overflow: hidden; }
.desktop-cal-info > .cal-sidebar { flex: 1; width: 100%; overflow: auto; }
.desktop-topbar-calendar { display: flex; align-items: center; flex: 1; min-width: 0; height: 100%; }
.desktop-topbar-calendar > .cal-toolbar { width: 100%; height: 100%; padding: 0; overflow: visible; border: 0; border-radius: 0; background: transparent; box-shadow: none; }
.desktop-topbar-calendar > .cal-toolbar > .glass-bg { display: none; }
#desktop-calendar-topbar { position: absolute; inset: 0; z-index: 3; min-width: 0; pointer-events: none; }
#desktop-calendar-topbar > .cal-toolbar { position: absolute; inset: 0; display: block; width: auto; height: 100%; padding: 0; overflow: visible; border: 0; border-radius: 0; background: transparent; box-shadow: none; backdrop-filter: none; -webkit-backdrop-filter: none; pointer-events: none; }
#desktop-calendar-topbar > .cal-toolbar > .toolbar-left,
#desktop-calendar-topbar > .cal-toolbar > .toolbar-right { position: absolute; top: 50%; z-index: 4; display: flex; align-items: center; transform: translateY(-50%); pointer-events: auto; -webkit-app-region: no-drag; }
#desktop-calendar-topbar > .cal-toolbar > .toolbar-left { left: 0; }
#desktop-calendar-topbar > .cal-toolbar > .toolbar-right { right: 0; }
#desktop-calendar-topbar .toolbar-left button,
#desktop-calendar-topbar .toolbar-right button { pointer-events: auto; -webkit-app-region: no-drag; }
.desktop-calendar-add-popup { width: 240px; max-width: calc(100vw - 16px); }
@media (max-width: 820px) { .desktop-cal-layout { grid-template-columns: minmax(0, 1fr); overflow: auto; }.desktop-cal-grid { min-height: 560px; }.desktop-cal-info { min-height: 280px; overflow: visible; } }
</style>
