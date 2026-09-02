<template>
  <div class="cal-page">

    <CalendarToolbar
      :period-label="periodLabel"
      :view-mode="viewMode"
      :picker-open="pickerOpen"
      @prev="prev"
      @next="next"
      @today="goToday"
      @set-view="onToolbarViewChange"
      @toggle-picker="togglePicker"
    />

    <!-- 主体 -->
    <div class="cal-layout">

      <!-- 日历主区 -->
      <div class="cal-main glass-card">
        <!-- ───── 月视图 ───── -->
        <MonthGrid
          v-if="viewMode === 'month'"
          :weekdays="weekdays"
          :month-weeks="monthWeeks"
          :selected-date="selectedDate"
          :active-range="activeRange"
          :hovered-date-iso="hoveredDateIso"
          :hovered-bar-id="hoveredBarId"
          :drag="drag"
          :header-height="HEADER_H"
          :bar-height="BAR_H"
          :hday-type="hdayType"
          :is-in-active-range="isInActiveRange"
          :day-layout="dayLayout"
          :week-bars-capped="weekBarsCapped"
          :deadline-warn-layer="deadlineWarnLayer"
          :bar-seg-fill="barSegFill"
          :darken-hex="darkenHex"
          :set-week-ref="setWeekRef"
          @week-mousemove="onWeekMouseMove"
          @week-mouseleave="hoveredDateIso = null"
          @week-contextmenu="onWeekContextMenu"
          @cell-mousedown="onCellMouseDown"
          @open-project="openProject"
          @edit-event="(item, event) => openEditForm(item, event, true)"
          @start-project-chip-drag="startProjChipDrag"
          @start-event-drag="startEventDrag"
          @show-more="showMore"
          @start-bar-drag="startBarDrag"
          @start-bar-resize="startBarResize"
          @bar-mouseenter="hoveredBarId = $event"
          @bar-mouseleave="hoveredBarId = null"
        />

        <!-- ───── 周视图（时间轴）───── -->
        <WeekTimeline
          v-else
          :week-days="weekDays"
          :range-select-active="rangeSelect.active"
          :wv-all-day-h="wvAllDayH"
          :wv-sel-cols="wvSelCols"
          :wv-ad-hover="wvAdHover"
          :week-all-day-shown="weekAllDayShown"
          :wv-shown-rows="wvShownRows"
          :all-day-items-for="allDayItemsFor"
          :week-more-for="weekMoreFor"
          :pbar-style="pbarStyle"
          :cap-bg="capBg"
          :darken-hex="darkenHex"
          :set-all-day-grid-ref="setAllDayGridRef"
          :hour-height="HOUR_H"
          :selected-slot="wvSelectedSlot"
          :hover="wvHover"
          :dragging="wvDragging"
          :now-top="nowTop"
          :timed-layout-for="timedLayoutFor"
          :is-day-selected="wvDaySelected"
          @all-day-down="onAllDayDown"
          @all-day-hover="onAllDayHover"
          @all-day-leave="onAllDayLeave"
          @all-day-contextmenu="onAllDayContextMenu"
          @open-project="openProject"
          @edit-event="(item, event) => openEditForm(item, event, true)"
          @show-more="showMore"
          @column-down="onColDown"
          @column-move="onColMove"
          @column-leave="onColLeave"
          @column-contextmenu="onColContextMenu"
          @event-down="onEvDown"
          @event-hover="onEvHover"
        />
      </div>

      <!-- 侧栏 -->
      <CalendarSidebar
        :selected-date-label="selectedDateLabel"
        :has-active-range="!!activeRange"
        :selected-events="selectedEvents"
        :upcoming-list="upcomingList"
        @add-project="ctxAddProject"
        @add-event="openAddForm"
        @open-project="openProject"
        @edit-event="onSidebarEditEvent"
        @delete-event="deleteEvent"
      />

    </div>
  </div>

  <CalendarMorePopup ref="morePopupRef" :open="morePopup.open" :items="morePopup.items" :date-label="morePopup.dateLabel" :style="morePopup.style"
                     @open-project="onMoreProject" @edit-event="onMoreEditEvent" @drag-item="onMoreDragItem" />

  <Teleport to="body">
    <YearMonthPicker ref="pickerRef" :open="pickerOpen" :year="pickerYear" :cursor="cursor" :style="pickerStyle"
                     @prev-year="pickerYear--" @next-year="pickerYear++" @select="selectYearMonth" />
  </Teleport>

  <!-- 添加事件弹窗 -->
  <Teleport to="body">
    <Transition name="form-pop">
      <div v-if="showAddForm" class="add-event-popup shared-event-popup" ref="addFormRef" :style="addFormStyle">
        <EventFormPanel :event="newEvent" :form="eventForm" :is-past-date="isPastDate" :title="t('calendarUi.addEvent')" autofocus
                        @save="saveEvent" @close="showAddForm = false"
                        @test-reminder="testReminderChannels(newEvent.name)" />
      </div>
    </Transition>
  </Teleport>

  <CalendarContextMenu ref="cellCtxRef" :open="cellCtx !== null" :context="cellCtx" :position="cellCtxPosition"
                       @add-event="ctxAddEvent" @add-project="ctxAddProject" />

</template>

<script setup lang="ts">
import { ref, reactive, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { useProjectStore } from '@/stores/projects'
import { useUiStore } from '@/stores/ui'
import { useLiveStore } from '@/stores/live'
import { usePreferencesStore } from '@/stores/preferences'
import { useEventModalStore } from '@/stores/eventModal'
import { eventsApi } from '@/services/api'
import { InteractionSync } from '@/interaction/sync/InteractionSync'
import { InteractionSyncEventQueue } from '@/interaction/sync/InteractionSyncEventQueue'
import { useHolidays } from '@/composables/shared/useHolidays'
import { showAppError } from '@/composables/core/useAppToast'
import { defaultTimeRange } from '@/composables/calendar/useEventEditForm'
import CalendarToolbar from './components/CalendarToolbar.vue'
import CalendarSidebar from './components/CalendarSidebar.vue'
import YearMonthPicker from './components/YearMonthPicker.vue'
import CalendarMorePopup from './components/CalendarMorePopup.vue'
import CalendarContextMenu from './components/CalendarContextMenu.vue'
import EventFormPanel from '@/components/events/EventFormPanel.vue'
import MonthGrid from './components/MonthGrid.vue'
import WeekTimeline from './components/WeekTimeline.vue'

const { t, tm, locale } = useI18n()
import { useCalendarUpcoming } from '@/composables/calendar/useCalendarUpcoming'
import { useCalendarNav } from '@/composables/calendar/useCalendarNav'
import { useCalendarDrag, type CalendarDragState } from '@/composables/calendar/useCalendarDrag'
import { useCalendarData } from '@/composables/calendar/useCalendarData'
import { useCalendarWeekInteraction } from '@/composables/calendar/useCalendarWeekInteraction'
import { useCalendarEventForm } from '@/composables/calendar/useCalendarEventForm'
import type { CalendarContext } from './domain/calendarContext'
import type { CalendarHourHover, CalendarMonthDay, CalendarRenderItem, CalendarTimeSelection, CalendarWeekDay } from './domain/calendarTypes'
import { canResize, getDisplayColor } from './domain/calendarRules'
import { capBg, hexAlpha, darkenHex } from './utils/calendarColors'
import {
  maxSlots as calculateMaxSlots,
  weekBars as calculateWeekBars,
  capWeekBars,
  dayLayout as calculateDayLayout,
  timedLayoutFor as calculateTimedLayout,
  type CalendarLayoutConstants,
} from './utils/calendarLayout'
import Icon from '@/components/common/icons/Icon.vue'
// ── 本文件统一的"日历条目"形状 ──────────────────────────────────────────────
// 月视图 chip、周视图条目、侧栏、"更多"弹窗、拖拽 item 都在「用户活动」与「项目时间线」
// 渲染层暂时保留 CalendarRenderItem，布局回填字段和旧模板字段不会进入领域模型。
type CalItem = CalendarRenderItem

interface DateRange { start: string; end: string }

type MonthDayCell = CalendarMonthDay

type WeekViewDay = CalendarWeekDay
type WvSelectedSlot = CalendarTimeSelection
type WvHover = CalendarHourHover

const projectStore = useProjectStore()
const uiStore = useUiStore()
const liveStore = useLiveStore()
const prefsStore = usePreferencesStore()
const eventModalStore = useEventModalStore()
const todayIso = ref(toIso(new Date()))

let _midnightTimer: ReturnType<typeof setTimeout> | null = null
function scheduleMidnightTick() {
  const now = new Date()
  const msUntilMidnight = +new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1) - +now
  _midnightTimer = setTimeout(() => {
    todayIso.value = toIso(new Date())
    scheduleMidnightTick()
  }, msUntilMidnight)
}

const cursor       = ref(new Date(new Date().getFullYear(), new Date().getMonth(), 1))
const selectedDate = ref<string | null>(todayIso.value)

const { fetchYear, getHolidayType } = useHolidays()
const hdayCache = ref<Record<number, Record<string, { holiday?: boolean }>>>({})

async function loadHolidays() {
  const y = cursor.value.getFullYear()
  const years = [y]
  if (cursor.value.getMonth() === 11) years.push(y + 1)
  for (const yr of years) {
    if (!hdayCache.value[yr]) {
      const data = await fetchYear(yr)
      hdayCache.value = { ...hdayCache.value, [yr]: data }
    }
  }
}

