<template>
  <Teleport to="body">
    <Transition name="more-pop">
      <div v-if="open" ref="popup" class="overflow-popup" :style="style">
        <div class="overflow-popup-title">{{ dateLabel }}</div>
        <div class="overflow-list">
          <div v-for="item in items" :key="item.id" class="overflow-item cal-chip"
               :class="{ 'overflow-clickable': !!item.calendarType, 'cal-done': item.calendarType === 'project' && item.status === 'done' }"
               :style="{ background: item.calendarType === 'project' ? capBg(item.accent, item.progress) : item.accent + '28', borderColor: item.accent + '70', color: darkenHex(item.accent), cursor: item.calendarType ? 'grab' : 'default' }"
               @click.stop="item.calendarType === 'project' ? $emit('open-project', item) : (item.calendarType === 'event' && $emit('edit-event', { item, event: $event }))"
               @mousedown.stop="item.calendarType && $emit('drag-item', { item, event: $event })">
            <span class="overflow-tag" :class="{ 'overflow-tag-ev': item.calendarType !== 'project' }">{{ item.calendarType === 'project' ? '项目' : '活动' }}</span>
            <span v-if="item.calendarType === 'project'" class="bar-status-dot" :class="'bsd-' + item.status"></span>
            <span class="overflow-name">{{ item.name }}</span>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { capBg, darkenHex } from '../utils/calendarColors'
import type { CalendarRenderItem } from '../domain/calendarTypes'

defineProps<{
  open: boolean
  items: CalendarRenderItem[]
  dateLabel: string
  style: Record<string, string | number | undefined>
}>()

defineEmits<{
  'open-project': [item: CalendarRenderItem]
  'edit-event': [payload: { item: CalendarRenderItem; event: MouseEvent }]
  'drag-item': [payload: { item: CalendarRenderItem; event: MouseEvent }]
}>()

const popup = ref<HTMLElement | null>(null)
defineExpose({ contains: (target: Node) => !!popup.value?.contains(target) })
</script>

<style>
.overflow-popup { background: var(--panel-bg); backdrop-filter: var(--popup-blur); -webkit-backdrop-filter: var(--popup-blur); border: 1px solid rgba(255,255,255,0.82); border-radius: 14px; box-shadow: inset 0 1px 0 rgba(255,255,255,0.98), 0 8px 28px rgba(30,40,80,0.14); padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; }
.overflow-popup-title { font-size: 12px; font-weight: 700; color: var(--text-secondary); line-height: 1; padding-bottom: 2px; margin-bottom: -2px; }
.overflow-list { display: flex; flex-direction: column; gap: 4px; }
.overflow-item { display: flex; align-items: center; gap: 4px; height: 22px; padding: 0 8px; border-radius: 99px; border: 1px solid transparent; font-size: 10px; font-weight: 500; white-space: nowrap; overflow: hidden; }
.overflow-item:not(.overflow-clickable) { pointer-events: none; }
.overflow-tag { font-size: 8px; font-weight: 700; letter-spacing: 0.04em; background: rgba(255,255,255,0.5); border-radius: 3px; padding: 0 3px; line-height: 11px; flex-shrink: 0; margin-right: 2px; }
.overflow-tag-ev { background: rgba(210,175,40,0.35); color: #7a5c00; }
.overflow-name { overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0; }
.more-pop-enter-active { transition: opacity 0.16s, transform 0.18s cubic-bezier(0.34,1.2,0.64,1); }
.more-pop-leave-active { transition: opacity 0.12s, transform 0.12s ease-in; }
.more-pop-enter-from,.more-pop-leave-to { opacity: 0; transform: scaleY(0.88); }
</style>
