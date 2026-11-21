<template>
  <section class="config-card">
    <header>
      <h3>{{ t('adminUsageUi.scenario') }}</h3>
      <p>{{ t('adminUsageUi.scenarioHint') }}</p>
      <p>{{ t('adminUsageUi.cacheStatsHint') }}</p>
    </header>
    <div class="scenario-scroll">
      <table>
        <thead><tr>
          <th scope="col">{{ t('adminUsageUi.scenario') }}</th>
          <th scope="col">{{ t('adminUsageUi.calls') }}</th>
          <th scope="col">{{ t('adminUsageUi.input') }}</th>
          <th scope="col">{{ t('adminUsageUi.output') }}</th>
          <th scope="col">{{ t('adminUsageUi.cacheRate') }}</th>
          <th scope="col">{{ t('adminUsageUi.coldCalls') }}</th>
          <th scope="col">{{ t('adminUsageUi.warmCacheRate') }}</th>
        </tr></thead>
        <tbody><tr v-for="item in rows" :key="item.scenario">
          <th scope="row">{{ t(`adminUsageUi.scenario_${item.scenario}`) }}</th>
          <td>{{ item.calls }}</td>
          <td>{{ formatNumber(item.tokens_in) }}</td>
          <td>{{ formatNumber(item.tokens_out) }}</td>
          <td>{{ percent(item.cache_ratio) }}</td>
          <td>{{ item.cold_calls ?? '—' }}</td>
          <td>{{ percent(item.warm_cache_ratio) }}</td>
        </tr></tbody>
      </table>
    </div>
  </section>
</template>
<script setup lang="ts">
import type { PropType } from 'vue'
import { useI18n } from 'vue-i18n'

type ScenarioRow = {
  scenario: string
  calls: number
  tokens_in: number
  tokens_out: number
  cache_ratio: number
  cold_calls?: number
  warm_cache_ratio?: number | null
}
defineProps({
  rows: { type: Array as PropType<ScenarioRow[]>, required: true },
  formatNumber: { type: Function as PropType<(value: number) => string>, required: true },
})
const { t } = useI18n()
function percent(value: number | null | undefined) {
  return value == null ? '—' : `${(value * 100).toFixed(1)}%`
}
</script>
<style scoped>
header { margin-bottom: 16px; min-width: 0; }
h3 { margin: 0; font-size: 14px; color: var(--text-primary); }
p { margin: 4px 0 0; font-size: 12px; line-height: 1.6; color: var(--text-secondary); }
.scenario-scroll { overflow-x: auto; }
table { width: 100%; min-width: 760px; border-collapse: collapse; font-size: 13px; }
th, td { padding: 10px 8px; text-align: right; border-bottom: 1px solid var(--panel-divider); font-variant-numeric: tabular-nums; color: var(--text-secondary); }
th:first-child { min-width: 100px; text-align: left; }
thead th { font-size: 11px; font-weight: 500; }
tbody th { font-weight: 400; color: var(--text-primary); }
</style>