function hdayType(isoDate: string | null | undefined) {
  if (!isoDate) return null
  const yr = +isoDate.slice(0, 4)
  return getHolidayType(hdayCache.value[yr], isoDate)
}
// ── 拖拽状态 ─────────────────────────────────────────────────────────────────
const drag = reactive<CalendarDragState>({
  active:     false,
  type:       null,   // 'event' | 'proj-chip' | 'proj-bar' | 'proj-resize-start' | 'proj-resize-end'
  item:       null,
  offsetDays: 0,      // proj-bar: days from startDate to where drag started
})
const hoveredBarId  = ref<string | number | null>(null)
const hoveredDateIso = ref<string | null>(null)

// ── 日期范围框选 ──────────────────────────────────────────────────────────────
const rangeSelect  = reactive<{ active: boolean; anchor: string | null }>({ active: false, anchor: null })
const hoverRangeEnd = ref<string | null>(null)
const selRange     = ref<DateRange | null>(null)   // { start, end } committed after mouseup

const activeRange = computed<DateRange | null>(() => {
  if (rangeSelect.active && rangeSelect.anchor && hoverRangeEnd.value) {
    const [a, b] = [rangeSelect.anchor, hoverRangeEnd.value].sort()
    if (a === b) return null   // 未跨天时不视为 range
    return { start: a, end: b }
  }
  return selRange.value
})

function isInActiveRange(iso: string) {
  const r = activeRange.value
  return r ? iso >= r.start && iso <= r.end : false
}

function onCellMouseDown(d: MonthDayCell, e: MouseEvent) {
  if (e.button !== 0) return
  if (drag.active) return
  if ((e.target as HTMLElement).closest('.event-chip,.chip-more-btn,.project-bar,.bar-rh')) return
  e.preventDefault()

  const startIso = d.iso
  cellCtx.value = null
  // mousedown 不清 selRange、不进 range 态：否则单击时 activeRange 瞬间变 null，会露出旧 selectedDate（跳一下）。
  // 只有真拖到别的天才进 range；单击在 mouseup 直接切到 selectedDate。
  let dragging = false
  const mm = (ev: MouseEvent) => {
    const iso = isoFromPoint(ev.clientX, ev.clientY)
    if (!iso) return
    if (!dragging && iso !== startIso) {
      dragging = true
      rangeSelect.active = true
      rangeSelect.anchor = startIso
    }
    if (dragging) hoverRangeEnd.value = iso
  }
  const mu = (ev: MouseEvent) => {
    document.removeEventListener('mousemove', mm)
    document.removeEventListener('mouseup', mu)
    const endIso = isoFromPoint(ev.clientX, ev.clientY) || startIso
    rangeSelect.active = false
    hoverRangeEnd.value = null
    if (dragging && endIso !== startIso) {
      const [a, b] = [startIso, endIso].sort()
      selRange.value = { start: a, end: b }
      document.addEventListener('click', ce => ce.stopPropagation(), { capture: true, once: true })
    } else {
      selRange.value = null
      selectedDate.value = startIso
    }
  }
  document.addEventListener('mousemove', mm)
  document.addEventListener('mouseup', mu)
}

// ── 右键菜单 ─────────────────────────────────────────────────────────────────
const cellCtx = ref<CalendarContext | null>(null)
const cellCtxPosition = reactive({ x: 0, y: 0 })
const cellCtxRef = ref<InstanceType<typeof CalendarContextMenu> | null>(null)

function onWeekContextMenu(e: MouseEvent, week: MonthDayCell[]) {
  if ((e.target as HTMLElement).closest('.event-chip,.chip-more-btn,.project-bar')) return
  const iso = isoFromPoint(e.clientX, e.clientY)
  if (!iso) return
  cellCtx.value = { type: 'month-cell', date: iso, range: activeRange.value ?? null }
  cellCtxPosition.x = e.clientX
  cellCtxPosition.y = e.clientY
}

function ctxAddEvent() {
  const context = cellCtx.value
  cellCtx.value = null
  if (!context) return
  const iso = context.type === 'week-column'
    ? context.date
    : context.range?.start ?? context.date ?? (selectedDate.value || todayIso.value)
  const tr = context.type === 'week-column' ? { time: context.time, endTime: context.endTime }
           : context.type === 'allday' ? { time: '', endTime: '' }
           : defaultTimeRange()
  newEvent.value = { name: '', date: iso, ...tr, description: '', allDay: context.type === 'allday' }
  resetReminder()
  const ADD_H = 260
  const ctxTop = (window.innerHeight - cellCtxPosition.y - 8 >= ADD_H)
    ? cellCtxPosition.y + 8
    : cellCtxPosition.y - ADD_H - 8
  addFormStyle.value = {
    position: 'fixed',
    top:  Math.max(8, ctxTop) + 'px',
    left: Math.max(8, Math.min(cellCtxPosition.x - 120, window.innerWidth - 258)) + 'px',
    width: '240px', zIndex: 1000,
  }
  showAddForm.value = true
  nextTick(() => clampPopupIntoView(addFormRef, addFormStyle))
}

function ctxAddProject() {
  const context = cellCtx.value
  cellCtx.value = null
  const range = context?.type === 'month-cell' || context?.type === 'allday' ? context.range : null
  const fallbackDate = context?.date || selectedDate.value || todayIso.value
  uiStore.newProjectRange = range
    ?? activeRange.value
    ?? { start: fallbackDate, end: fallbackDate }
  uiStore.openNewProject = true
}

// ── 周视图·全天区：横向多日框选（复用 rangeSelect/selRange/activeRange）+ 右键新建项目 ──
// 周视图日期选择与小时格选择由 useCalendarWeekInteraction 管理。
// 周视图日期选择与小时格选择由 useCalendarWeekInteraction 管理。
// 「日选择」判定：只看 activeRange（顶部日期格 + 全天区共用）。单选也走 selRange={iso,iso}，
// 故与「时段选择」(wvSelectedSlot) 互不干扰、互斥（见 onAllDayDown / onColDown）。
// wvDaySelected 由 useCalendarWeekInteraction 提供。
// 全天区悬停列（与小时格 hover 同理：opacity 叠层、可叠加在选区上）
// 全天区 hover 由 useCalendarWeekInteraction 提供。
// onAllDayDown 由 useCalendarWeekInteraction 提供。
function onAllDayContextMenu(e: MouseEvent) {
  if ((e.target as HTMLElement).closest('.wv-pbar,.wv-allday-ev,.wv-more')) return
  const iso = isoFromAllDayX(e.clientX)
  if (!iso) return
  cellCtx.value = { type: 'allday', date: iso, range: activeRange.value ?? null }
  cellCtxPosition.x = e.clientX; cellCtxPosition.y = e.clientY
}
// ── 周视图·小时区：右键在该天该时刻新建活动（有暗色选区则用选区时间段）──
function onColContextMenu(e: MouseEvent, d: WeekViewDay) {
  if ((e.target as HTMLElement).closest('.wv-ev')) return
  const p = (n: number) => String(n).padStart(2, '0')
  let time: string, endTime: string
  const sel = wvSelectedSlot.value
  if (sel && sel.iso === d.iso) {        // 复用左键拖出的选区时间段
    const a = Math.min(sel.h0, sel.h1), b = Math.max(sel.h0, sel.h1) + 1
    time = `${p(a)}:00`; endTime = b >= 24 ? '00:00' : `${p(b)}:00`
  } else {                               // 单选：右键点击处的整点 → 1 小时
    const h = hourAt(e.clientY, (e.currentTarget as HTMLElement).getBoundingClientRect())
    time = `${p(h)}:00`; endTime = h + 1 >= 24 ? '00:00' : `${p(h + 1)}:00`
  }
  cellCtx.value = { type: 'week-column', date: d.iso, time, endTime }
  cellCtxPosition.x = e.clientX; cellCtxPosition.y = e.clientY
}

function onWeekMouseMove(e: MouseEvent, week: MonthDayCell[]) {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  const col  = Math.floor((e.clientX - rect.left) / rect.width * 7)
  hoveredDateIso.value = week[Math.max(0, Math.min(6, col))]?.iso ?? null
}

const dragOverIso = ref<string | null>(null)

const dragOverRange = computed<DateRange | null>(() => {
  if (!drag.active || !dragOverIso.value || !drag.item) return null
  const iso = dragOverIso.value
  if (drag.type === 'event') return { start: iso, end: iso }
  if (drag.type === 'proj-chip') return { start: iso, end: iso }
  if (drag.type === 'proj-bar') {
    if (!drag.item.startDate || !drag.item.endDate) return null
    const newStart = addDays(iso, -drag.offsetDays)
    const dur      = daysBetween(drag.item.startDate, drag.item.endDate)
    return { start: newStart, end: addDays(newStart, dur) }
  }
  if (drag.type === 'proj-resize-start') {
    if (!drag.item.endDate || iso > drag.item.endDate) return null
    return { start: iso, end: drag.item.endDate }
  }
  if (drag.type === 'proj-resize-end') {
    if (!drag.item.startDate || iso < drag.item.startDate) return null
    return { start: drag.item.startDate, end: iso }
  }
  return null
})

