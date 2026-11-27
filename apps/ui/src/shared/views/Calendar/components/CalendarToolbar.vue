<template>
  <PageToolbar class="cal-toolbar">
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
  </PageToolbar>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import PageToolbar from '@/components/common/layout/PageToolbar.vue'
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
.cal-toolbar :is(.nav-btn, .period-btn, .today-btn, .view-toggle) {
  box-sizing: border-box;
  height: var(--toolbar-compact-control-height);
}
.cal-toolbar .toolbar-left { display: flex; align-items: center; gap: var(--space-xs); }
.cal-toolbar .nav-btn { width: var(--toolbar-compact-control-height); border-radius: 8px; border: none; background: none; cursor: pointer; display: flex; align-items: center; justify-content: center; color: var(--text-secondary); transition: background 0.15s; }
.cal-toolbar .nav-btn:hover { background: rgba(0,0,0,0.06); }
.cal-toolbar .period-btn { display: flex; align-items: center; gap: var(--space-xs); font-size: 15px; font-weight: 700; color: var(--text-primary); min-width: 130px; justify-content: center; padding: var(--space-xs) var(--space-sm); border-radius: 9px; border: none; background: none; cursor: pointer; font-family: var(--font-sans); transition: background 0.15s; }
.cal-toolbar .period-btn:hover { background: rgba(0,0,0,0.06); }
.cal-toolbar .today-btn { padding: var(--space-xs) var(--space-md); border-radius: 8px; border: 1px solid rgba(0,0,0,0.1); background: rgba(255,255,255,0.56); font-size: 12px; font-weight: 600; cursor: pointer; color: var(--text-secondary); font-family: var(--font-sans); transition: all 0.15s; }
.cal-toolbar .today-btn:hover { background: rgba(255,255,255,0.82); color: var(--text-primary); }
.cal-toolbar .toolbar-right { display: flex; align-items: center; gap: var(--space-xs); }
.cal-toolbar .view-toggle { gap: var(--space-xs); padding: var(--space-xs); border-radius: 9px; background: color-mix(in srgb, var(--action-primary) 10%, transparent); }
.cal-toolbar .view-toggle button { border: none; background: none; padding: var(--space-xs) var(--space-md); border-radius: 7px; font-size: 12px; font-weight: 600; color: var(--text-secondary); cursor: pointer; font-family: var(--font-family-ui); transition: color 0.15s; }
.cal-toolbar .view-toggle button.on { color: #5a5e86; }
.cal-toolbar .view-toggle > button { align-self: stretch; padding-block: 0; }
</style>
