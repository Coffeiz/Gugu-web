<template>
  <div class="cal-toolbar glass-card">
    <GlassBg />
    <div class="toolbar-left">
      <button class="nav-btn" @click="$emit('prev')"><Icon name="action.back" :size="14" /></button>
      <button ref="periodButton" class="period-btn" @click="$emit('toggle-picker', periodButton)">
        <span>{{ periodLabel }}</span>
        <FlipChevron :open="pickerOpen" :size="11" aria-hidden="true" />
      </button>
      <button class="nav-btn" @click="$emit('next')"><Icon name="action.next" :size="14" /></button>
    </div>
    <div class="toolbar-right">
      <SegmentedControl class="view-toggle" :active-index="viewMode === 'month' ? 0 : 1" style="--pill-radius: 7px">
        <button :class="{ on: viewMode === 'month' }" @click="$emit('set-view', 'month')">{{ t('calendar.month') }}</button>
        <button :class="{ on: viewMode === 'week' }" @click="$emit('set-view', 'week')">{{ t('calendar.week') }}</button>
      </SegmentedControl>
      <button class="today-btn" @click="$emit('today')">{{ t('calendar.today') }}</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import GlassBg from '@/components/common/layout/GlassBg.vue'
import SegmentedControl from '@/components/common/controls/SegmentedControl.vue'
import Icon from '@/components/common/icons/Icon.vue'
import FlipChevron from '@/components/common/controls/FlipChevron.vue'
defineProps<{ periodLabel: string; viewMode: 'month' | 'week'; pickerOpen: boolean }>()
defineEmits<{
  prev: []
  next: []
  today: []
  'toggle-picker': [anchor: HTMLElement | null]
  'set-view': [mode: 'month' | 'week']
}>()

const periodButton = ref<HTMLElement | null>(null)
const { t } = useI18n()
</script>

<style>
.cal-toolbar { --gb-tint: var(--glass-bg); display: flex; align-items: center; justify-content: space-between; height: 52px; box-sizing: border-box; padding: 0 18px; flex-shrink: 0; position: relative; isolation: isolate; background: transparent; overflow: hidden; backdrop-filter: none; -webkit-backdrop-filter: none; }
.cal-toolbar:hover { --gb-tint: var(--glass-bg-hover); background: transparent; box-shadow: var(--glass-shadow-lg); }
.cal-toolbar .toolbar-left { display: flex; align-items: center; gap: 4px; }
.cal-toolbar .nav-btn { width: 30px; height: 30px; border-radius: 8px; border: none; background: none; cursor: pointer; display: flex; align-items: center; justify-content: center; color: var(--text-secondary); transition: background 0.15s; }
.cal-toolbar .nav-btn:hover { background: rgba(0,0,0,0.06); }
.cal-toolbar .period-btn { display: flex; align-items: center; gap: 5px; font-size: 15px; font-weight: 700; color: var(--text-primary); min-width: 130px; justify-content: center; padding: 4px 10px; border-radius: 9px; border: none; background: none; cursor: pointer; font-family: var(--font-sans); transition: background 0.15s; }
.cal-toolbar .period-btn:hover { background: rgba(0,0,0,0.06); }
.cal-toolbar .today-btn { padding: 5px 14px; border-radius: 8px; border: 1px solid rgba(0,0,0,0.1); background: rgba(255,255,255,0.56); font-size: 12px; font-weight: 600; cursor: pointer; color: var(--text-secondary); font-family: var(--font-sans); transition: all 0.15s; }
.cal-toolbar .today-btn:hover { background: rgba(255,255,255,0.82); color: var(--text-primary); }
.cal-toolbar .toolbar-right { display: flex; align-items: center; gap: 8px; }
.cal-toolbar .view-toggle { gap: 2px; padding: 2px; border-radius: 9px; background: rgba(123,127,178,0.1); }
.cal-toolbar .view-toggle button { border: none; background: none; padding: 4px 12px; border-radius: 7px; font-size: 12px; font-weight: 600; color: var(--text-secondary); cursor: pointer; font-family: var(--font-family-ui); transition: color 0.15s; }
.cal-toolbar .view-toggle button.on { color: #5a5e86; }
</style>