function addDays(iso: string, n: number) {
  const d = new Date(iso + 'T00:00:00')
  d.setDate(d.getDate() + n)
  return toIso(d)
}
function barSegFill(bar: CalItem) {
  if (!bar.progress || !bar.startDate || !bar.endDate || !bar.segStartIso || !bar.segEndIso) return 0
  // total 含端点（+1）：与下面 segEndOff 的「含端点 +1」口径一致。
  // 否则 progressDays 最大只到 end-start，永远 < 末段 segEndOff(=total+1)，100% 的项目长条只填到 ~90%。
  const total = daysBetween(bar.startDate, bar.endDate) + 1
  if (total <= 0) return bar.progress
  const progressDays  = total * bar.progress / 100
  const segStartOff   = daysBetween(bar.startDate, bar.segStartIso)
  const segEndOff     = daysBetween(bar.startDate, bar.segEndIso) + 1
  if (progressDays <= segStartOff) return 0
  if (progressDays >= segEndOff)   return 100
  return Math.round((progressDays - segStartOff) / (segEndOff - segStartOff) * 100)
}

const DEADLINE_WARN_DAYS = 3   // 临近截止日的标红范围（天）：跟 store 里 urgentProjects 的阈值一致

// 项目条最后几天渐变标红，提示临近截止日：只在真正落到 bar.endDate 那一段（跨周项目其余段不提前标红，
// 同 barSegFill 一样按「段内」而非全局天数近似计算）计算；已完成的项目没有「临近」这回事，跳过。
// 返回一层可叠加的 CSS 背景（前景层，盖在原有进度填充渐变之上），没有警示时返回 null。
function deadlineWarnLayer(bar: CalItem) {
  if (!bar.endsHere || bar.status === 'done' || !bar.segStartIso || !bar.segEndIso) return null
  const segTotal = daysBetween(bar.segStartIso, bar.segEndIso) + 1
  if (segTotal <= 0) return null
  const warnDays = Math.min(DEADLINE_WARN_DAYS, segTotal)
  const warnStartPct = Math.round((segTotal - warnDays) / segTotal * 100)
  return `linear-gradient(to right, transparent 0%, transparent ${warnStartPct}%, rgba(200,70,70,0.3) 100%)`
}

function daysBetween(isoA: string, isoB: string) {
  return Math.round((+new Date(isoB + 'T00:00:00') - +new Date(isoA + 'T00:00:00')) / 86400000)
}
function isoFromPoint(x: number, y: number): string | null {
  // elementsFromPoint won't reach month-cell behind bars-layer; use grid bounds instead
  for (let wi = 0; wi < monthWeeks.value.length; wi++) {
    const el = weekRowElMap[wi]
    if (!el) continue
    const rect = el.getBoundingClientRect()
    if (y >= rect.top && y < rect.bottom && x >= rect.left && x < rect.right) {
      const col = Math.min(6, Math.max(0, Math.floor((x - rect.left) / (rect.width / 7))))
      return monthWeeks.value[wi]?.[col]?.iso ?? null
    }
  }
  return null
}
function isInDragRange(iso: string) {
  const r = dragOverRange.value
  return r ? iso >= r.start && iso <= r.end : false
}

const {
  startEventDrag,
  startProjectChipDrag: startProjChipDrag,
  startMoreItemDrag,
  startBarDrag,
  startBarResize,
} = useCalendarDrag({
  drag,
  dragOverIso,
  isoFromPoint,
  daysBetween,
  commitDrag: () => { void commitDrag() },
  closeMorePopup,
})

async function commitDrag() {
  const range = dragOverRange.value
  if (!range || !drag.item) return

  if (drag.type === 'event') {
    const ev = drag.item
    if (ev.date === range.start) return
    const patch = (list: CalItem[]) => {
      const idx = list.findIndex(e => e.id === ev.id)
      if (idx !== -1) list[idx] = { ...list[idx], date: range.start }
    }
    await InteractionSync.execute({
      scope: 'calendar.event.move',
      entityKey: `calendar-event:${ev.id}`,
      apply: () => {
        patch(extraEvents.value); patch(nextMonthEvents.value); patch(spilloverEvents.value)
        refreshUpcoming(projectTimelines.value, [...extraEvents.value, ...nextMonthEvents.value])
        cacheMonth(cursor.value, [...extraEvents.value])
      },
      rollback: () => {
        const restore = (list: CalItem[]) => {
          const i = list.findIndex(e => e.id === ev.id)
          if (i !== -1) list[i] = { ...list[i], date: ev.date }
        }
        restore(extraEvents.value); restore(nextMonthEvents.value); restore(spilloverEvents.value)
        refreshUpcoming(projectTimelines.value, [...extraEvents.value, ...nextMonthEvents.value])
        cacheMonth(cursor.value, [...extraEvents.value])
      },
      request: mutation => eventsApi.update(ev.id as unknown as number, { title: ev.name, date: range.start, description: ev.description || undefined, version: ev.version }, { mutationId: mutation.mutationId }),
      onCommit: updated => {
        const applyVer = (list: CalItem[]) => { const i = list.findIndex(e => e.id === ev.id); if (i !== -1 && updated?.version) list[i] = { ...list[i], version: updated.version } }
        applyVer(extraEvents.value); applyVer(nextMonthEvents.value); applyVer(spilloverEvents.value)
      },
      onError: async (e: any) => { if (e?.status === 409) { showAppError('活动已被其他用户修改，已刷新页面'); await fetchEvents() } },
    })
  }

  if (drag.type && ['proj-chip', 'proj-bar', 'proj-resize-start', 'proj-resize-end'].includes(drag.type)) {
    const projId = Number(String(drag.item.id).replace(/^p/, ''))
    const proj   = projectStore.projects.find(p => p.id === projId)
    if (!proj) return
    if (range.start === drag.item.startDate && range.end === drag.item.endDate) return
    try { await projectStore.updateProject(projId, { startDate: range.start, deadline: range.end }) } catch {}
  }
}

const pickerRef       = ref<InstanceType<typeof YearMonthPicker> | null>(null)

const morePopup    = ref<{ open: boolean; items: CalItem[]; dateLabel: string; style: Record<string, string | number | undefined> }>({ open: false, items: [], dateLabel: '', style: {} })
const morePopupRef = ref<InstanceType<typeof CalendarMorePopup> | null>(null)
const morePopupAnchor = ref<HTMLElement | null>(null)
let morePopupOpenTimer: ReturnType<typeof setTimeout> | null = null
function closeMorePopup() {
  if (morePopupOpenTimer) { clearTimeout(morePopupOpenTimer); morePopupOpenTimer = null }
  morePopup.value.open = false
  morePopupAnchor.value = null
}

// ── 动态行高测量 ──
const BAR_H    = 20  // 每条 bar / chip 的行高（slot 高，含间距）
const HEADER_H = 32  // bars-layer 第一条 bar 的 top：cell-num 底部(31) + 1px 间距
const CELL_TOP = 31  // cell-chips 起点：cell padding-top(7) + cell-num(24)
const BOTTOM_PAD = 8 // 底部安全留白（px）：cell padding-bottom(4) + 4px 视觉安全区
const CALENDAR_LAYOUT_CONSTANTS: CalendarLayoutConstants = {
  headerHeight: HEADER_H,
  cellTop: CELL_TOP,
  bottomPadding: BOTTOM_PAD,
  barHeight: BAR_H,
  hourHeight: 48,
}

const weekHeights = ref<Record<number, number>>({})   // { [weekIndex]: heightInPx }
const weekRowElMap: Record<number, HTMLElement> = {}       // 原生 el 引用，不需要响应式

function setWeekRef(el: Element | { $el?: Element } | null, wi: number) {
  const domEl = el as HTMLElement | null
  if (domEl) weekRowElMap[wi] = domEl
  else    delete weekRowElMap[wi]
}

let ro: ResizeObserver | null = null
function setupRO() {
  if (ro) ro.disconnect()
  ro = new ResizeObserver(entries => {
    const next = { ...weekHeights.value }
    entries.forEach(e => {
      const wi = parseInt((e.target as HTMLElement).dataset.wi || '')
      if (!isNaN(wi)) next[wi] = e.contentRect.height
    })
    weekHeights.value = next
  })
  Object.entries(weekRowElMap).forEach(([wi, el]) => {
    if (el) ro!.observe(el)
  })
}

// 某一行最多能放几个条目（项目条 + 更多按钮 + chip 共用这个池）
function maxSlots(wi: number) {
  const h = weekHeights.value[wi] ?? 90
  return calculateMaxSlots(h, CALENDAR_LAYOUT_CONSTANTS)
}

// ── 核心布局计算 ──

// weekBars 结果按周缓存，避免贪心算法在同一渲染周期内重复执行
const _weekBarsCache = new Map<string, CalItem[]>()
function weekBarsCached(week: { iso: string }[]) {
  const key = week[0].iso
  if (!_weekBarsCache.has(key)) _weekBarsCache.set(key, weekBars(week))
  return _weekBarsCache.get(key)!
}
// projectTimelines 变化时清缓存（watch 在 script setup 末尾注册）

function weekBarsCapped(week: { iso: string }[], wi: number) {
  const all = weekBarsCached(week)
  const max = maxSlots(wi)
  return {
    bars: capWeekBars(all, max),
    all,
  }
}

/**
 * 统一的格子布局：一次调用完成所有计算，返回 paddingTop、可见 chips、更多信息。
 * 消除模板中 dayLayout + nextAvailableRow 的重复 weekBars 调用。
 */
