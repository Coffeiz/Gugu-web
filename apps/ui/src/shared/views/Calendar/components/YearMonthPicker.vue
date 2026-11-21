<template>
  <Transition name="picker">
    <div v-if="open" ref="root" class="cal-month-picker" :style="style">
      <div class="picker-year-row">
        <button class="picker-nav" @click.stop="$emit('prev-year')"><Icon name="action.back" :size="12" /></button>
        <span class="picker-year">{{ year }}</span>
        <button class="picker-nav" @click.stop="$emit('next-year')"><Icon name="action.next" :size="12" /></button>
      </div>
      <div class="picker-months">
        <button v-for="m in 12" :key="m" class="picker-month" :class="{ active: m - 1 === cursor.getMonth() && year === cursor.getFullYear() }" @click.stop="$emit('select', year, m - 1)">{{ monthLabel(m - 1) }}</button>
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/common/icons/Icon.vue'
const { t, locale } = useI18n()
const props = defineProps<{
  open: boolean
  year: number
  cursor: Date
  style: Record<string, string | number>
}>()

defineEmits<{
  'prev-year': []
  'next-year': []
  select: [year: number, month: number]
}>()

const root = ref<HTMLElement | null>(null)
function monthLabel(month: number) {
  if (locale.value === 'en-US') {
    return new Intl.DateTimeFormat(locale.value, { month: 'short' }).format(new Date(props.year, month, 1))
  }
  return `${month + 1}${t('calendar.month')}`
}
function contains(target: Node) {
  return !!root.value?.contains(target)
}
defineExpose({ contains })
</script>

<style>
/* useCalendarNav 按 220px border-box 计算 period-btn 中心；这里必须包含 padding/border，
   否则 content-box 会额外长 30px，视觉中心固定向右偏 15px。 */
.cal-month-picker { position: fixed; box-sizing: border-box; background: var(--popup-surface-bg); backdrop-filter: var(--popup-surface-blur); -webkit-backdrop-filter: var(--popup-surface-blur); border: 1px solid var(--popup-surface-border); border-radius: var(--popup-surface-radius); box-shadow: var(--popup-surface-shadow); padding: 14px; }
.picker-year-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.picker-year { font-size: 13px; font-weight: 700; color: var(--content-primary); }
.picker-nav { width: 26px; height: 26px; border-radius: 7px; border: none; background: none; cursor: pointer; display: flex; align-items: center; justify-content: center; color: var(--content-secondary); transition: background 0.12s; }
.picker-nav:hover { background: var(--surface-soft-hover); }
.picker-months { display: grid; grid-template-columns: repeat(4, 1fr); gap: 5px; }
.picker-month { padding: 6px 0; border-radius: 8px; border: none; font-size: 12px; font-weight: 500; font-family: var(--font-family-ui); cursor: pointer; background: none; color: var(--content-primary); transition: all 0.12s; }
.picker-month:hover { background: var(--action-soft-hover); }
.picker-month.active { background: var(--action-primary-bg); color: var(--content-on-accent); font-weight: 700; box-shadow: var(--elevation-card); }
.picker-enter-active { transition: opacity 0.16s, transform 0.18s cubic-bezier(0.34,1.2,0.64,1); }
.picker-leave-active { transition: opacity 0.12s, transform 0.12s ease-in; }
.picker-enter-from,.picker-leave-to { opacity: 0; transform: scaleY(0.9) translateY(-6px); transform-origin: top; }
</style>
