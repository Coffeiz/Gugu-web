<template>
  <div class="cal-sidebar glass-card">
    <div class="sidebar-top">
      <div class="sidebar-date-label">{{ selectedDateLabel }}</div>
      <button v-if="hasActiveRange" class="add-event-btn add-proj-btn" @click="$emit('add-project')"><PhPlus :size="13" weight="bold" />添加项目</button>
      <button v-else ref="addButton" class="add-event-btn" @click="$emit('add-event', addButton)"><PhPlus :size="13" weight="bold" />添加活动</button>
    </div>

    <div v-if="selectedEvents.length" class="sidebar-events">
      <div v-for="ev in selectedEvents" :key="ev.id" class="sidebar-ev" :class="{ 'cal-done': ev.calendarType === 'project' && ev.status === 'done' }"
           :data-event-id="ev.id" :style="{ cursor: ev.calendarType ? 'pointer' : 'default' }"
           @click.left="ev.calendarType === 'project' ? $emit('open-project', ev) : (ev.calendarType === 'event' && $emit('edit-event', { item: ev, event: $event }))"
           @contextmenu.prevent="ev.calendarType === 'event' && $emit('edit-event', { item: ev, event: $event })">
        <div class="sidebar-ev-bar" :style="{ background: ev.accent }"></div>
        <div class="sidebar-ev-body">
          <div class="sidebar-ev-name" :style="ev.calendarType === 'project' ? { color: darkenHex(ev.accent) } : {}">
            <span v-if="ev.calendarType === 'project'" class="ev-type-badge ev-proj-badge" :style="{ color: darkenHex(ev.accent) }">项目</span>
            <span v-else class="ev-type-badge ev-event-badge">{{ typeLabel(ev.type) }}</span>
            <span v-if="ev.time" class="sidebar-ev-time" :class="{ 'has-end-time': ev.endTime }">{{ ev.time }}{{ ev.endTime ? '–' + ev.endTime : '' }}<span v-if="isNextDay(ev.time, ev.endTime)" class="nextday-mini">次日</span></span>
            {{ ev.name }}
            <span v-if="ev.calendarType === 'project' && ev.status === 'done'" class="cal-done-mark"><PhCheck :size="9" weight="bold" /></span>
          </div>
          <template v-if="ev.calendarType === 'event'">
            <div class="sidebar-ev-desc"><PhAlignLeft :size="11" weight="bold" style="flex-shrink:0;opacity:0.38;margin-top:1px" /><span v-if="ev.description">{{ ev.description }}</span></div>
          </template>
          <template v-else>
            <div class="sidebar-ev-desc">{{ ev.startDate?.slice(5).replace('-','/') }} → {{ ev.endDate?.slice(5).replace('-','/') }}<template v-if="ev.currentStage"> · {{ ev.currentStage }}</template></div>
          </template>
        </div>
        <button v-if="ev.calendarType === 'event'" class="ev-del-btn" @click.stop="$emit('delete-event', ev)" title="删除活动"><PhTrash :size="12" weight="bold" /></button>
      </div>
    </div>
    <div v-else class="sidebar-empty"><PhCalendarBlank :size="26" weight="bold" style="opacity:0.3" /><span>当天无日程</span></div>

    <div class="sidebar-divider"></div>
    <div class="sidebar-section-title">近期节点</div>
    <div v-for="ev in upcomingList" :key="ev.id" class="upcoming-item cap-row" :class="{ 'upcoming-proj': ev.calendarType === 'project', 'upcoming-ev': ev.calendarType === 'event', 'cal-done': ev.calendarType === 'project' && ev.status === 'done' }"
         :style="{ cursor: ev.calendarType ? 'pointer' : 'default' }"
         @click.left="ev.calendarType === 'project' ? $emit('open-project', ev) : (ev.calendarType === 'event' && $emit('edit-event', { item: ev, event: $event }))"
         @contextmenu.prevent="ev.calendarType === 'event' && $emit('edit-event', { item: ev, event: $event })">
      <div class="cap-capsule" :style="{ '--cap-bg': capBg(ev.accent, ev.progress), borderColor: hexAlpha(ev.accent, 0.3) }">
        <span class="cap-tag" :class="ev.calendarType === 'project' ? 'cap-tag-proj' : 'cap-tag-ev'" :style="ev.calendarType === 'project' ? { color: darkenHex(ev.accent) } : {}">{{ ev.calendarType === 'project' ? '项目' : '活动' }}</span>
        <span v-if="ev.calendarType === 'project'" class="cap-sdot" :class="'cap-s-' + ev.status"></span>
        <span class="cap-name" :style="{ color: darkenHex(ev.accent) }">{{ ev.name }}<span v-if="ev.calendarType === 'project' && ev.status === 'done'" class="cal-done-mark"><PhCheck :size="9" weight="bold" /></span></span>
        <span v-if="ev.status !== 'done'" class="cap-days" :class="{ urgent: (ev.daysLeft ?? 0) <= 3 }">{{ ev.daysLabel }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { PhPlus, PhAlignLeft, PhTrash, PhCalendarBlank, PhCheck } from '@phosphor-icons/vue'
import { isNextDay } from '@/composables/useEventEditForm'
import { capBg, hexAlpha, darkenHex } from '../utils/calendarColors'
import { typeLabel } from '../domain/calendarRules'
import type { CalendarRenderItem } from '../domain/calendarTypes'

defineProps<{
  selectedDateLabel: string
  hasActiveRange: boolean
  selectedEvents: CalendarRenderItem[]
  upcomingList: CalendarRenderItem[]
}>()

defineEmits<{
  'add-project': []
  'add-event': [anchor: HTMLElement | null]
  'open-project': [item: CalendarRenderItem]
  'edit-event': [payload: { item: CalendarRenderItem; event: MouseEvent }]
  'delete-event': [item: CalendarRenderItem]
}>()

const addButton = ref<HTMLElement | null>(null)
</script>

<style>
.cal-done { opacity: 0.45; }
.cal-done:hover { opacity: 0.7; }
.cal-done-mark { display: inline-flex; vertical-align: middle; margin-left: 3px; color: #6f7098; }
.cal-sidebar { padding: 16px; display: flex; flex-direction: column; gap: 0; overflow-y: auto; min-height: 0; scrollbar-gutter: stable; }
.sidebar-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.sidebar-date-label { font-size: 13px; font-weight: 700; color: var(--text-primary); }
.add-event-btn { display: flex; align-items: center; gap: 5px; padding: 5px 10px; border-radius: 8px; border: 1px solid rgba(123,127,178,0.3); background: rgba(123,127,178,0.08); font-size: 11px; font-weight: 600; cursor: pointer; color: var(--color-primary); font-family: var(--font-sans); transition: all 0.15s; }
.add-event-btn:hover { background: rgba(123,127,178,0.15); border-color: rgba(123,127,178,0.5); }
.add-proj-btn { background: linear-gradient(135deg,#7b7fb2,#9590c4); border-color: transparent; color: #fff; box-shadow: 0 3px 12px rgba(123,127,178,0.3); }
.add-proj-btn:hover { background: linear-gradient(135deg,#7b7fb2,#9590c4); border-color: transparent; opacity: 0.92; box-shadow: 0 6px 18px rgba(123,127,178,0.4); }
.sidebar-events { display: flex; flex-direction: column; gap: 7px; margin-bottom: 4px; }
.sidebar-ev { display: flex; gap: 9px; align-items: flex-start; background: rgba(255,255,255,0.66); border: 1px solid rgba(255,255,255,0.88); border-radius: 10px; padding: 8px 10px; transition: box-shadow 0.25s ease; }
.sidebar-ev:hover { box-shadow: inset 0 0 0 100px rgba(255,255,255,0.2), 0 3px 10px rgba(0,0,0,0.10); }
.sidebar-ev-body { flex: 1; min-width: 0; }
.sidebar-ev-bar { width: 3px; border-radius: 99px; align-self: stretch; flex-shrink: 0; min-height: 26px; }
.sidebar-ev-name { font-size: 12px; font-weight: 500; color: var(--text-primary); line-height: 1.4; overflow-wrap: break-word; word-break: break-word; }
.sidebar-ev-time { display: inline-block; font-size: 11px; font-weight: 600; color: var(--accent, #7b7fb2); margin-left: 7px; margin-right: 4px; font-variant-numeric: tabular-nums; }
.sidebar-ev-time.has-end-time { min-width: 11ch; }
.ev-type-badge { display: inline-block; vertical-align: middle; margin-left: 4px; font-size: 9px; font-weight: 700; letter-spacing: 0.04em; padding: 1px 5px; border-radius: 4px; line-height: 1.5; white-space: nowrap; }
.ev-proj-badge { background: rgba(123,127,178,0.12); color: #7b7fb2; border: 1px solid rgba(123,127,178,0.2); }
.ev-event-badge { background: rgba(210,175,40,0.15); color: #a07c00; border: 1px solid rgba(210,175,40,0.4); }
.sidebar-ev-desc { font-size: 11px; color: var(--text-secondary); margin-top: 3px; line-height: 1.4; display: flex; align-items: flex-start; gap: 4px; }
.sidebar-empty { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 18px 0; color: var(--text-secondary); font-size: 12px; opacity: 0.55; }
.sidebar-divider { height: 1px; background: rgba(0,0,0,0.06); margin: 14px 0; }
.sidebar-section-title { font-size: 10px; font-weight: 600; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.07em; margin-bottom: 10px; }
.upcoming-item { display: flex; align-items: center; margin-bottom: 7px; }
.upcoming-item:last-child { margin-bottom: 0; }
.ev-del-btn { background: rgba(176,120,88,0.08); border: 1px solid rgba(176,120,88,0.3); cursor: pointer; flex-shrink: 0; color: #b07858; padding: 4px; display: flex; align-items: center; align-self: center; border-radius: 6px; margin-left: auto; transition: background 0.15s, transform 0.15s; }
.ev-del-btn:hover { background: rgba(176,120,88,0.15); border-color: rgba(176,120,88,0.5); transform: scale(1.1); }
</style>