function dayLayout(iso: string, week: { iso: string }[], wi: number) {
  const { bars: cappedBars, all } = weekBarsCapped(week, wi)
  return calculateDayLayout(
    iso,
    cappedBars,
    all,
    effectiveProjectTimelines.value.filter(p => p.startDate === p.endDate && p.startDate === iso),
    effectiveExtraEvents.value,
    maxSlots(wi),
    CALENDAR_LAYOUT_CONSTANTS,
  )
}

// ── 统一"更多"弹窗 ──
function showMore(e: MouseEvent, iso: string, items: CalItem[]) {
  const anchor = e.currentTarget as HTMLElement | null
  if (morePopup.value.open && morePopupAnchor.value === anchor) {
    closeMorePopup()
    return
  }
  const d     = new Date(iso + 'T00:00:00')
  const label = new Intl.DateTimeFormat(locale.value, { month: 'long', day: 'numeric' }).format(d)
  const w     = 230
  const rect  = (e.currentTarget as HTMLElement).getBoundingClientRect()
  const estH  = 48 + items.length * 30   // 估算弹窗高度
  const gap   = 6
  const left  = Math.max(8, Math.min(rect.left + rect.width / 2 - w / 2, window.innerWidth - w - 8))

  const spaceBelow = window.innerHeight - rect.bottom
  const openUp     = spaceBelow < estH + gap && rect.top > estH + gap

  const style = openUp
    ? { position: 'fixed', bottom: (window.innerHeight - rect.top + gap) + 'px', left: left + 'px', width: w + 'px', zIndex: 2000, transformOrigin: 'bottom' }
    : { position: 'fixed', top: (rect.bottom + gap) + 'px',                      left: left + 'px', width: w + 'px', zIndex: 2000, transformOrigin: 'top' }

  if (morePopup.value.open) {
    morePopup.value = { open: false, items, dateLabel: label, style }
    morePopupAnchor.value = anchor
    morePopupOpenTimer = setTimeout(() => {
      if (morePopupAnchor.value === anchor) morePopup.value.open = true
      morePopupOpenTimer = null
    }, 140)
  } else {
    morePopup.value = { open: true, items, dateLabel: label, style }
    morePopupAnchor.value = anchor
  }
}

function onMoreProject(item: CalItem) {
  closeMorePopup()
  openProject(item)
}

function onMoreEditEvent(payload: { item: CalItem; event: MouseEvent }) {
  // 编辑活动与“更多”面板允许并存，避免点击活动时先销毁来源面板导致编辑弹窗的定位/动画抖动。
  openEditForm(payload.item, payload.event, true)
}

function onMoreDragItem(payload: { item: CalItem; event: MouseEvent }) {
  startMoreItemDrag(payload.item, payload.event)
}

const weekdays = computed(() => {
  const labels = tm('sharedUi.weekdays') as string[]
  return prefsStore.calendarWeekStart === 'sunday' ? labels : [...labels.slice(1), labels[0]]
})

function toIso(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}
function displayColor(item: CalItem) { return getDisplayColor(item) }
const {
  extraEvents,
  nextMonthEvents,
  spilloverEvents,
  visibleEvents,
  projectTimelines,
  fetchEvents,
  fetchNextMonthEvents,
  fetchSpilloverEvents,
  cacheMonth,
  applyLiveEvent,
  normalizeCalendarEvent,
} = useCalendarData({
  cursor,
  projects: () => projectStore.projects,
  doneMode: () => prefsStore.calendarDoneMode,
})

function singleEvents(iso: string) { return visibleEvents.value.filter(e => e.date === iso) }

function openProject(bar: CalItem) {
  const pid = Number(String(bar.id).replace(/^p/, ''))
  const proj = projectStore.projects.find(p => p.id === pid)
  if (proj) projectStore.openModal(proj)
}

const effectiveProjectTimelines = computed<CalItem[]>(() => {
  const range = dragOverRange.value
  if (!drag.active || !range || !drag.item) return projectTimelines.value
  if (!drag.type || !['proj-bar', 'proj-resize-start', 'proj-resize-end', 'proj-chip'].includes(drag.type)) return projectTimelines.value
  const dragId = drag.item.id
  return projectTimelines.value.map(p =>
    p.id === dragId ? { ...p, startDate: range.start, endDate: range.end } : p
  )
})

const effectiveExtraEvents = computed<CalItem[]>(() => {
  const base = visibleEvents.value
  const range = dragOverRange.value
  if (!drag.active || drag.type !== 'event' || !range || !drag.item) return base
  const evId = drag.item.id
  return base.map(e =>
    e.id === evId ? { ...e, date: range.start } : e
  )
})

const monthDays = computed<MonthDayCell[]>(() => {
  const y = cursor.value.getFullYear()
  const m = cursor.value.getMonth()
  const first    = new Date(y, m, 1)
  const last     = new Date(y, m + 1, 0)
  const weekStart = prefsStore.calendarWeekStart === 'sunday' ? 0 : 1
  const startDow = (first.getDay() - weekStart + 7) % 7
  const days: MonthDayCell[]     = []
  for (let i = startDow - 1; i >= 0; i--) {
    const d = new Date(y, m, -i)
    days.push({ key: `p${i}`, date: d.getDate(), iso: toIso(d), other: true, isToday: false, dow: (d.getDay()+6)%7 })
  }
  for (let i = 1; i <= last.getDate(); i++) {
    const d   = new Date(y, m, i)
    const iso = toIso(d)
    days.push({ key: iso, date: i, iso, other: false, isToday: iso === todayIso.value, dow: (d.getDay()+6)%7 })
  }
  const rem = 7 - (days.length % 7)
  if (rem < 7) for (let i = 1; i <= rem; i++) {
    const d = new Date(y, m + 1, i)
    days.push({ key: `n${i}`, date: i, iso: toIso(d), other: true, isToday: false, dow: (d.getDay()+6)%7 })
  }
  return days
})

const monthWeeks = computed(() => {
  const w: MonthDayCell[][] = []
  for (let i = 0; i < monthDays.value.length; i += 7) w.push(monthDays.value.slice(i, i+7))
  return w
})

function weekBars(week: { iso: string }[]): CalItem[] {
  return calculateWeekBars(effectiveProjectTimelines.value, week)
}

// ───────────────── 周视图（时间轴）─────────────────
const weekRef   = ref(new Date())     // 可视周内任一日期
const HOUR_H    = 48                   // 每小时像素高

const weekDays = computed<WeekViewDay[]>(() => {
  const weekStart = prefsStore.calendarWeekStart === 'sunday' ? 0 : 1
  const base = new Date(weekRef.value.getFullYear(), weekRef.value.getMonth(), weekRef.value.getDate())
  const offset = (base.getDay() - weekStart + 7) % 7
  base.setDate(base.getDate() - offset)
  const out: WeekViewDay[] = []
  for (let i = 0; i < 7; i++) {
    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i)
    const iso = toIso(d)
    out.push({ iso, dateNum: d.getDate(), cn: new Intl.DateTimeFormat(locale.value, { weekday: 'narrow' }).format(d),
               md: (d.getMonth()+1) + '/' + d.getDate(),
               isToday: iso === todayIso.value,
               isWeekend: d.getDay() === 0 || d.getDay() === 6 })
  }
  return out
})

const {
  viewMode, periodLabel, prev, next, goToday, setView,
  pickerOpen, pickerYear, pickerAnchorRef, pickerStyle, togglePicker, selectYearMonth,
} = useCalendarNav({ cursor, selectedDate, todayIso, weekRef, weekDays, locale })

const { upcomingList, refresh: refreshUpcoming } = useCalendarUpcoming()

const {
  wvAllDayGridRef, wvSelCols, wvAdHover, wvHover, wvDragging, wvSelectedSlot,
  setAllDayGridRef, isoFromAllDayX, hourAt, wvDaySelected,
  onAllDayDown, onAllDayHover, onAllDayLeave, onColDown, onColMove, onColLeave,
} = useCalendarWeekInteraction({
  viewMode,
  hourHeight: HOUR_H,
  weekDays,
  activeRange,
  rangeSelect,
  hoverRangeEnd,
  selRange,
  selectedDate,
  clearContext: () => { cellCtx.value = null },
  isExternalDragging: () => Boolean(_evDrag),
  onSlotSelected: handleWeekSlotSelected,
})

const {
  showAddForm, addBtnRef, addFormRef, addFormStyle, newEvent, isPastDate, eventForm,
  resetReminder, testReminderChannels, openAddForm, saveEvent, deleteEvent,
} = useCalendarEventForm({
  selectedDate,
  todayIso,
  viewMode,
  selectedSlot: wvSelectedSlot,
  cursor,
  extraEvents,
  nextMonthEvents,
  spilloverEvents,
  projectTimelines,
  refreshUpcoming,
  cacheMonth,
  normalizeCalendarEvent,
  fetchEvents,
  fetchNextMonthEvents,
  fetchSpilloverEvents,
  clampPopupIntoView,
})

