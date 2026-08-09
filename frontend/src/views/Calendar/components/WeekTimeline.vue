<template>
  <div class="week-view">
    <div class="wv-head">
      <div class="wv-gutter"></div>
      <div v-for="d in weekDays" :key="d.iso" class="wv-dhead" :class="{ today: d.isToday, weekend: d.isWeekend, selected: isDaySelected(d.iso) }"
           @mousedown="emit('all-day-down', $event)" @contextmenu.prevent="emit('all-day-contextmenu', $event)">
        <span class="wv-dow">周{{ d.cn }}</span>
        <span class="wv-dnum" :class="{ today: d.isToday }">{{ d.dateNum }}</span>
      </div>
    </div>

    <div class="wv-allday">
      <div class="wv-gutter wv-allday-tag">全天</div>
      <div class="wv-allday-grid" :ref="setAllDayGridRef" :style="{ height: wvAllDayH + 'px' }"
           @mousedown="emit('all-day-down', $event)" @mousemove="emit('all-day-hover', $event)" @mouseleave="emit('all-day-leave')" @contextmenu.prevent="emit('all-day-contextmenu', $event)">
        <div v-for="(d, ci) in weekDays" :key="d.iso" class="wv-aco" :class="{ today: d.isToday, weekend: d.isWeekend }" :style="{ left: ci / 7 * 100 + '%' }"></div>
        <TransitionGroup name="cal-fade">
          <div v-for="ci in wvSelCols" :key="'adsel' + ci" class="wv-ad-sel" :class="{ weekend: weekDays[ci]?.isWeekend }" :style="{ left: ci / 7 * 100 + '%' }"></div>
        </TransitionGroup>
        <Transition name="cal-fade">
          <div v-if="wvAdHover >= 0 && !rangeSelectActive" :key="'adhov' + wvAdHover" class="wv-ad-hover" :class="{ weekend: weekDays[wvAdHover]?.isWeekend }" :style="{ left: wvAdHover / 7 * 100 + '%' }"></div>
        </Transition>
        <div v-for="bar in weekAllDayShown" :key="bar.id" class="wv-pbar cal-chip"
             :class="{ 'cal-done': bar.status === 'done', 'bar-start': bar.startsHere, 'bar-end': bar.endsHere }"
             :style="pbarStyle(bar)" @click.stop="emit('open-project', bar)" :title="bar.name">
          <span class="bar-proj-tag">项目</span>
          <span class="bar-status-dot" :class="'bsd-' + bar.status"></span>{{ bar.name }}
        </div>
        <template v-for="(d, ci) in weekDays" :key="'it' + d.iso">
          <div v-for="(it, ii) in allDayItemsFor(d.iso)" :key="it.calendarType === 'project' ? it.id : it._uid"
               class="wv-allday-ev cal-chip" :class="{ 'cal-done': it.calendarType === 'project' && it.status === 'done' }"
               :style="{ left: `calc(${ci / 7 * 100}% + 6px)`, right: `calc(${(6 - ci) / 7 * 100}% + 6px)`, top: ((wvShownRows + ii) * 20) + 'px', background: it.calendarType === 'project' ? capBg(it.accent, it.progress) : it.accent + '28', color: darkenHex(it.accent), borderColor: it.accent + '70' }"
               @click.stop="it.calendarType === 'project' ? emit('open-project', it) : emit('edit-event', it, $event)" :title="it.name">
            <span class="chip-proj-tag" :class="{ 'chip-ev-tag': it.calendarType !== 'project' }">{{ it.calendarType === 'project' ? '项目' : '活动' }}</span>
            <span v-if="it.calendarType === 'project'" class="bar-status-dot" :class="'bsd-' + it.status"></span>{{ it.name }}
          </div>
          <button v-if="weekMoreFor(ci).length" class="chip-more-btn cal-chip wv-more"
                  :style="{ left: `calc(${ci / 7 * 100}% + 6px)`, right: `calc(${(6 - ci) / 7 * 100}% + 6px)`, top: ((wvShownRows + allDayItemsFor(d.iso).length) * 20) + 'px' }"
                  @click.stop="emit('show-more', $event, d.iso, weekMoreFor(ci))">+{{ weekMoreFor(ci).length }} 更多</button>
        </template>
      </div>
    </div>

    <div class="wv-body">
      <div class="wv-grid" :style="{ height: 24 * hourHeight + 'px' }">
        <div class="wv-hours">
          <div v-for="h in 24" :key="h" class="wv-hour" :style="{ height: hourHeight + 'px' }">
            <span v-if="h > 1">{{ h - 1 }}:00</span>
          </div>
        </div>
        <div v-for="d in weekDays" :key="d.iso" class="wv-col" :class="{ today: d.isToday, weekend: d.isWeekend }"
             :style="{ backgroundSize: '100% ' + hourHeight + 'px' }"
             @mousedown="emit('column-down', $event, d)" @mousemove="emit('column-move', $event, d)" @mouseleave="emit('column-leave')"
             @contextmenu.prevent="emit('column-contextmenu', $event, d)">
          <Transition name="cal-fade">
            <div v-if="selectedSlot && selectedSlot.iso === d.iso" :key="'sel' + selectedSlot.h0" class="wv-selected" :style="{ top: Math.min(selectedSlot.h0, selectedSlot.h1) * hourHeight + 'px', height: (Math.abs(selectedSlot.h1 - selectedSlot.h0) + 1) * hourHeight + 'px' }"></div>
          </Transition>
          <Transition name="cal-fade">
            <div v-if="hover && hover.iso === d.iso && !dragging" class="wv-hover" :style="{ top: hover.h * hourHeight + 'px', height: hourHeight + 'px' }"></div>
          </Transition>
          <div v-if="d.isToday" class="wv-now" :style="{ top: nowTop + 'px' }"></div>
          <div v-for="b in timedLayoutFor(d.iso)" :key="b.ev._uid" class="wv-ev cal-chip"
               :style="{ top: b.top + 'px', height: b.height + 'px', left: 'calc(' + b.leftPct + '% + 1px)', width: 'calc(' + b.widthPct + '% - 2px)', background: b.ev.accent + '2e', borderColor: b.ev.accent + '85', color: darkenHex(b.ev.accent) }"
               @mousedown.stop="emit('event-down', b.ev, $event)" @mousemove="emit('event-hover', $event)" :title="b.ev.name">
            <span class="wv-ev-t">{{ b.ev.time }}{{ b.ev.endTime ? '–' + b.ev.endTime : '' }}</span>
            <span class="wv-ev-n"><span class="chip-proj-tag chip-ev-tag">活动</span>{{ b.ev.name }}</span>
            <span v-if="b.ev.description" class="wv-ev-d">{{ b.ev.description }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { toRefs } from 'vue'
import type { CalendarHourHover, CalendarRenderItem, CalendarTimeSelection, CalendarWeekDay } from '../domain/calendarTypes'
import type { TimedLayoutItem } from '../utils/calendarLayout'

interface Props {
  weekDays: CalendarWeekDay[]
  rangeSelectActive: boolean
  wvAllDayH: number
  wvSelCols: number[]
  wvAdHover: number
  weekAllDayShown: CalendarRenderItem[]
  wvShownRows: number
  allDayItemsFor: (iso: string) => CalendarRenderItem[]
  weekMoreFor: (ci: number) => CalendarRenderItem[]
  pbarStyle: (bar: CalendarRenderItem) => Record<string, string>
  capBg: (accent: string, progress?: number) => string
  darkenHex: (color: string) => string
  setAllDayGridRef: (el: Element | { $el?: Element } | null) => void
  hourHeight: number
  selectedSlot: CalendarTimeSelection | null
  hover: CalendarHourHover | null
  dragging: boolean
  nowTop: number
  timedLayoutFor: (iso: string) => TimedLayoutItem[]
  isDaySelected: (iso: string) => boolean
}

const props = defineProps<Props>()
const {
  weekDays, rangeSelectActive, wvAllDayH, wvSelCols, wvAdHover, weekAllDayShown,
  wvShownRows, allDayItemsFor, weekMoreFor, pbarStyle, capBg, darkenHex,
  setAllDayGridRef, hourHeight, selectedSlot, hover, dragging, nowTop, timedLayoutFor,
  isDaySelected,
} = toRefs(props)
const emit = defineEmits<{
  (event: 'all-day-down', e: MouseEvent): void
  (event: 'all-day-hover', e: MouseEvent): void
  (event: 'all-day-leave'): void
  (event: 'all-day-contextmenu', e: MouseEvent): void
  (event: 'open-project', item: CalendarRenderItem): void
  (event: 'edit-event', item: CalendarRenderItem, e: MouseEvent): void
  (event: 'show-more', e: MouseEvent, iso: string, items: CalendarRenderItem[]): void
  (event: 'column-down', e: MouseEvent, day: CalendarWeekDay): void
  (event: 'column-move', e: MouseEvent, day: CalendarWeekDay): void
  (event: 'column-leave'): void
  (event: 'column-contextmenu', e: MouseEvent, day: CalendarWeekDay): void
  (event: 'event-down', item: CalendarRenderItem, e: MouseEvent): void
  (event: 'event-hover', e: MouseEvent): void
}>()
</script>

<style scoped>
.week-view { display: flex; flex-direction: column; flex: 1; min-height: 0; user-select: none; -webkit-user-select: none; }
.wv-gutter { width: 46px; flex: none; }
.wv-head { display: flex; border-bottom: 1px solid rgba(123,127,178,0.18); padding-bottom: 4px; }
.wv-dhead { flex: 1; position: relative; display: flex; flex-direction: column; align-items: center; gap: 1px; padding: 7px 0; cursor: pointer; }
.wv-dhead > span { position: relative; z-index: 1; }
.wv-dhead::before, .wv-dhead::after { content: ''; position: absolute; inset: 2px 4px; border-radius: 7px; opacity: 0; transition: opacity 0.12s; pointer-events: none; }
.wv-dhead::before { background: rgba(123,127,178,0.10); }
.wv-dhead::after { background: rgba(123,127,178,0.06); }
.wv-dhead.selected::before { opacity: 1; }
.wv-dhead:hover::after { opacity: 1; }
.wv-dhead.weekend::before { background: rgba(195,90,90,0.09); }
.wv-dhead.weekend::after { background: rgba(195,90,90,0.06); }
.wv-dhead.weekend .wv-dow { color: #b06a78; }
.wv-dow { font-size: 11px; font-weight: 600; color: #8a8fa8; }
.wv-dnum { width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; border-radius: 50%; font-size: 15px; font-weight: 600; color: #3a3d52; line-height: 1; }
.wv-dnum.today { background: linear-gradient(135deg,#7b7fb2,#9590c4); color: rgba(255,255,255,0.88); font-weight: 700; border-radius: 6px; }
.wv-dhead.weekend .wv-dnum.today { background: linear-gradient(135deg,#b85c5c,#c97070); }
.wv-dhead.selected .wv-dnum:not(.today) { color: var(--color-primary); }
.wv-dhead.selected.weekend .wv-dnum:not(.today) { color: rgba(195,90,90,0.9); }
.wv-allday { display: flex; align-items: stretch; border-bottom: 1px solid rgba(123,127,178,0.18); }
.wv-allday-tag { display: flex; align-items: flex-start; justify-content: flex-end; padding: 4px 6px 0 0; font-size: 10px; color: #a8acc4; }
.wv-allday-grid { position: relative; flex: 1; min-height: 26px; overflow: hidden; }
.wv-aco { position: absolute; top: 0; bottom: 0; width: 14.2857%; box-sizing: border-box; border-left: 1px solid rgba(123,127,178,0.1); pointer-events: none; }
.wv-aco.today { background: rgba(123,127,178,0.06); }
.wv-aco.weekend { background: rgba(195,90,90,0.028); }
.wv-ad-sel { position: absolute; top: 0; bottom: 0; width: 14.2857%; background: rgba(123,127,178,0.08); pointer-events: none; z-index: 0; }
.wv-ad-sel.weekend { background: rgba(195,90,90,0.07); }
.wv-ad-hover { position: absolute; top: 0; bottom: 0; width: 14.2857%; background: rgba(123,127,178,0.06); pointer-events: none; z-index: 0; }
.wv-ad-hover.weekend { background: rgba(195,90,90,0.06); }
.wv-pbar, .wv-allday-ev { position: absolute; height: 18px; box-sizing: border-box; display: flex; align-items: center; gap: 3px; padding: 0 6px; border: 1px solid; font-size: 11px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; z-index: 1; }
.wv-allday-ev { padding-right: 8px; border-radius: 99px; }
.wv-pbar.bar-start { border-radius: 99px 0 0 99px; }
.wv-pbar.bar-end { border-radius: 0 99px 99px 0; }
.wv-pbar.bar-start.bar-end { border-radius: 99px; }
.wv-more { position: absolute; box-sizing: border-box; overflow: hidden; z-index: 1; }
.wv-body { flex: 1; overflow-y: auto; min-height: 0; scrollbar-gutter: stable; }
.wv-grid { display: flex; position: relative; }
.wv-hours { width: 46px; flex: none; }
.wv-hour { position: relative; }
.wv-hour span { position: absolute; top: -7px; right: 6px; font-size: 10px; color: #a8acc4; font-variant-numeric: tabular-nums; }
.wv-col { flex: 1; position: relative; border-left: 1px solid rgba(123,127,178,0.1); background-image: linear-gradient(to bottom, rgba(123,127,178,0.13) 1px, transparent 1px); background-repeat: repeat-y; cursor: pointer; }
.wv-col.today { background-color: rgba(123,127,178,0.045); }
.wv-col.weekend { background-color: rgba(195,90,90,0.028); }
.wv-hover { position: absolute; left: 0; right: 0; background: rgba(123,127,178,0.06); pointer-events: none; z-index: 2; }
.wv-col.weekend .wv-hover { background: rgba(195,90,90,0.07); }
.cal-fade-enter-active, .cal-fade-leave-active { transition: opacity 0.12s ease; }
.cal-fade-enter-from, .cal-fade-leave-to { opacity: 0; }
.wv-selected { position: absolute; left: 0; right: 0; background: rgba(123,127,178,0.1); pointer-events: none; z-index: 1; }
.wv-col.weekend .wv-selected { background: rgba(195,90,90,0.1); }
.wv-now { position: absolute; left: 0; right: 0; height: 0; border-top: 2px solid #e5484d; z-index: 6; pointer-events: none; }
.wv-now::before { content: ''; position: absolute; left: -3px; top: -4px; width: 7px; height: 7px; border-radius: 50%; background: #e5484d; }
.wv-ev { position: absolute; box-sizing: border-box; border: 1px solid; border-radius: 6px; padding: 1px 5px; overflow: hidden; cursor: pointer; display: flex; flex-direction: column; line-height: 1.25; z-index: 3; }
.wv-ev.cal-chip:hover { z-index: 5; }
.wv-ev-t, .wv-ev-n, .wv-ev-d { position: relative; z-index: 1; }
.wv-ev-d { font-size: 10px; font-weight: 400; opacity: 0.78; line-height: 1.3; margin-top: 1px; overflow: hidden; min-height: 0; flex: 1; word-break: break-word; }
.wv-ev { cursor: grab; }
.wv-ev:active { cursor: grabbing; }
.wv-ev-t { font-size: 9.5px; font-weight: 600; opacity: 0.85; white-space: nowrap; }
.wv-ev-n { font-size: 11px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chip-more-btn { height: 16px; box-sizing: border-box; font-size: 10px; font-weight: 500; padding: 0 7px; border-radius: 99px; border: 1px solid rgba(123,127,178,0.35); background: rgba(123,127,178,0.1); color: rgb(101,104,146); cursor: pointer; font-family: var(--font-sans); white-space: nowrap; display: flex; align-items: center; }
.bar-proj-tag { flex-shrink: 0; font-size: 8px; font-weight: 700; letter-spacing: 0.04em; background: rgba(255,255,255,0.5); border-radius: 3px; padding: 0 3px; line-height: 11px; margin-right: 2px; }
.bar-status-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; margin-right: 4px; }
.bsd-pending { background: #d46b6b; }
.bsd-active { background: #c9943a; }
.bsd-done { background: #5a9e88; }
.chip-proj-tag { flex-shrink: 0; font-size: 8px; font-weight: 700; letter-spacing: 0.04em; background: rgba(255,255,255,0.55); border-radius: 3px; padding: 0 3px; line-height: 11px; margin-right: 4px; }
.chip-ev-tag { background: rgba(210,175,40,0.28); color: #7a5c00; }
.cal-done { opacity: 0.45; }
.cal-done:hover { opacity: 0.7; }
</style>
