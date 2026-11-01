<template>
  <div class="cal-sidebar glass-card">
    <div class="sidebar-top">
      <div class="sidebar-date-label">{{ selectedDateLabel }}</div>
    </div>

    <section class="sidebar-group" :aria-label="t('calendar.project')">
      <div class="sidebar-section-head">
        <div class="sidebar-section-title">{{ t('calendar.project') }}<span v-if="selectedProjects.length" class="sidebar-note-count">{{ selectedProjects.length }}</span></div>
        <button class="add-event-btn add-proj-btn" @click="$emit('add-project')"><Icon name="action.add" :size="13" />{{ t('calendar.addProject') }}</button>
      </div>
      <div v-for="ev in selectedProjects" :key="ev.id" class="sidebar-ev" :class="{ 'cal-done': ev.status === 'done' }"
           :data-event-id="ev.id" @click.left="$emit('open-project', ev)">
        <div class="sidebar-ev-bar" :style="{ background: ev.accent }"></div>
        <div class="sidebar-ev-body">
          <div class="sidebar-ev-name" :style="{ color: darkenHex(ev.accent) }">
            {{ ev.name }}
            <span v-if="ev.status === 'done'" class="cal-done-mark"><Icon name="status.success" :size="9" /></span>
          </div>
          <div class="sidebar-ev-desc">{{ ev.startDate?.slice(5).replace('-','/') }} → {{ ev.endDate?.slice(5).replace('-','/') }}<template v-if="ev.currentStage"> · {{ ev.currentStage }}</template></div>
        </div>
      </div>
      <div v-if="!selectedProjects.length" class="sidebar-group-empty">{{ t('calendar.noProjects') }}</div>
    </section>

    <div class="sidebar-divider"></div>
    <section class="sidebar-group" :aria-label="t('calendar.event')">
      <div class="sidebar-section-head">
        <div class="sidebar-section-title">{{ t('calendar.event') }}<span v-if="selectedDayEvents.length" class="sidebar-note-count">{{ selectedDayEvents.length }}</span></div>
        <button ref="addButton" class="add-event-btn" @click="$emit('add-event', addButton)"><Icon name="action.add" :size="13" />{{ t('calendar.addEvent') }}</button>
      </div>
      <div v-for="ev in selectedDayEvents" :key="ev.id" class="sidebar-ev sidebar-event"
           :data-event-id="ev.id" @click.left="$emit('edit-event', { item: ev, event: $event })"
           @contextmenu.prevent="$emit('edit-event', { item: ev, event: $event })">
        <div class="sidebar-ev-body">
          <div class="sidebar-ev-name">
            <span v-if="ev.time" class="sidebar-ev-time" :class="{ 'has-end-time': ev.endTime }">{{ ev.time }}{{ ev.endTime ? '–' + ev.endTime : '' }}<span v-if="isNextDay(ev.time, ev.endTime)" class="nextday-mini">{{ t('calendar.nextDay') }}</span></span>
            {{ ev.name }}
          </div>
          <div class="sidebar-ev-desc"><span v-if="ev.description">{{ ev.description }}</span></div>
        </div>
        <button class="ev-del-btn" @click.stop="$emit('delete-event', ev)" :title="t('calendar.deleteEvent')"><Icon name="action.delete" :size="12" /></button>
      </div>
      <div v-if="!selectedDayEvents.length" class="sidebar-group-empty">{{ t('calendar.noEvents') }}</div>
    </section>

    <div class="sidebar-divider"></div>
    <section class="sidebar-notes" :aria-label="t('calendar.notes')">
      <div class="sidebar-section-title">{{ t('calendar.notes') }}<span v-if="selectedNotes.length" class="sidebar-note-count">{{ selectedNotes.length }}</span></div>
      <button v-for="note in selectedNotes" :key="note.id" class="sidebar-note" type="button" @click="$emit('open-note', note.id)">
        <span class="sidebar-note-title">{{ noteTitle(note) }}</span>
        <span v-if="notePreview(note)" class="sidebar-note-preview">{{ notePreview(note) }}</span>
      </button>
      <div v-if="notesLoading && !selectedNotes.length" class="sidebar-notes-empty">{{ t('calendar.notesLoading') }}</div>
      <div v-else-if="notesFailed && !selectedNotes.length" class="sidebar-notes-empty">{{ t('calendar.notesUnavailable') }}</div>
      <div v-else-if="!selectedNotes.length" class="sidebar-notes-empty">{{ t('calendar.noNotes') }}</div>
    </section>

    <div class="sidebar-divider"></div>
    <div class="sidebar-section-title">{{ t('calendar.upcoming') }}</div>
    <div v-for="ev in upcomingList" :key="ev.id" class="upcoming-item cap-row" :class="{ 'upcoming-proj': ev.calendarType === 'project', 'upcoming-ev': ev.calendarType === 'event', 'cal-done': ev.calendarType === 'project' && ev.status === 'done' }"
         :style="{ cursor: ev.calendarType ? 'pointer' : 'default' }"
         @click.left="ev.calendarType === 'project' ? $emit('open-project', ev) : (ev.calendarType === 'event' && $emit('edit-event', { item: ev, event: $event }))"
         @contextmenu.prevent="ev.calendarType === 'event' && $emit('edit-event', { item: ev, event: $event })">
      <div class="cap-capsule" :style="{ '--cap-bg': capBg(ev.accent, ev.progress), borderColor: hexAlpha(ev.accent, 0.3) }">
        <span class="cap-tag" :class="ev.calendarType === 'project' ? 'cap-tag-proj' : 'cap-tag-ev'" :style="ev.calendarType === 'project' ? { color: darkenHex(ev.accent) } : {}">{{ ev.calendarType === 'project' ? t('calendar.project') : t('calendar.event') }}</span>
        <span v-if="ev.calendarType === 'project'" class="cap-sdot" :class="'cap-s-' + ev.status"></span>
        <span class="cap-name" :style="{ color: darkenHex(ev.accent) }">{{ ev.name }}<span v-if="ev.calendarType === 'project' && ev.status === 'done'" class="cal-done-mark"><Icon name="status.success" :size="9" /></span></span>
        <span v-if="ev.status !== 'done'" class="cap-days" :class="{ urgent: (ev.daysLeft ?? 0) <= 3 }">{{ ev.daysLabel }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/common/icons/Icon.vue'
import { isNextDay } from '@/composables/calendar/useEventEditForm'
import { capBg, hexAlpha, darkenHex } from '@/utils/calendarColors'
import type { MindNote } from '@/services/api'
import type { CalendarRenderItem } from '../domain/calendarTypes'

const props = defineProps<{
  selectedDateLabel: string
  selectedEvents: CalendarRenderItem[]
  selectedNotes: MindNote[]
  notesLoading: boolean
  notesFailed: boolean
  upcomingList: CalendarRenderItem[]
}>()

defineEmits<{
  'add-project': []
  'add-event': [anchor: HTMLElement | null]
  'open-project': [item: CalendarRenderItem]
  'edit-event': [payload: { item: CalendarRenderItem; event: MouseEvent }]
  'delete-event': [item: CalendarRenderItem]
  'open-note': [id: number]
}>()

const addButton = ref<HTMLElement | null>(null)
const { t } = useI18n()
const selectedProjects = computed(() => props.selectedEvents.filter(item => item.calendarType === 'project'))
const selectedDayEvents = computed(() => props.selectedEvents.filter(item => item.calendarType === 'event'))

function noteTitle(note: MindNote) {
  if (note.title?.trim()) return note.title.trim()
  const firstLine = note.contentMd.split(/\r?\n/).find(line => line.trim()) ?? ''
  return firstLine.replace(/^\s{0,3}#{1,6}\s+/, '').replace(/[*_`~]/g, '').trim() || t('calendar.untitledNote')
}

function notePreview(note: MindNote) {
  return note.contentMd
    .replace(/\[\[[a-z_]+:\d+\|([^\]]*)\]\]/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
}
</script>

<style scoped>
.cal-done { opacity: 0.45; }
.cal-done:hover { opacity: 0.7; }
.cal-done-mark { display: inline-flex; vertical-align: middle; margin-left: 3px; color: #6f7098; }
.cal-sidebar { padding: 16px; display: flex; flex-direction: column; gap: 0; overflow-y: auto; min-height: 0; scrollbar-gutter: auto; }
.sidebar-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.sidebar-date-label { font-size: 13px; font-weight: 700; color: var(--text-primary); }
.add-event-btn { display: flex; align-items: center; gap: 5px; padding: 5px 10px; border-radius: 8px; border: 1px solid rgba(123,127,178,0.3); background: rgba(123,127,178,0.08); font-size: 11px; font-weight: 600; cursor: pointer; color: var(--color-primary); font-family: var(--font-sans); transition: all 0.15s; }
.add-event-btn:hover { background: rgba(123,127,178,0.15); border-color: rgba(123,127,178,0.5); }
.add-proj-btn { background: var(--action-primary-bg); border-color: transparent; color: var(--content-on-accent); box-shadow: none; }
.add-proj-btn:hover { background: var(--action-primary-bg-hover); border-color: transparent; opacity: 1; box-shadow: none; }
.sidebar-group { display: flex; flex-direction: column; gap: 7px; }
.sidebar-section-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 1px; }
.sidebar-section-head .sidebar-section-title { margin-bottom: 0; }
.sidebar-group-empty { padding: 2px 0; color: var(--text-secondary); font-size: 11px; }
.sidebar-ev { display: flex; gap: 9px; align-items: flex-start; background: rgba(255,255,255,0.66); border: 1px solid rgba(255,255,255,0.88); border-radius: 10px; padding: 8px 10px; cursor: pointer; transition: box-shadow 0.25s ease; }
.sidebar-ev:hover { box-shadow: inset 0 0 0 100px rgba(255,255,255,0.2), 0 3px 10px rgba(0,0,0,0.10); }
.sidebar-ev-body { flex: 1; min-width: 0; }
.sidebar-ev-bar { width: 3px; border-radius: 99px; align-self: stretch; flex-shrink: 0; min-height: 26px; }
.sidebar-ev-name { font-size: 12px; font-weight: 500; color: var(--text-primary); line-height: 1.4; overflow-wrap: break-word; word-break: break-word; }
.sidebar-ev-time { display: inline-block; font-size: 11px; font-weight: 600; color: var(--action-primary); margin-left: 7px; margin-right: 4px; font-variant-numeric: tabular-nums; }
.sidebar-ev-time.has-end-time { min-width: 11ch; }
.ev-type-badge { display: inline-block; vertical-align: middle; margin-left: 4px; font-size: 9px; font-weight: 700; letter-spacing: 0.04em; padding: 1px 5px; border-radius: 4px; line-height: 1.5; white-space: nowrap; }
.ev-proj-badge { background: rgba(123,127,178,0.12); color: #7b7fb2; border: 1px solid rgba(123,127,178,0.2); }
.ev-event-badge { background: rgba(210,175,40,0.15); color: #a07c00; border: 1px solid rgba(210,175,40,0.4); }
.sidebar-ev-desc { font-size: 11px; color: var(--text-secondary); margin-top: 3px; line-height: 1.4; display: flex; align-items: flex-start; gap: 4px; }
.sidebar-ev-desc > span { min-width: 0; overflow-wrap: anywhere; word-break: break-word; }
.sidebar-empty { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 18px 0; color: var(--text-secondary); font-size: 12px; opacity: 0.55; }
.sidebar-divider { flex: 0 0 1px; height: 1px; background: rgba(0,0,0,0.06); margin: 14px 0; }
.sidebar-section-title { font-size: 10px; font-weight: 600; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.07em; margin-bottom: 10px; }
.sidebar-notes { display: flex; flex-direction: column; gap: 7px; }
.sidebar-note-count { margin-left: 6px; color: var(--text-tertiary, var(--text-secondary)); font-variant-numeric: tabular-nums; }
.sidebar-note { display: flex; flex-direction: column; gap: 4px; min-width: 0; padding: 9px 10px; border: 1px solid var(--border-subtle); border-radius: 10px; background: var(--control-bg); color: var(--text-primary); text-align: left; cursor: pointer; transition: background 0.15s, border-color 0.15s, transform 0.15s; }
.sidebar-note:hover { border-color: var(--border-focus); transform: translateY(-1px); }
.sidebar-note-title { overflow: hidden; font-size: 12px; font-weight: 600; line-height: 1.45; text-overflow: ellipsis; white-space: nowrap; }
.sidebar-note-preview { display: -webkit-box; overflow: hidden; color: var(--text-secondary); font-size: 11px; line-height: 1.4; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow-wrap: anywhere; }
.sidebar-notes-empty { padding: 2px 0; color: var(--text-secondary); font-size: 11px; }
.upcoming-item { display: flex; align-items: center; margin-bottom: 7px; }
.upcoming-item:last-child { margin-bottom: 0; }
.ev-del-btn { background: rgba(176,120,88,0.08); border: 1px solid rgba(176,120,88,0.3); cursor: pointer; flex-shrink: 0; color: #b07858; padding: 4px; display: flex; align-items: center; align-self: center; border-radius: 6px; margin-left: auto; transition: background 0.15s, transform 0.15s; }
.ev-del-btn:hover { background: rgba(176,120,88,0.15); border-color: rgba(176,120,88,0.5); transform: scale(1.1); }
</style>