function handleWeekSlotSelected(slot: WvSelectedSlot, previous: WvSelectedSlot | null, event: MouseEvent) {
  const p = (n: number) => String(n).padStart(2, '0')
  const endValue = slot.h1 + 1
  newEvent.value = {
    name: '', date: slot.iso, time: `${p(slot.h0)}:00`,
    endTime: endValue >= 24 ? '00:00' : `${p(endValue)}:00`,
    description: '', allDay: false,
  }
  resetReminder()
  const isSameClick = slot.h0 === slot.h1 && previous && previous.iso === slot.iso && previous.h0 === slot.h0 && previous.h1 === slot.h1
  if (!isSameClick) return
  const width = 240
  const left = Math.max(8, Math.min(event.clientX - width / 2, window.innerWidth - width - 8))
  addFormStyle.value = { position: 'fixed', top: Math.max(8, event.clientY + 8) + 'px', left: left + 'px', width: width + 'px', zIndex: 1000 }
  _wvFormOpening = true
  showAddForm.value = true
  nextTick(() => clampPopupIntoView(addFormRef, addFormStyle))
}

function timedLayoutFor(iso: string) {
  return calculateTimedLayout(visibleEvents.value, iso, HOUR_H)
}

// 某天「无时间」的活动 → 全天行
function allDayEventsFor(iso: string) { return visibleEvents.value.filter(e => e.date === iso && !e.time) }
// 单日项目（startDate===endDate）：weekBars 只收跨天条，这类在全天行当单天条目显示（同月视图把它当 chip）
function singleDayProjectsFor(iso: string): CalItem[] {
  return effectiveProjectTimelines.value
    .filter(p => p.startDate === p.endDate && p.startDate === iso)
    .map(p => ({ ...p, calendarType: 'project' as const }))
}
// 某天全天行的单天条目 = 单日项目 + 无时间活动，按月视图 chip 排序（done 末尾→优先级→开始/日期→创建）
function allDayItemsFor(iso: string): CalItem[] {
  const items: CalItem[] = [...singleDayProjectsFor(iso), ...allDayEventsFor(iso)]
  const prio = (p: CalItem) => ({ high: 3, medium: 2, low: 1 } as Record<string, number>)[p.priority ?? ''] ?? 0
  return items.sort((a, b) => {
    const da = a.status === 'done' ? 1 : 0, db = b.status === 'done' ? 1 : 0
    if (da !== db) return da - db
    const pd = prio(b) - prio(a); if (pd) return pd
    const as_ = a.startDate ?? a.date ?? '', bs = b.startDate ?? b.date ?? ''
    if (as_ !== bs) return as_.localeCompare(bs)
    return (a.createdAt ?? '').localeCompare(b.createdAt ?? '')
  })
}
// 本周项目跨天条（复用月视图的 weekBars 布局）
// weekBars 已按月视图同一逻辑排序（done 末尾→优先级→开始日→截止日→创建时间）并贪心分行
const weekAllDayBars  = computed(() => weekBars(weekDays.value))
const _WEEK_MAX_PROJ  = 10   // 全天行最多显示的项目数，超出收入「更多」（同月视图：封顶 + 更多）
const weekAllDayShown = computed(() => weekAllDayBars.value.slice(0, _WEEK_MAX_PROJ))
const weekAllDayMore  = computed(() => weekAllDayBars.value.slice(_WEEK_MAX_PROJ))
const wvShownRows     = computed(() => weekAllDayShown.value.reduce((m, b) => Math.max(m, (b.row ?? 0) + 1), 0))
// 第 ci 列被隐藏（超出 10）的跨天项目 = 覆盖该天的隐藏条；每天列各自「更多」，按实际位置显示（同月视图）
function weekMoreFor(ci: number) { return weekAllDayMore.value.filter(b => (b.colStart ?? 0) <= ci && (b.colEnd ?? 0) >= ci) }
function pbarStyle(bar: CalItem) {
  // left/right 同月视图 .project-bar：真正 start/end 的那一端留 6px 安全间距（对齐日格 padding），
  // 跨周中间段（不 start 也不 end）不留，贴到格边表示还在连续
  return { left:  bar.startsHere ? `calc(${(bar.colStart ?? 0) / 7 * 100}% + 6px)` : ((bar.colStart ?? 0) / 7 * 100) + '%',
           right: bar.endsHere   ? `calc(${(7 - (bar.colEnd ?? 0) - 1) / 7 * 100}% + 6px)` : ((7 - (bar.colEnd ?? 0) - 1) / 7 * 100) + '%',
           top: (bar.row ?? 0) * 20 + 'px',
           background: [deadlineWarnLayer(bar), capBg(bar.accent, bar.progress)].filter(Boolean).join(', '),   // 进度填充：与月视图/侧栏胶囊一致；deadlineWarnLayer 叠加临近截止日的标红
           borderColor: displayColor(bar) + '70', color: darkenHex(displayColor(bar)) }
}

// 全天行高度：取各列「跨天条行 + 该列单日条目行 + 该列若有更多再 +1」的最大行数（避免溢出）
const wvAllDayH = computed(() => {
  let maxRows = wvShownRows.value
  weekDays.value.forEach((d, ci) => {
    const rows = wvShownRows.value + allDayItemsFor(d.iso).length + (weekMoreFor(ci).length ? 1 : 0)
    if (rows > maxRows) maxRows = rows
  })
  return Math.max(maxRows * 20 + 6, 26)
})

// 当前时间红线（每分钟更新）
const nowMinutes = ref(new Date().getHours() * 60 + new Date().getMinutes())
const nowTop = computed(() => nowMinutes.value / 60 * HOUR_H)
let _nowTimer: ReturnType<typeof setInterval> | null = null
onMounted(() => { _nowTimer = setInterval(() => { nowMinutes.value = new Date().getHours() * 60 + new Date().getMinutes() }, 60000) })
onUnmounted(() => { if (_nowTimer) clearInterval(_nowTimer) })

function onToolbarViewChange(mode: string) {
  if (mode === 'month' || mode === 'week') setView(mode)
}
// 周视图导航/切换时把 cursor 同步到当周月份 → 触发按月 fetch（含 spillover，覆盖跨月那周）
watch(weekRef, v => {
  const m0 = new Date(v.getFullYear(), v.getMonth(), 1)
  if (m0.getFullYear() !== cursor.value.getFullYear() || m0.getMonth() !== cursor.value.getMonth()) cursor.value = m0
})

let _wvFormOpening = false   // mouseup 打开表单后屏蔽紧随的 click → handleClickOutside 误关
// 周视图小时格交互由 useCalendarWeekInteraction 提供。

// ── 周视图：拖活动边缘改起止时间 / 拖活动体改日期 ──
const _SNAP = 30   // 分钟吸附
interface EvDragState {
  kind: 'resize' | 'move'
  edge?: 'start' | 'end' | null
  colRect?: DOMRect
  moved: boolean
  id: string | number
  _uid?: string
  name: string
  description?: string
  version?: number
  date: string
  time: string
  endTime: string
  startMin?: number
  endMin?: number
  x0?: number
  y0?: number
  startMin0?: number
  dur?: number
  cols?: { left: number; right: number; iso?: string }[]
}
let _evDrag: EvDragState | null = null
function _toMin(t: string | undefined) { const [h, m] = (t || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0) }
function _fromMin(min: number) { const p = (n: number) => String(n).padStart(2, '0'); min = ((Math.round(min) % 1440) + 1440) % 1440; return `${p(Math.floor(min / 60))}:${p(min % 60)}` }
function _snapMin(min: number) { return Math.max(0, Math.min(1440, Math.round(min / _SNAP) * _SNAP)) }

function _setEventLocal(id: string | number, fields: Partial<CalItem>) {
  const apply = (list: CalItem[]) => { const i = list.findIndex(e => e.id === id); if (i !== -1) list[i] = { ...list[i], ...fields } }
  apply(extraEvents.value); apply(nextMonthEvents.value); apply(spilloverEvents.value)
}
async function _persistEvent(s: EvDragState) {
  refreshUpcoming(projectTimelines.value, [...extraEvents.value, ...nextMonthEvents.value])
  cacheMonth(cursor.value, [...extraEvents.value])
  await InteractionSync.execute({
    scope: 'calendar.event.resize',
    entityKey: `calendar-event:${s.id}`,
    apply: () => {},
    rollback: () => {},
    request: mutation => eventsApi.update(s.id as unknown as number, { title: s.name, date: s.date, time: s.time || null, endTime: s.endTime || null, description: s.description || undefined, version: s.version }, { mutationId: mutation.mutationId }),
    onCommit: updated => { if (updated?.version) _setEventLocal(s.id, { version: updated.version }) },
    onError: async (e: any) => { if (e?.status === 409) { showAppError('活动已被其他用户修改，已刷新页面'); await fetchEvents() } },
  })
}

