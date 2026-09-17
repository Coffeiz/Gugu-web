<template>
    <div v-if="usageLoading && !usage" class="usage-loading">{{ t('adminUsageUi.loading') }}</div>
  <template v-else-if="usage">
    <p class="usage-note">{{ usage.usage_basis }} · {{ t('adminUsageUi.timezone') }}: {{ usage.timezone }}</p>
    <div class="usage-summary"><div v-for="item in summary" :key="item.label" class="usage-stat-card"><div class="usc-label">{{ item.label }}</div><div class="usc-num">{{ item.value }}</div><div class="usc-sub">{{ t('adminUsageUi.total') }} {{ item.total }}</div></div></div>
    <div v-if="usage.mcp_summary" class="usage-summary mcp-summary"><div class="usage-stat-card"><div class="usc-label">{{ t('adminUsageUi.mcpEnabledUsers') }}</div><div class="usc-num">{{ usage.mcp_summary.enabled_users }}</div><div class="usc-sub">{{ t('adminUsageUi.mcpAggregateOnly') }}</div></div><div class="usage-stat-card"><div class="usc-label">{{ t('adminUsageUi.mcpEnabledServers') }}</div><div class="usc-num">{{ usage.mcp_summary.enabled_servers }}</div><div class="usc-sub">{{ t('adminUsageUi.mcpAggregateOnly') }}</div></div><div class="usage-stat-card"><div class="usc-label">{{ t('adminUsageUi.mcpCallsTotal') }}</div><div class="usc-num">{{ usage.mcp_summary.calls_total }}</div><div class="usc-sub">{{ t('adminUsageUi.mcpAggregateOnly') }}</div></div></div>
    <div class="config-card chart-card"><div class="chart-header"><div class="metric-tabs"><SegmentedTabs v-model="activeMetric" :tabs="metrics" :aria-label="t('adminUsageUi.model')" size="compact" /><span v-if="activeModel" class="model-filter-tag">{{ activeModel }}</span></div><div class="date-nav" :class="{ 'is-single': props.period === 'day' }"><button class="date-arrow" @click="shiftAnchor(-1)">‹</button><span class="chart-range">{{ chartRangeLabel }}</span><button class="date-arrow" :disabled="!canGoNext" @click="shiftAnchor(1)">›</button></div></div><AdminLineChart :labels="chartData.map((d: any) => formatChartDate(d.date))" :values="chartValues" :unit="metrics.find(m => m.key === activeMetric)?.unit || ''" /></div>
    <div v-if="hasScenarioRows" class="config-card"><div class="card-head"><div class="card-title-block"><h3>{{ t('adminUsageUi.scenario') }}</h3><p>{{ t('adminUsageUi.scenarioHint') }}</p></div></div><div class="model-table"><div class="mt-row mt-head"><span>{{ t('adminUsageUi.scenario') }}</span><span>{{ t('adminUsageUi.calls') }}</span><span>{{ t('adminUsageUi.input') }}</span><span>{{ t('adminUsageUi.output') }}</span><span>{{ t('adminUsageUi.cacheRate') }}</span></div><div v-for="item in scenarioRows" :key="item.scenario" class="mt-row"><span class="mt-model">{{ t(`adminUsageUi.scenario_${item.scenario}`) }}</span><span>{{ item.calls }}</span><span>{{ fmtNum(item.tokens_in) }}</span><span>{{ fmtNum(item.tokens_out) }}</span><span>{{ ((item.cache_ratio || 0) * 100).toFixed(1) }}%</span></div></div></div>
    <div v-if="usage.by_model.length" class="config-card"><div class="card-head"><div class="card-title-block"><h3>{{ t('adminUsageUi.model') }}</h3><p>{{ t('adminUsageUi.modelHint') }}</p></div><button v-if="activeModel" class="clear-model-btn" @click="toggleModel(activeModel)">{{ t('adminUsageUi.clearFilter') }}</button></div><div class="model-table"><div class="mt-row mt-head"><span>{{ t('adminUsageUi.modelName') }}</span><span>{{ t('adminUsageUi.calls') }}</span><span>{{ t('adminUsageUi.input') }}</span><span>{{ t('adminUsageUi.output') }}</span><span>{{ t('adminUsageUi.cacheRead') }}</span></div><div v-for="model in usage.by_model" :key="model.model" class="mt-row mt-clickable" :class="{ 'mt-active': activeModel === model.model, 'mt-dimmed': activeModel && activeModel !== model.model }" @click="toggleModel(model.model)"><span class="mt-model">{{ model.model }}<em>{{ model.provider }}</em></span><span>{{ model.calls }}</span><span>{{ fmtNum(model.tokens_in) }}</span><span>{{ fmtNum(model.tokens_out) }}</span><span>{{ fmtNum(model.cache_read) }}</span></div></div></div>
    <div v-if="!usage.by_model.length && !chartData.some((day: any) => day.calls > 0)" class="usage-empty">{{ t('adminUsageUi.noData') }}</div>
  </template>
