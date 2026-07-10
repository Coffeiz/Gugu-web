<template>
  <!-- 顶部横向日期条（胶囊下方）：一天一枚 chip，滚动联动高亮、点击横向跳到对应列。
       列日期而非每条便签——把便签再列一遍是假密度（同一内容屏幕上出现两次）。 -->
  <nav ref="stripRef" class="date-strip">
    <button
      v-for="g in groups" :key="g.date"
      class="ds-chip" :class="{ on: g.date === active }"
      :data-date="g.date"
      @click="emit('jump', g.date)"
    >
      <span class="ds-label">{{ fmtShort(g.date) }}</span>
      <span class="ds-count">{{ g.count }}</span>
    </button>
  </nav>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'

const props = defineProps<{
  groups: { date: string; count: number }[]
  active: string
}>()
const emit = defineEmits<{ (e: 'jump', date: string): void }>()

const stripRef = ref<HTMLElement | null>(null)

// 高亮 chip 跟着滚动跑出可视区时，把它带回来（条自身也可能很长）
watch(() => props.active, (d) => {
  stripRef.value?.querySelector<HTMLElement>(`.ds-chip[data-date="${d}"]`)
    ?.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' })
})

const _today = new Date().toISOString().slice(0, 10)

function fmtShort(iso: string) {
  if (iso === _today) return '今天'
  const [y, m, d] = iso.split('-')
  return y === _today.slice(0, 4) ? `${+m}月${+d}日` : `${y.slice(2)}年${+m}月${+d}日`
}
</script>

<style scoped>
.date-strip {
  display: flex; align-items: center; gap: 6px;
  flex-shrink: 0; overflow-x: auto; padding: 2px 2px 4px;
  scrollbar-width: none;
}
.date-strip::-webkit-scrollbar { display: none; }

.ds-chip {
  flex-shrink: 0; display: inline-flex; align-items: center; gap: 6px;
  padding: 4px 11px; border: 1px solid transparent; border-radius: 999px;
  background: rgba(255,255,255,0.4); cursor: pointer;
  font-family: var(--font-sans);
  transition: background 0.15s, border-color 0.15s;
}
.ds-chip:hover { background: rgba(255,255,255,0.65); }
.ds-label { font-size: 11.5px; color: var(--text-secondary); white-space: nowrap; }
.ds-count { font-size: 10px; color: var(--text-secondary); opacity: 0.6; font-variant-numeric: tabular-nums; }
.ds-chip.on {
  background: rgba(123,127,178,0.14); border-color: rgba(123,127,178,0.3);
}
.ds-chip.on .ds-label { color: #5a5e86; font-weight: 600; }
</style>