function onEvResize(ev: CalItem, edge: 'start' | 'end' | null, e: MouseEvent) {   // 拖边缘改起止时间
  if (!canResize(ev)) return
  const colEl = (e.currentTarget as HTMLElement).closest('.wv-col')
  if (!colEl) return
  const startMin = _toMin(ev.time || '09:00')
  let endMin = ev.endTime ? _toMin(ev.endTime) : _toMin(ev.time || '09:00') + 60
  if (endMin <= startMin) endMin = 1440
  _evDrag = { kind: 'resize', edge, colRect: colEl.getBoundingClientRect(), moved: false,
              id: ev.id, _uid: ev._uid, name: ev.name, description: ev.description, version: ev.version, date: ev.date ?? '', time: ev.time ?? '', endTime: ev.endTime ?? '',
              startMin, endMin }
  document.body.style.userSelect = 'none'
  document.addEventListener('mousemove', _evDragMove)
  document.addEventListener('mouseup', _evDragUp)
  e.preventDefault()
}
function _evEdge(e: MouseEvent): 'start' | 'end' | null {   // 按下/悬停位置离上下边缘的判定：'start'(上) / 'end'(下) / null(中间)
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  const off = e.clientY - rect.top
  const EDGE = Math.min(7, rect.height / 2)   // 短块时减半，免上下交叠
  if (off <= EDGE) return 'start'
  if (off >= rect.height - EDGE) return 'end'
  return null
}
function onEvHover(e: MouseEvent) {   // 悬停活动：清掉小时格悬停 + 按位置切换光标（边缘=ns-resize、中间=grab）
  wvHover.value = null
  ;(e.currentTarget as HTMLElement).style.cursor = _evEdge(e) ? 'ns-resize' : 'grab'
}
function onEvDown(ev: CalItem, e: MouseEvent) {   // 按下活动体：近边缘=缩放起止，中间=自由移动，未拖=编辑
  if (e.button !== 0) return
  const edge = _evEdge(e)
  if (edge) return onEvResize(ev, edge, e)
  const sM = _toMin(ev.time || '09:00')
  let eM = ev.endTime ? _toMin(ev.endTime) : sM + 60
  if (eM <= sM) eM = sM + 60
  _evDrag = { kind: 'move', x0: e.clientX, y0: e.clientY, moved: false,
              id: ev.id, _uid: ev._uid, name: ev.name, description: ev.description, version: ev.version,
              date: ev.date ?? '', time: ev.time ?? '', endTime: ev.endTime ?? '',
              startMin0: sM, dur: eM - sM,
              cols: [...document.querySelectorAll('.week-view .wv-col')].map((el, i) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, iso: weekDays.value[i]?.iso } }) }
  document.body.style.userSelect = 'none'
  document.addEventListener('mousemove', _evDragMove)
  document.addEventListener('mouseup', _evDragUp)
}
function _evDragMove(e: MouseEvent) {
  if (!_evDrag) return
  if (_evDrag.kind === 'resize') {
    if (!_evDrag.colRect || _evDrag.startMin === undefined || _evDrag.endMin === undefined) return
    _evDrag.moved = true
    const min = _snapMin((e.clientY - _evDrag.colRect.top) / HOUR_H * 60)
    if (_evDrag.edge === 'start') _evDrag.startMin = Math.min(min, _evDrag.endMin - _SNAP)
    else _evDrag.endMin = Math.max(min, _evDrag.startMin + _SNAP)
    _evDrag.time = _fromMin(_evDrag.startMin)
    _evDrag.endTime = _evDrag.endMin >= 1440 ? '00:00' : _fromMin(_evDrag.endMin)
    _setEventLocal(_evDrag.id, { time: _evDrag.time, endTime: _evDrag.endTime })
    return
  }
  if (_evDrag.x0 === undefined || _evDrag.y0 === undefined || _evDrag.startMin0 === undefined || _evDrag.dur === undefined) return
  if (!_evDrag.moved && Math.abs(e.clientX - _evDrag.x0) + Math.abs(e.clientY - _evDrag.y0) < 5) return
  _evDrag.moved = true
  wvHover.value = null
  // 纵向：整体平移时间，保持时长，30 分吸附，限制在当天内
  let ns = _snapMin(_evDrag.startMin0 + (e.clientY - _evDrag.y0) / HOUR_H * 60)
  ns = Math.max(0, Math.min(1440 - _evDrag.dur, ns))
  const newTime = _fromMin(ns)
  const ne = ns + _evDrag.dur
  const newEnd = ne >= 1440 ? '00:00' : _fromMin(ne)
  // 横向：落在哪一列就是哪天
  const col = _evDrag.cols?.find(c => e.clientX >= c.left && e.clientX < c.right)
  const newDate = (col && col.iso) ? col.iso : _evDrag.date
  if (newDate !== _evDrag.date || newTime !== _evDrag.time || newEnd !== _evDrag.endTime) {
    _evDrag.date = newDate; _evDrag.time = newTime; _evDrag.endTime = newEnd
    _setEventLocal(_evDrag.id, { date: newDate, time: newTime, endTime: newEnd })
  }
}
function _evDragUp(e: MouseEvent) {
  document.removeEventListener('mousemove', _evDragMove)
  document.removeEventListener('mouseup', _evDragUp)
  document.body.style.userSelect = ''
  const s = _evDrag; _evDrag = null
  if (!s) return
  if (!s.moved) {   // 没拖动 = 单击 → 打开编辑（无论按在边缘还是中间）
    // mouseup 之后浏览器还会补发一次 click，冒泡到 handleClickOutside 时表单刚打开、
    // target 自然不在表单内——不设这个屏蔽标记，编辑弹窗会开出来又被那次补发的 click 秒关
    _wvFormOpening = true
    openEditForm({ _uid: s._uid, id: s.id, name: s.name, date: s.date, time: s.time, endTime: s.endTime, description: s.description, version: s.version }, e, true)
    return
  }
  selectedDate.value = s.date
  _persistEvent(s)
}

const selectedDateLabel = computed(() => {
  if (!selectedDate.value) return ''
  const d = new Date(selectedDate.value + 'T00:00:00')
  const dateLabel = new Intl.DateTimeFormat(locale.value, { month: 'long', day: 'numeric' }).format(d)
  const weekday = new Intl.DateTimeFormat(locale.value, { weekday: 'short' }).format(d)
  return `${dateLabel} · ${locale.value === 'zh-CN' ? '周' : ''}${weekday}`
})

const selectedEvents = computed<CalItem[]>(() => {
  const sel = selectedDate.value ?? ''
  const chips = singleEvents(sel)
  const prioVal = (p: CalItem) => ({ high: 3, medium: 2, low: 1 } as Record<string, number>)[p.priority ?? ''] ?? 0
  const activeProjects: CalItem[] = projectTimelines.value
    .filter(p => (p.startDate ?? '') <= sel && (p.endDate ?? '') >= sel)
    .map(p => ({ ...p, type: p.endDate === sel ? 'deadline' : 'project' }))
    .sort((a, b) => {
      const aDone = a.status === 'done' ? 1 : 0
      const bDone = b.status === 'done' ? 1 : 0
      if (aDone !== bDone) return aDone - bDone
      return prioVal(b) - prioVal(a)
        || (a.startDate ?? '').localeCompare(b.startDate ?? '')
        || (a.endDate ?? '').localeCompare(b.endDate ?? '')
        || (a.createdAt ?? '').localeCompare(b.createdAt ?? '')
    })
  return [...activeProjects, ...chips]
})

watch([projectTimelines, extraEvents, nextMonthEvents], () => {
  refreshUpcoming(projectTimelines.value, [...extraEvents.value, ...nextMonthEvents.value])
}, { immediate: true })
watch(activeRange, r => { uiStore.calendarActiveRange = r })

// 搜索跳转：导航到日程所在月份并高亮。immediate:true 是关键——从别的页面搜索时，
// GlobalSearch 先把 pendingCalendarEvent 设好值再 router.push 过来，日历页组件这时才挂载、
// 这个 watch 才第一次建立，值早已经是目标值、没有"变化"可触发；不给 immediate 就只有已经
// 停在日历页时再搜（ref 从有值→新值，watch 活着能看到变化）才会跳，这正是用户反馈的现象。
watch(() => uiStore.pendingCalendarEvent, async (target) => {
  if (!target) return
  uiStore.pendingCalendarEvent = null
  const d = new Date(target.date + 'T00:00:00')
  cursor.value = new Date(d.getFullYear(), d.getMonth(), 1)
  selectedDate.value = target.date ?? null
  await nextTick()
  _flashCalendarEvent(target.id)
}, { immediate: true })

// 仪表盘小日历点某天跳过来：定位到该日所在月并选中该日（不高亮具体活动）。immediate 同上。
watch(() => uiStore.pendingCalendarDate, (date) => {
  if (!date) return
  uiStore.pendingCalendarDate = null
  const d = new Date(date + 'T00:00:00')
  cursor.value = new Date(d.getFullYear(), d.getMonth(), 1)
  selectedDate.value = date
}, { immediate: true })

// 从别的页面搜索跳转时，日历页刚挂载、fetchEvents() 还在飞网络请求，侧栏这时可能还没渲染出
// 目标活动的 data-event-id——固定延时 150ms 一次性查大概率扑空（只跳对了月份/日期，没有高亮闪一下）。
// 改成轮询，等数据到位、DOM 出现再闪，最多等 2s（10 次 × 200ms）。
let calendarFlashRequest = 0
let calendarFlashTimer: ReturnType<typeof setTimeout> | null = null
let activeCalendarFlashElement: HTMLElement | null = null

function clearCalendarFlash() {
  if (calendarFlashTimer) clearTimeout(calendarFlashTimer)
  calendarFlashTimer = null
  activeCalendarFlashElement?.classList.remove('search-highlight')
  activeCalendarFlashElement = null
}

function _flashCalendarEvent(id: string | number) {
  const request = ++calendarFlashRequest
  clearCalendarFlash()
  let attempts = 0
  const findElement = () => {
    if (request !== calendarFlashRequest) return
    const el = document.querySelector<HTMLElement>(`[data-event-id="${id}"]`)
    if (!el) {
      if (attempts++ >= 30) return
      calendarFlashTimer = setTimeout(findElement, 50)
      return
    }
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el.classList.add('search-highlight')
    activeCalendarFlashElement = el
    calendarFlashTimer = setTimeout(() => {
      if (request !== calendarFlashRequest) return
      el.classList.remove('search-highlight')
      activeCalendarFlashElement = null
      calendarFlashTimer = null
    }, 1800)
  }
  calendarFlashTimer = setTimeout(findElement, 50)
}

