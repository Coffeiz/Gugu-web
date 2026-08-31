<template>
  <div class="weekday-row">
    <span v-for="w in weekdays" :key="w" class="weekday-hdr" :class="{ weekend: w === '六' || w === '日' }">{{ w }}</span>
  </div>
  <div class="month-body">
    <template v-for="(week, wi) in monthWeeks" :key="wi">
      <div
        class="week-row"
        :data-wi="wi"
        :ref="el => setWeekRef(el, wi)"
        @mousemove="emit('week-mousemove', $event, week)"
        @mouseleave="emit('week-mouseleave')"
        @contextmenu.prevent="emit('week-contextmenu', $event, week)"
      >
      <div
        v-for="d in week" :key="d.key"
        class="month-cell"
        :data-iso="d.iso"
        :class="{
          'other-month': d.other,
          'is-today': d.isToday,
          'is-selected': d.iso === selectedDate && !activeRange,
          'is-weekend': d.dow >= 5,
          'is-holiday': !d.other && hdayType(d.iso) === 'holiday',
          'is-workday': !d.other && hdayType(d.iso) === 'workday',
          'cell-hovered': d.iso === hoveredDateIso,
          'in-range': isInActiveRange(d.iso),
          'range-start': activeRange && d.iso === activeRange.start,
          'range-end': activeRange && d.iso === activeRange.end,
        }"
        @mousedown="emit('cell-mousedown', d, $event)"
      >
        <div class="cell-head">
          <div class="cell-num">{{ d.date }}</div>
          <span v-if="!d.other && hdayType(d.iso)" class="hday-badge" :class="'hday-' + hdayType(d.iso)">{{ hdayType(d.iso) === 'holiday' ? '休' : '班' }}</span>
        </div>
        <template v-for="lay in [dayLayout(d.iso, week, wi)]" :key="'lay'">
          <div class="cell-chips" :style="{ paddingTop: lay.paddingTop + 'px' }">
            <div
              v-for="ev in lay.visibleChips" :key="ev.id"
              class="event-chip cal-chip"
              :class="{ 'chip-proj': ev.calendarType === 'project', 'chip-ev-click': ev.calendarType === 'event', 'cal-done': ev.calendarType === 'project' && ev.status === 'done' }"
              :style="{ background: ev.accent + '28', color: darkenHex(ev.accent), borderColor: ev.accent + '70', cursor: ev.calendarType === 'project' && ev.status === 'done' ? 'pointer' : (ev.calendarType ? 'grab' : 'default') }"
              @click.left.stop="ev.calendarType === 'project' ? emit('open-project', ev) : (ev.calendarType === 'event' && emit('edit-event', ev, $event))"
              @contextmenu.prevent.stop="ev.calendarType === 'event' && emit('edit-event', ev, $event)"
              @mousedown.stop="ev.calendarType === 'project' ? emit('start-project-chip-drag', ev, $event) : (ev.calendarType === 'event' && emit('start-event-drag', ev, $event))"
            >
              <span v-if="ev.calendarType === 'project'" class="chip-proj-tag">{{ t('calendar.project') }}</span>
              <span v-else class="chip-proj-tag chip-ev-tag">{{ t('calendar.event') }}</span>
              <span v-if="ev.calendarType === 'project'" class="bar-status-dot" :class="'bsd-' + ev.status"></span>
              {{ ev.name }}
            </div>
            <button
              v-if="lay.moreCount > 0"
              class="chip-more-btn cal-chip"
              @click.stop="emit('show-more', $event, d.iso, lay.moreItems)"
            >+{{ lay.moreCount }} {{ t('calendarUi.more') }}</button>
          </div>
        </template>
      </div>

      <div class="bars-layer">
        <template v-for="bar in weekBarsCapped(week, wi).bars" :key="bar.id">
          <div
            class="project-bar cal-chip"
            :class="{ 'bar-start': bar.startsHere, 'bar-end': bar.endsHere, 'bar-dragging': drag.active && drag.item?.id === bar.id, 'bar-hovered': hoveredBarId === bar.id, 'cal-done': bar.status === 'done' }"
            :data-bar-id="bar.id"
            @mouseenter="emit('bar-mouseenter', bar.id)"
            @mouseleave="emit('bar-mouseleave')"
            @click.stop="emit('open-project', bar)"
            @mousedown.stop="emit('start-bar-drag', bar, $event)"
            :style="{
              left: bar.startsHere ? `calc(${(bar.colStart ?? 0) / 7 * 100}% + 6px)` : ((bar.colStart ?? 0) / 7 * 100) + '%',
              right: bar.endsHere ? `calc(${(7 - (bar.colEnd ?? 0) - 1) / 7 * 100}% + 6px)` : ((7 - (bar.colEnd ?? 0) - 1) / 7 * 100) + '%',
              top: (headerHeight + (bar.row ?? 0) * barHeight) + 'px',
              background: [deadlineWarnLayer(bar), `linear-gradient(to right, ${bar.accent}50 0%, ${bar.accent}50 ${barSegFill(bar)}%, ${bar.accent}1a ${barSegFill(bar)}%, ${bar.accent}1a 100%)`].filter(Boolean).join(', '),
              borderColor: bar.accent + '70',
              color: darkenHex(bar.accent),
              cursor: bar.status === 'done' ? 'pointer' : 'grab',
            }"
          >
            <div v-if="bar.startsHere && bar.status !== 'done'" class="bar-rh bar-rh-left" @mousedown.stop.prevent="emit('start-bar-resize', bar, 'start', $event)"></div>
            <template v-if="bar.startsHere || (bar.colStart ?? 0) === 0">
              <span class="bar-proj-tag">{{ t('calendar.project') }}</span>
              <span class="bar-status-dot" :class="'bsd-' + bar.status"></span>
              <span class="bar-label">{{ bar.name }}</span>
            </template>
            <div v-if="bar.endsHere && bar.status !== 'done'" class="bar-rh bar-rh-right" @mousedown.stop.prevent="emit('start-bar-resize', bar, 'end', $event)"></div>
          </div>
        </template>
      </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { toRefs } from 'vue'