</template>
<script setup lang="ts">
import { computed, ref, toRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { useUsage } from '../useUsage'
import AdminLineChart from '@/components/admin/AdminLineChart.vue'
const props = defineProps<{
  period: 'day' | 'week' | 'month'
  excludeDev: boolean
  includeByok: boolean
}>()
const selectedDate = ref('')
const { usage, usageLoading, activeModel, activeMetric, metrics, toggleModel, fmtNum } = useUsage({
  excludeDev: toRef(props, 'excludeDev'),
  includeByok: toRef(props, 'includeByok'),
  date: selectedDate,
})
const { t } = useI18n()
const chartData = computed(() => props.period === 'day'
  ? (usage.value?.today_hourly || [])
  : (usage.value?.[props.period === 'week' ? 'week_daily' : 'month_daily'] || []))
const chartValues = computed(() => chartData.value.map((day: any) => activeMetric.value === 'cache_ratio' ? Number(day.cache_ratio || 0) * 100 : Number(day[activeMetric.value] || 0)))
const chartRangeLabel = computed(() => props.period === 'day' ? usage.value?.today?.date || '' : `${chartData.value[0]?.date || ''} – ${chartData.value.at(-1)?.date || ''}`)
function shiftedAnchor(base: string, offset: number) {
  const next = new Date(`${base}T00:00:00Z`)
  if (props.period === 'week') next.setUTCDate(next.getUTCDate() + offset * 7)
  else if (props.period === 'month') {
    // 先归一到月初，避免 5 月 31 日加一个月溢出到 7 月。
    next.setUTCDate(1)
    next.setUTCMonth(next.getUTCMonth() + offset)
  }
  else next.setUTCDate(next.getUTCDate() + offset)
  return next.toISOString().slice(0, 10)
}
const canGoNext = computed(() => {
  const base = selectedDate.value || usage.value?.anchor_date
  const current = usage.value?.current_date
  return Boolean(base && current && shiftedAnchor(base, 1) <= current)
})
function shiftAnchor(offset: number) {
  const base = selectedDate.value || usage.value?.anchor_date
  if (!base) return
  const nextDate = shiftedAnchor(base, offset)
  if (usage.value?.current_date && nextDate > usage.value.current_date) return
  selectedDate.value = nextDate
}
function formatChartDate(date: string) {
  return props.period === 'day' ? date : date.slice(5)
}
// 场景表跟随右上角的日 / 周 / 月视图。
const scenarioRows = computed(() => props.period === 'day' ? (usage.value?.by_scenario || []) : (usage.value?.[props.period === 'week' ? 'by_scenario_week' : 'by_scenario_month'] || []))
const hasScenarioRows = computed(() => scenarioRows.value.some((item: any) => item.scenario !== 'chat'))
const summary = computed(() => {
  if (!usage.value) return []
  const source = props.period === 'day' ? usage.value.today : chartData.value.reduce((total: any, day: any) => ({
    calls: total.calls + Number(day.calls || 0),
    tokens_in: total.tokens_in + Number(day.tokens_in || 0),
    tokens_out: total.tokens_out + Number(day.tokens_out || 0),
    cache_read: total.cache_read + Number(day.cache_read || 0),
    cache_write: total.cache_write + Number(day.cache_write || 0),
  }), { calls: 0, tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0 })
  const ratio = source.tokens_in ? source.cache_read / source.tokens_in : 0
  const periodLabel = props.period === 'day' ? t('adminUsageUi.today') : props.period === 'week' ? t('adminUsageUi.recent7') : t('adminUsageUi.recent30')
  return [{ label: `${periodLabel}${t('adminUsageUi.calls')}`, value: source.calls, total: usage.value.total.calls }, { label: t('adminUsageUi.input'), value: fmtNum(source.tokens_in), total: fmtNum(usage.value.total.tokens_in) }, { label: t('adminUsageUi.output'), value: fmtNum(source.tokens_out), total: fmtNum(usage.value.total.tokens_out) }, { label: t('adminUsageUi.cacheRead'), value: fmtNum(source.cache_read), total: fmtNum(usage.value.total.cache_read) }, { label: t('adminUsageUi.cacheRate'), value: `${(ratio * 100).toFixed(1)}%`, total: `${((usage.value.total.cache_ratio || 0) * 100).toFixed(1)}%` }]
})
</script>
<style scoped>
.usage-loading,.usage-empty{text-align:center;padding:64px 0;font-size:13px;color:rgba(255,255,255,.2)}.usage-summary{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:12px}.usage-stat-card,.config-card{background:rgba(255,255,255,.05);backdrop-filter:blur(24px);border:1px solid rgba(255,255,255,.09);border-radius:16px;padding:20px 22px;box-shadow:0 4px 24px rgba(0,0,0,.25)}.usc-label{font-size:11px;color:rgba(255,255,255,.3);font-weight:600;margin-bottom:10px}.usc-num{font-size:28px;font-weight:700;color:rgba(255,255,255,.88);line-height:1}.usc-sub{font-size:12px;color:rgba(255,255,255,.25);margin-top:6px}.chart-card{margin-bottom:12px}.chart-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}.metric-tabs{display:flex;gap:4px}.metric-tab,.clear-model-btn{padding:5px 14px;border-radius:8px;border:1px solid rgba(255,255,255,.09);background:rgba(255,255,255,.04);color:rgba(255,255,255,.5);cursor:pointer}.metric-tab.active{background:rgba(123,127,178,.2);color:rgba(255,255,255,.88)}.chart-range{font-size:12px;color:rgba(255,255,255,.38);font-variant-numeric:tabular-nums}.chart-wrap{position:relative;width:100%}.line-chart{display:block;overflow:visible}.chart-tooltip{position:absolute;pointer-events:none;background:rgba(16,16,26,.95);border:1px solid rgba(149,144,196,.25);border-radius:10px;padding:9px 14px;transform:translate(-50%,-115%);white-space:nowrap}.tt-date{font-size:11px;color:rgba(255,255,255,.35);margin-bottom:4px}.tt-val{font-size:18px;font-weight:700;color:rgba(255,255,255,.92)}.tt-val span{font-size:11px;font-weight:400;color:rgba(255,255,255,.35)}.card-head{display:flex;align-items:center;gap:13px;margin-bottom:20px}.card-title-block{flex:1}.card-title-block h3{font-size:14px}.card-title-block p{font-size:12px;color:rgba(255,255,255,.38);margin-top:2px}.model-table{display:flex;flex-direction:column;overflow-x:auto}.mt-row{display:grid;grid-template-columns:minmax(160px,1fr) repeat(4,minmax(64px,90px));min-width:520px;padding:10px 4px;font-size:13px;border-bottom:1px solid rgba(255,255,255,.05);align-items:center}.mt-head{font-size:11px;color:rgba(255,255,255,.25)}.mt-clickable{cursor:pointer}.mt-clickable:hover{background:rgba(255,255,255,.04)}.mt-active{background:rgba(123,127,178,.12)}.mt-dimmed{opacity:.35}.mt-model{color:rgba(255,255,255,.8)}.mt-model em{display:block;font-style:normal;font-size:11px;color:rgba(255,255,255,.28);margin-top:2px}.mt-row span:not(:first-child){text-align:right;color:rgba(255,255,255,.55)}.model-filter-tag{display:inline-flex;padding:3px 10px;border-radius:6px;background:rgba(123,127,178,.18);font-size:12px;color:rgba(169,164,216,.9)}@media(max-width:720px){.usage-summary{grid-template-columns:1fr}.mt-row{grid-template-columns:minmax(140px,1fr) repeat(4,65px)}}
.date-nav{display:flex;align-items:center;gap:8px}.date-nav.is-single{gap:4px}.date-arrow{width:24px;height:24px;padding:0;border:1px solid rgba(255,255,255,.09);border-radius:6px;background:rgba(255,255,255,.04);color:rgba(255,255,255,.6);cursor:pointer}.date-arrow:disabled{opacity:.3;cursor:default}.chart-range{min-width:118px;text-align:center}.date-nav.is-single .chart-range{min-width:0}
.usage-note{margin:0 0 12px;color:rgba(255,255,255,.34);font-size:11px;line-height:1.5}
.mt-row { border-bottom-color: var(--panel-divider); }
</style>