// 弹窗加提醒后会变高，可能顶出屏幕底部、保存按钮被切掉。
// 量实际高度，把 top 往上抬到「底部留 SAFE_GAP 安全距离」；超高就靠 CSS max-height 内部滚动。
const SAFE_GAP = 12
function clampPopupIntoView(elRef: { value: HTMLElement | null }, styleRef: { value: Record<string, string | number | undefined> }) {
  const el = elRef.value
  if (!el) return
  const h = el.offsetHeight
  const cur = parseFloat(String(styleRef.value.top ?? '')) || 0
  const maxTop = window.innerHeight - h - SAFE_GAP
  const top = Math.max(SAFE_GAP, Math.min(cur, maxTop))
  if (Math.abs(top - cur) > 0.5) styleRef.value = { ...styleRef.value, top: top + 'px' }
}
function openEditForm(ev: Pick<CalItem, 'id' | 'name' | 'date' | 'time' | 'endTime' | 'description' | 'version' | '_uid'>, _nativeEv: MouseEvent, _useMousePos = false) {
  showAddForm.value = false
  if (typeof ev.id !== 'number') return
  if (eventModalStore.floating && eventModalStore.openEventId === ev.id) {
    eventModalStore.closeModal()
    return
  }
  const width = 240
  const editHeight = 300
  let left: number, top: number
  if (_useMousePos) {
    left = Math.max(8, Math.min(_nativeEv.clientX - width / 2, window.innerWidth - width - 8))
    top = window.innerHeight - _nativeEv.clientY - 8 >= editHeight
      ? _nativeEv.clientY + 8
      : _nativeEv.clientY - editHeight - 8
  } else {
    const element = (_nativeEv.currentTarget ?? _nativeEv.target) as HTMLElement
    const rect = element.getBoundingClientRect()
    const sidebar = element.closest('.cal-sidebar')
    const sidebarRect = sidebar?.getBoundingClientRect()
    const centerX = sidebarRect ? sidebarRect.left + sidebarRect.width / 2 : rect.left + rect.width / 2
    left = Math.max(8, Math.min(centerX - width / 2, window.innerWidth - width - 8))
    top = window.innerHeight - rect.bottom - 6 >= editHeight
      ? rect.bottom + 6
      : rect.top - editHeight - 6
  }
  eventModalStore.openModal(ev.id, {
    floating: true,
    position: { left, top: Math.max(8, top), width },
  })
}

function onSidebarEditEvent(payload: { item: CalItem; event: MouseEvent }) {
  openEditForm(payload.item, payload.event)
}

function handleClickOutside(e: MouseEvent) {
  const target = e.target as HTMLElement
  if (target.closest('.dp-popup')) return
  // mouseup 打开表单（周视图选时段新建 / 单击活动编辑）后，浏览器紧接着补发的 click 会冒泡到这里，
  // 此时表单刚打开、target 显然不在表单内——不拦会被当成"点了外面"瞬间关掉。屏蔽这一次即可。
  if (_wvFormOpening) { _wvFormOpening = false; return }
  if (showAddForm.value) {
    if (!addBtnRef.value?.contains(target) && !addFormRef.value?.contains(target))
      showAddForm.value = false
  }
  if (pickerOpen.value) {
    if (!pickerAnchorRef.value?.contains(target) && !pickerRef.value?.contains(target))
      pickerOpen.value = false
  }
  if (morePopup.value.open) {
    // 触发器位于 PopupMenu 外部，捕获阶段不能依赖按钮的 stopPropagation；
    // 否则点击同一个“更多”按钮会先关闭、再被按钮处理器重新打开。
    if (!target.closest('.chip-more-btn, .wv-more') && !morePopupRef.value?.contains(target))
      closeMorePopup()
  }
  if (cellCtx.value) {
    if (!cellCtxRef.value?.contains(target)) cellCtx.value = null
  }
}

onMounted(() => {
  document.addEventListener('click', handleClickOutside, true)
  fetchEvents()
  fetchNextMonthEvents()
  fetchSpilloverEvents()
  nextTick(setupRO)
  scheduleMidnightTick()
  loadHolidays()
})
onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside, true)
  ro?.disconnect()
  if (_midnightTimer) clearTimeout(_midnightTimer)
  calendarFlashRequest++
  clearCalendarFlash()
})

// 实时：咕咕/IM 改了日历 → 重新拉当前+下月活动
const calendarEventQueue = new InteractionSyncEventQueue()
let lastCalendarEventTick = 0
const refreshCalendarEvents = () => {
  void fetchEvents(); void fetchNextMonthEvents(); void fetchSpilloverEvents()
}
calendarEventQueue.register('calendar', applyLiveEvent, refreshCalendarEvents)
watch(() => liveStore.rev.calendar, () => {
  const currentEvent = liveStore.resourceEvent
  if (currentEvent?.resource === 'calendar' && currentEvent._t === lastCalendarEventTick) {
    lastCalendarEventTick = 0
    return
  }
  calendarEventQueue.enqueue('calendar')
})
watch(() => liveStore.resourceEvent, (event) => {
  if (!event || event.resource !== 'calendar') return
  lastCalendarEventTick = event._t
  calendarEventQueue.receive(event)
})
watch(cursor, () => { fetchEvents(); fetchSpilloverEvents(); loadHolidays() })
watch(monthWeeks, () => nextTick(setupRO))
watch([projectTimelines, dragOverRange], () => _weekBarsCache.clear())

</script>

<style scoped>
/* 已完成项目：日历各处（chip / 项目条 / 侧边栏 / 近期节点 / 更多弹层）统一淡化 */
.cal-done { opacity: 0.45; }
.cal-done:hover { opacity: 0.7; }   /* 悬停略恢复，方便看清要操作的那条 */

.cal-page { display: flex; flex-direction: column; gap: 14px; height: 100%; }
/* 浮在会动内容之上，用 backdrop-filter 会闪白带 → 改用 <GlassBg> faux 玻璃（同顶栏，见 DefaultLayout 注释）。
   宿主透明 + isolation 建层叠上下文让 GlassBg(z-index:-1) 压在内容下；backdrop-filter 显式关掉。*/

.cal-layout { display: grid; grid-template-columns: 1fr 260px; gap: 14px; flex: 1; min-height: 0; }
.cal-main { padding: 16px 16px 8px; display: flex; flex-direction: column; overflow: hidden; }
.chip-more-btn {
  height: 16px; box-sizing: border-box;
  font-size: 10px; font-weight: 500;
  padding: 0 7px; border-radius: 99px;
  border: 1px solid rgba(123,127,178,0.35);
  background: rgba(123,127,178,0.1); color: rgb(101,104,146);
  cursor: pointer; font-family: var(--font-sans);
  white-space: nowrap;
  display: flex; align-items: center;
}

