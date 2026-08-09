<template>
  <Transition name="picker">
    <div v-if="open" ref="root" class="cal-month-picker" :style="style">
      <div class="picker-year-row">
        <button class="picker-nav" @click.stop="$emit('prev-year')"><PhCaretLeft :size="12" weight="bold" /></button>
        <span class="picker-year">{{ year }}</span>
        <button class="picker-nav" @click.stop="$emit('next-year')"><PhCaretRight :size="12" weight="bold" /></button>
      </div>
      <div class="picker-months">
        <button v-for="m in 12" :key="m" class="picker-month" :class="{ active: m - 1 === cursor.getMonth() && year === cursor.getFullYear() }" @click.stop="$emit('select', year, m - 1)">{{ m }}月</button>
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { PhCaretLeft, PhCaretRight } from '@phosphor-icons/vue'

defineProps<{
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
function contains(target: Node) {
  return !!root.value?.contains(target)
}
defineExpose({ contains })
</script>

<style>
.cal-month-picker { position: fixed; background: rgba(255,255,255,0.82); backdrop-filter: var(--popup-blur); -webkit-backdrop-filter: var(--popup-blur); border: 1px solid rgba(255,255,255,0.9); border-radius: 13px; box-shadow: inset 0 1px 0 rgba(255,255,255,0.98), 0 10px 36px rgba(30,40,80,0.14); padding: 14px; }
.picker-year-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.picker-year { font-size: 13px; font-weight: 700; color: #1e2028; }
.picker-nav { width: 26px; height: 26px; border-radius: 7px; border: none; background: none; cursor: pointer; display: flex; align-items: center; justify-content: center; color: #8a8fa8; transition: background 0.12s; }
.picker-nav:hover { background: rgba(0,0,0,0.07); }
.picker-months { display: grid; grid-template-columns: repeat(4, 1fr); gap: 5px; }
.picker-month { padding: 6px 0; border-radius: 8px; border: none; font-size: 12px; font-weight: 500; font-family: 'PingFang SC','Segoe UI',sans-serif; cursor: pointer; background: none; color: #1e2028; transition: all 0.12s; }
.picker-month:hover { background: rgba(123,127,178,0.14); }
.picker-month.active { background: linear-gradient(135deg,#7b7fb2,#9590c4); color: white; font-weight: 700; box-shadow: 0 2px 6px rgba(123,127,178,0.3); }
.picker-enter-active { transition: opacity 0.16s, transform 0.18s cubic-bezier(0.34,1.2,0.64,1); }
.picker-leave-active { transition: opacity 0.12s, transform 0.12s ease-in; }
.picker-enter-from,.picker-leave-to { opacity: 0; transform: scaleY(0.9) translateY(-6px); transform-origin: top; }
</style>
