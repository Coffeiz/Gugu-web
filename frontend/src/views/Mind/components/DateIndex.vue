<template>
  <!-- 右侧窄日期索引：裸文字条（无面板底，越像"页边刻度"越好），滚动联动高亮。
       列日期而非每条便签——右栏把便签再列一遍是假密度（同一内容屏幕上出现两次）。 -->
  <nav class="date-index">
    <button
      v-for="g in groups" :key="g.date"
      class="di-item" :class="{ on: g.date === active }"
      @click="emit('jump', g.date)"
    >
      <span class="di-label">{{ fmtShort(g.date) }}</span>
      <span class="di-count">{{ g.count }}</span>
    </button>
  </nav>
</template>

<script setup lang="ts">
defineProps<{
  groups: { date: string; count: number }[]
  active: string
}>()
const emit = defineEmits<{ (e: 'jump', date: string): void }>()

const _today = new Date().toISOString().slice(0, 10)

function fmtShort(iso: string) {
  if (iso === _today) return '今天'
  const [y, m, d] = iso.split('-')
  return y === _today.slice(0, 4) ? `${+m}月${+d}日` : `${y.slice(2)}年${+m}月${+d}日`
}
</script>

<style scoped>
.date-index {
  width: 120px; flex-shrink: 0;
  display: flex; flex-direction: column; gap: 1px;
  overflow-y: auto; padding: 2px 0;
  scrollbar-width: none;
}
.date-index::-webkit-scrollbar { display: none; }

.di-item {
  display: flex; align-items: center; gap: 6px;
  padding: 4px 8px 4px 10px; border: none; border-radius: 0 7px 7px 0;
  background: none; cursor: pointer; text-align: left;
  font-family: var(--font-sans);
  border-left: 3px solid transparent;
  transition: border-color 0.15s, color 0.15s;
}
.di-label { font-size: 11.5px; color: var(--text-secondary); white-space: nowrap; }
.di-count { margin-left: auto; font-size: 10px; color: var(--text-secondary); opacity: 0.6; font-variant-numeric: tabular-nums; }
.di-item:hover .di-label { color: var(--text-primary); }
.di-item.on { border-left-color: var(--color-primary); }
.di-item.on .di-label { color: var(--text-primary); font-weight: 600; }

@media (max-width: 900px) {
  .date-index { display: none; }
}
</style>