.bar-proj-tag {
  flex-shrink: 0;
  font-size: 8px; font-weight: 700; letter-spacing: 0.04em;
  background: rgba(255,255,255,0.5);
  border-radius: 3px; padding: 0 3px; line-height: 11px;
  margin-right: 2px;
}
.cal-done-mark {
  display: inline-flex; align-items: center;
  color: #3a8870; vertical-align: -2px; margin-left: 2px;
}
.bar-status-dot {
  width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; margin-right: 4px;
}
.bsd-pending { background: #d46b6b; }
.bsd-active  { background: #c9943a; }
.bsd-done    { background: #5a9e88; }
.chip-proj-tag {
  flex-shrink: 0;
  font-size: 8px; font-weight: 700; letter-spacing: 0.04em;
  background: rgba(255,255,255,0.55);
  border-radius: 3px; padding: 0 3px; line-height: 11px;
  margin-right: 4px;
}
.chip-ev-tag {
  background: rgba(210,175,40,0.28); color: #7a5c00;
}



/* 侧栏 */
.cal-sidebar { padding: 16px; display: flex; flex-direction: column; gap: 0; overflow-y: auto; min-height: 0; scrollbar-gutter: auto; }
.sidebar-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.sidebar-date-label { font-size: 13px; font-weight: 700; color: var(--text-primary); }
.add-event-btn { display: flex; align-items: center; gap: 5px; padding: 5px 10px; border-radius: 8px; border: 1px solid rgba(123,127,178,0.3); background: rgba(123,127,178,0.08); font-size: 11px; font-weight: 600; cursor: pointer; color: var(--color-primary); font-family: var(--font-sans); transition: all 0.15s; }
.add-event-btn:hover { background: rgba(123,127,178,0.15); border-color: rgba(123,127,178,0.5); }
.add-proj-btn { background: var(--action-primary-bg); border-color: transparent; color: var(--content-on-accent); box-shadow: none; }
.add-proj-btn:hover { background: var(--action-primary-bg-hover); border-color: transparent; opacity: 1; box-shadow: none; }
.sidebar-events { display: flex; flex-direction: column; gap: 7px; margin-bottom: 4px; }
.sidebar-ev { display: flex; gap: 9px; align-items: flex-start; background: rgba(255,255,255,0.66); border: 1px solid rgba(255,255,255,0.88); border-radius: 10px; padding: 8px 10px; transition: box-shadow 0.25s ease; }
.sidebar-ev:hover { box-shadow: inset 0 0 0 100px rgba(255,255,255,0.2), 0 3px 10px rgba(0,0,0,0.10); }
.sidebar-ev-body { flex: 1; min-width: 0; }
.ev-del-btn {
  background: rgba(176,120,88,0.08);
  border: 1px solid rgba(176,120,88,0.3);
  cursor: pointer; flex-shrink: 0;
  color: #b07858; padding: 4px;
  display: flex; align-items: center; align-self: center;
  border-radius: 6px; margin-left: auto;
  transition: background 0.15s, transform 0.15s;
}
.ev-del-btn:hover { background: rgba(176,120,88,0.15); border-color: rgba(176,120,88,0.5); transform: scale(1.1); }
.sidebar-ev-bar { width: 3px; border-radius: 99px; align-self: stretch; flex-shrink: 0; min-height: 26px; }
.sidebar-ev-name { font-size: 12px; font-weight: 500; color: var(--text-primary); line-height: 1.4; overflow-wrap: break-word; word-break: break-word; }
/* 有结束时间时按最长内容「00:00–00:00」固定，周视图拖拽改时间不会推挤活动名；
   只有开始时间时不预留结束时间的空位，让名称紧跟日期。 */
.sidebar-ev-time { display: inline-block; font-size: 11px; font-weight: 600; color: var(--accent, #7b7fb2); margin-left: 7px; margin-right: 4px; font-variant-numeric: tabular-nums; }
.sidebar-ev-time.has-end-time { min-width: 11ch; }
.popup-row { display: flex; gap: 6px; align-items: center; }
.popup-row > :first-child { flex: 1; min-width: 0; }
.date-row { display: flex; align-items: center; gap: 8px; }
.date-row-picker { flex: 1; min-width: 0; }
.allday-toggle { display: flex; align-items: center; gap: 6px; flex-shrink: 0; font-size: 12.5px; color: var(--text-secondary); cursor: pointer; user-select: none; white-space: nowrap; }
.time-dash { color: #8a8fa8; font-size: 12px; font-weight: 600; }
.ev-type-badge {
  display: inline-block; vertical-align: middle; margin-left: 4px;
  font-size: 9px; font-weight: 700; letter-spacing: 0.04em;
  padding: 1px 5px; border-radius: 4px; line-height: 1.5;
  white-space: nowrap;
}
.ev-proj-badge {
  background: rgba(123,127,178,0.12); color: #7b7fb2;
  border: 1px solid rgba(123,127,178,0.2);
}
.ev-event-badge {
  background: rgba(210,175,40,0.15); color: #a07c00;
  border: 1px solid rgba(210,175,40,0.4);
}
.sidebar-ev-desc { font-size: 11px; color: var(--text-secondary); margin-top: 3px; line-height: 1.4; display: flex; align-items: flex-start; gap: 4px; }
.sidebar-empty { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 18px 0; color: var(--text-secondary); font-size: 12px; opacity: 0.55; }
.sidebar-divider { height: 1px; background: rgba(0,0,0,0.06); margin: 14px 0; }
.sidebar-section-title { font-size: 10px; font-weight: 600; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.07em; margin-bottom: 10px; }
.upcoming-item { display: flex; align-items: center; margin-bottom: 7px; }
.upcoming-item:last-child { margin-bottom: 0; }

.add-event-popup { background: rgba(255,255,255,0.72); backdrop-filter: var(--popup-blur); -webkit-backdrop-filter: var(--popup-blur); border: 1px solid rgba(255,255,255,0.75); border-radius: var(--event-popup-radius); box-shadow: inset 0 1px 0 rgba(255,255,255,0.98), 0 8px 32px rgba(60,70,100,0.12); padding: 16px; display: flex; flex-direction: column; gap: 9px; max-height: calc(100vh - 24px); overflow-y: auto; overscroll-behavior: contain; }
.add-event-popup.shared-event-popup { padding: 0; }
.popup-textarea:focus { border-color: rgba(123,127,178,0.4); box-shadow: 0 0 0 3px rgba(123,127,178,0.1); background: rgba(255,255,255,0.85); }
.popup-actions { display: flex; gap: 6px; justify-content: flex-end; align-items: center; margin-top: 2px; }
.popup-delete { padding: 5px 12px; border-radius: 8px; border: 1px solid rgba(176,120,88,0.3); background: rgba(176,120,88,0.08); font-size: 12px; cursor: pointer; color: #b07858; font-family: var(--font-family-ui); font-weight: 600; transition: background 0.12s, border-color 0.12s; }
.popup-delete:hover { background: rgba(176,120,88,0.15); border-color: rgba(176,120,88,0.5); }
.popup-save { padding: 5px 14px; border-radius: 8px; border: none; background: var(--action-primary-bg); color: var(--content-on-accent); font-size: 12px; font-weight: 600; cursor: pointer; font-family: var(--font-family-ui); transition: background-color 0.15s; box-shadow: none; }
.popup-save:disabled { opacity: 0.38; cursor: default; }
.popup-save:not(:disabled):hover { background: var(--action-primary-bg-hover); opacity: 1; }
.reminder-section { display: flex; flex-direction: column; gap: 6px; padding-top: 7px; border-top: 1px solid rgba(123,127,178,0.18); }
.reminder-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.reminder-label { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; font-weight: 600; color: var(--text-secondary); }
.reminder-item { display: flex; align-items: center; gap: 6px; }
.reminder-lead { font-size: 11px; font-weight: 600; color: var(--text-secondary); }
.reminder-test-bar { width: 100%; box-sizing: border-box; display: flex; align-items: center; justify-content: center; gap: 5px; margin-top: 7px; padding: 6px 10px; border-radius: 8px; border: 1px solid rgba(123,127,178,0.4); background: rgba(123,127,178,0.08); color: var(--text-secondary); font-size: 11px; font-weight: 600; cursor: pointer; font-family: var(--font-family-ui); transition: all 0.12s; }
.reminder-test-bar:hover { border-color: rgba(123,127,178,0.7); background: rgba(123,127,178,0.16); color: var(--text-primary); }
.reminder-del { display: flex; align-items: center; padding: 2px; border: none; background: none; cursor: pointer; color: #b07858; border-radius: 5px; }
.reminder-del:hover { background: rgba(176,120,88,0.12); }
.reminder-add { display: flex; gap: 6px; align-items: center; }
.lead-select { flex: 1; height: 28px; padding: 0 8px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.75); background: rgba(255,255,255,0.68); font-size: 11px; font-family: var(--font-family-ui); color: #1e2028; cursor: pointer; outline: none; }
.reminder-add-btn { flex-shrink: 0; padding: 5px 10px; border-radius: 8px; border: 1px solid rgba(123,127,178,0.3); background: rgba(123,127,178,0.1); color: var(--text-secondary); font-size: 11px; font-weight: 600; cursor: pointer; font-family: var(--font-family-ui); transition: background 0.12s; }
.reminder-add-btn:hover { background: rgba(123,127,178,0.2); }
.reminder-cancel { flex-shrink: 0; display: flex; align-items: center; padding: 4px; border: none; background: none; cursor: pointer; color: var(--text-secondary); border-radius: 6px; }
.reminder-cancel:hover { background: rgba(0,0,0,0.06); }
.reminder-add-toggle { width: 100%; box-sizing: border-box; text-align: center; padding: 6px 10px; border-radius: 8px; border: 1px dashed rgba(123,127,178,0.4); background: none; color: var(--text-secondary); font-size: 11px; font-weight: 600; cursor: pointer; font-family: var(--font-family-ui); transition: all 0.12s; }
.reminder-add-toggle:hover { border-color: rgba(123,127,178,0.7); color: var(--text-primary); background: rgba(123,127,178,0.06); }
/* 绝对定位浮在右侧，不参与 flex 居中，保证「开始—结束」时间仍水平居中 */
.nextday-tag { position: absolute; right: 10px; top: 50%; transform: translateY(-50%); font-size: 10px; font-weight: 600; color: #9590c4; background: rgba(123,127,178,0.1); padding: 1px 6px; border-radius: 5px; white-space: nowrap; pointer-events: none; }
.nextday-mini { margin-left: 4px; font-size: 9px; font-weight: 600; color: #a8a3c8; padding: 1px 4px; border-radius: 4px; background: rgba(123,127,178,0.1); vertical-align: 1px; }
.chan-block { display: flex; flex-direction: column; gap: 5px; }
.chan-chips { display: flex; gap: 5px; flex-wrap: wrap; }
.chan-chip { padding: 3px 11px; border-radius: 99px; border: 1px solid rgba(123,127,178,0.3); background: rgba(255,255,255,0.5); color: var(--text-secondary); font-size: 11px; font-weight: 600; cursor: pointer; font-family: var(--font-family-ui); transition: all 0.12s; }
.chan-chip.on { background: rgba(123,127,178,0.16); border-color: rgba(123,127,178,0.55); color: #5b5f8c; }
.form-pop-enter-active { transition: opacity 0.16s, transform 0.18s cubic-bezier(0.34,1.2,0.64,1); }
.form-pop-leave-active { transition: opacity 0.12s, transform 0.12s ease-in; }
.form-pop-enter-from, .form-pop-leave-to { opacity: 0; transform: scale(0.95) translateY(-6px); }

</style>
