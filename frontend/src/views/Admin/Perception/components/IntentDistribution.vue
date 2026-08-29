<template>
  <div class="intent-distribution" aria-label="需求类型分布与误判率">
    <div class="intent-legend" aria-hidden="true">
      <span><i class="legend-main"></i>整体占比</span>
      <span><i class="legend-misread"></i>其中误判</span>
    </div>
    <div v-for="item in items" :key="item.intent" class="intent-row">
      <div class="intent-meta">
        <span class="intent-name">{{ item.intent }}</span>
        <span class="intent-sample">{{ item.count }} 条</span>
        <span class="intent-share">{{ item.pct.toFixed(0) }}%</span>
        <span class="intent-rate" :class="rateClass(item.misperc_rate)">误判 {{ percent(item.misperc_rate) }}</span>
      </div>
      <div class="intent-track" :aria-label="`${item.intent}：整体占比 ${item.pct.toFixed(0)}%，误判率 ${percent(item.misperc_rate)}`">
        <div class="intent-bar" :style="{ width: `${Math.max(0, Math.min(100, item.pct / maxShare * 100))}%` }">
          <span class="intent-misread" :style="{ width: `${Math.max(0, Math.min(100, item.misperc_rate * 100))}%` }"></span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

interface IntentRow {
  intent: string
  pct: number
  misperc_rate: number
  count: number
}

const props = defineProps<{
  items: IntentRow[]
  rateHigh: number
}>()

const maxShare = computed(() => Math.max(...props.items.map(item => item.pct), 1))

function percent(value: number) {
  return `${(value * 100).toFixed(0)}%`
}

function rateClass(value: number) {
  const medium = props.rateHigh * 0.6
  return value > props.rateHigh ? 'is-danger' : (value > medium ? 'is-warning' : '')
}
</script>

<style scoped>
.intent-distribution { display: flex; flex-direction: column; gap: 11px; }
.intent-legend { display: flex; justify-content: flex-end; gap: 14px; color: var(--content-tertiary); font-size: 11px; }
.intent-legend span { display: inline-flex; align-items: center; gap: 5px; }
.intent-legend i { width: 8px; height: 8px; border-radius: 50%; }
.legend-main { background: var(--action-primary); }
.legend-misread { background: var(--status-danger); }
.intent-row { display: grid; gap: 5px; }
.intent-meta { display: grid; grid-template-columns: minmax(72px, 1fr) auto auto auto; align-items: baseline; column-gap: 12px; }
.intent-name { color: var(--content-secondary); font-size: 12px; font-weight: 650; }
.intent-sample { color: var(--content-tertiary); font-size: 10.5px; }
.intent-share { color: var(--content-primary); font-size: 12px; font-variant-numeric: tabular-nums; }
.intent-rate { min-width: 68px; color: var(--content-secondary); font-size: 11px; font-variant-numeric: tabular-nums; text-align: right; }
.intent-rate.is-warning { color: var(--status-warning); }
.intent-rate.is-danger { color: var(--status-danger); font-weight: 650; }
.intent-track { height: 9px; overflow: hidden; border: 1px solid var(--border-hairline); border-radius: 999px; background: color-mix(in srgb, var(--surface-raised) 78%, transparent); }
.intent-bar { position: relative; height: 100%; min-width: 2px; overflow: hidden; border-radius: inherit; background: color-mix(in srgb, var(--action-primary) 68%, var(--surface-soft)); transition: width var(--motion-default) var(--ease-standard); }
.intent-misread { position: absolute; inset: 0 0 0 auto; background: color-mix(in srgb, var(--status-danger) 84%, var(--action-primary)); }

@media (max-width: 760px) {
  .intent-meta { grid-template-columns: minmax(64px, 1fr) auto auto; }
  .intent-sample { display: none; }
}
</style>