import { useI18n } from 'vue-i18n'
const { t } = useI18n()
import type { CalendarDragState } from '../composables/useCalendarDrag'
import type { CalendarMonthDay, CalendarRenderItem } from '../domain/calendarTypes'
import type { DayLayoutResult } from '../utils/calendarLayout'
import type { CalendarDateRange } from '../domain/calendarContext'

interface Props {
  weekdays: string[]
  monthWeeks: CalendarMonthDay[][]
  selectedDate: string | null
  activeRange: CalendarDateRange | null
  hoveredDateIso: string | null
  hoveredBarId: string | number | null
  drag: CalendarDragState
  headerHeight: number
  barHeight: number
  hdayType: (iso: string) => string | null
  isInActiveRange: (iso: string) => boolean
  dayLayout: (iso: string, week: CalendarMonthDay[], wi: number) => DayLayoutResult
  weekBarsCapped: (week: CalendarMonthDay[], wi: number) => { bars: CalendarRenderItem[] }
  deadlineWarnLayer: (bar: CalendarRenderItem) => string | null
  barSegFill: (bar: CalendarRenderItem) => number
  darkenHex: (color: string) => string
  setWeekRef: (el: Element | { $el?: Element } | null, wi: number) => void
}

const props = defineProps<Props>()
const {
  weekdays, monthWeeks, selectedDate, activeRange, hoveredDateIso, hoveredBarId,
  drag, headerHeight, barHeight, hdayType, isInActiveRange, dayLayout,
  weekBarsCapped, deadlineWarnLayer, barSegFill, darkenHex, setWeekRef,
} = toRefs(props)
const emit = defineEmits<{
  (event: 'week-mousemove', e: MouseEvent, week: CalendarMonthDay[]): void
  (event: 'week-mouseleave'): void
  (event: 'week-contextmenu', e: MouseEvent, week: CalendarMonthDay[]): void
  (event: 'cell-mousedown', day: CalendarMonthDay, e: MouseEvent): void
  (event: 'open-project', item: CalendarRenderItem): void
  (event: 'edit-event', item: CalendarRenderItem, e: MouseEvent): void
  (event: 'start-project-chip-drag', item: CalendarRenderItem, e: MouseEvent): void
  (event: 'start-event-drag', item: CalendarRenderItem, e: MouseEvent): void
  (event: 'show-more', e: MouseEvent, iso: string, items: CalendarRenderItem[]): void
  (event: 'start-bar-drag', item: CalendarRenderItem, e: MouseEvent): void
  (event: 'start-bar-resize', item: CalendarRenderItem, edge: 'start' | 'end', e: MouseEvent): void
  (event: 'bar-mouseenter', id: string | number): void
  (event: 'bar-mouseleave'): void
}>()
</script>

<style scoped>
.weekday-row { display: grid; grid-template-columns: repeat(7, 1fr); flex-shrink: 0; margin-bottom: 2px; }
.weekday-hdr { text-align: center; font-size: 11px; font-weight: 600; color: var(--text-secondary); padding: 3px 0 8px; border-right: 1px solid var(--calendar-grid-line); }
.weekday-hdr:last-child { border-right: none; }
.weekday-hdr.weekend { color: var(--calendar-weekend-fg); }
.month-body { flex: 1; display: flex; flex-direction: column; border-top: 1px solid var(--calendar-grid-line); overflow: hidden; }
.week-row { flex: 1; display: grid; grid-template-columns: repeat(7, 1fr); position: relative; border-bottom: 1px solid var(--calendar-grid-line); min-height: 80px; overflow: hidden; }
.week-row:last-child { border-bottom: none; }
.month-cell { padding: 7px 6px 4px; border-right: 1px solid var(--calendar-grid-line); cursor: pointer; overflow: hidden; position: relative; transition: background 0.12s ease; }
.month-cell:last-child { border-right: none; }
.month-cell::before { content: ''; position: absolute; inset: 0; z-index: 0; background: var(--calendar-cell-hover-bg); opacity: 0; transition: opacity 0.12s ease; pointer-events: none; }
.month-cell.cell-hovered::before { opacity: 1; }
.month-cell.is-weekend::before { background: var(--calendar-weekend-hover-bg); }
.month-cell > * { position: relative; z-index: 1; }
.month-cell.other-month { opacity: 0.3; }
.month-cell.is-weekend { background: var(--calendar-weekend-bg); }
.month-cell.is-today { background: var(--calendar-today-cell-bg); }
.month-cell.is-today.is-weekend { background: var(--calendar-weekend-hover-bg); }
.month-cell.is-today .cell-num { background: var(--calendar-today-date-bg); color: var(--content-on-accent); font-weight: 700; border-radius: 6px; }
.month-cell.is-today.is-weekend .cell-num { background: var(--calendar-weekend-date-bg); }
.month-cell.is-selected { background: var(--calendar-selected-cell-bg); }
.month-cell.is-selected.is-weekend { background: var(--calendar-weekend-selected-bg); }
.month-cell.is-selected:not(.is-today) .cell-num { background: var(--calendar-range-cell-bg); color: var(--color-primary); font-weight: 700; border-radius: 6px; }
.month-cell.is-selected:not(.is-today).is-weekend .cell-num { background: var(--calendar-weekend-date-bg); color: var(--calendar-weekend-fg); }
.month-cell.is-selected:not(.is-today).is-workday .cell-num { color: var(--color-primary); }
.month-cell.in-range { background: var(--calendar-range-cell-bg); }
.month-cell.in-range.is-weekend { background: var(--calendar-weekend-hover-bg); }
.month-cell.range-start, .month-cell.range-end { background: var(--calendar-range-edge-bg); }
.month-cell.range-start.is-weekend, .month-cell.range-end.is-weekend { background: var(--calendar-weekend-selected-bg); }
.month-cell.range-start .cell-num, .month-cell.range-end .cell-num { background: var(--calendar-range-edge-bg); color: var(--color-primary); font-weight: 700; border-radius: 6px; }
.month-cell.range-start.is-weekend .cell-num, .month-cell.range-end.is-weekend .cell-num { background: var(--calendar-weekend-date-bg); color: var(--calendar-weekend-fg); }
.cell-head { display: flex; align-items: center; gap: 3px; height: 24px; }
.cell-num { width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 12px; line-height: 1; color: var(--text-primary); flex-shrink: 0; }
.hday-badge { font-size: 9px; font-weight: 700; line-height: 1; padding: 2px 3px; border-radius: 3px; flex-shrink: 0; }
.hday-holiday { background: var(--status-danger-bg); color: var(--status-danger); }
.hday-workday { background: var(--status-warning-bg); color: var(--status-warning); }
.month-cell.is-holiday .cell-num { color: var(--status-danger); }
.month-cell.is-workday.is-weekend .cell-num { color: var(--text-primary); }
.cell-chips { display: flex; flex-direction: column; gap: 2px; }
.event-chip { height: 18px; box-sizing: border-box; font-size: 10px; font-weight: 500; padding: 0 7px; border-radius: 99px; border: 1px solid transparent; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: flex; align-items: center; }
.event-chip.chip-proj, .event-chip.chip-ev-click { cursor: grab; }
.chip-more-btn { height: 16px; box-sizing: border-box; font-size: 10px; font-weight: 500; padding: 0 7px; border-radius: 99px; border: 1px solid var(--action-outline); background: var(--action-soft); color: var(--action-primary); cursor: pointer; font-family: var(--font-sans); white-space: nowrap; display: flex; align-items: center; }
.bars-layer { position: absolute; inset: 0; pointer-events: none; z-index: 2; }
.project-bar { position: absolute; height: 16px; border: 1px solid transparent; display: flex; align-items: center; padding: 0 6px; font-size: 10px; font-weight: 500; white-space: nowrap; overflow: hidden; box-sizing: border-box; pointer-events: auto; cursor: grab; }
.project-bar.bar-dragging { opacity: 0.6; }
.project-bar.bar-start { border-radius: 99px 0 0 99px; padding-left: 8px; }
.project-bar.bar-end { border-radius: 0 99px 99px 0; }
.project-bar.bar-start.bar-end { border-radius: 99px; }
.bar-rh { position: absolute; top: 0; bottom: 0; width: 8px; cursor: ew-resize; display: flex; align-items: center; justify-content: center; opacity: 0; transition: opacity 0.15s; z-index: 1; }
.bar-rh::after { content: ''; width: 2px; height: 8px; border-radius: 2px; background: currentColor; opacity: 0.7; }
.bar-rh-left { left: 0; }
.bar-rh-right { right: 0; }
.project-bar.bar-hovered .bar-rh { opacity: 1; }
.bar-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
.bar-proj-tag { flex-shrink: 0; font-size: 8px; font-weight: 700; letter-spacing: 0.04em; background: var(--calendar-cap-project-bg); border-radius: 3px; padding: 0 3px; line-height: 11px; margin-right: 2px; }
.bar-status-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; margin-right: 4px; }
.bsd-pending { background: var(--status-danger); }
.bsd-active { background: var(--status-warning); }
.bsd-done { background: var(--status-success); }
.chip-proj-tag { flex-shrink: 0; font-size: 8px; font-weight: 700; letter-spacing: 0.04em; background: var(--calendar-cap-project-bg); border-radius: 3px; padding: 0 3px; line-height: 11px; margin-right: 4px; }
.chip-ev-tag { background: var(--calendar-cap-event-bg); color: var(--calendar-cap-event-fg); }
.cal-done { opacity: 0.45; }
.cal-done:hover { opacity: 0.7; }
</style>
