<template>
  <div class="ttc-card">
    <div class="ttc-header">
      <span class="ttc-title">{{ t('profileGuguUi.tokenTrend') }}</span>
      <span class="ttc-stats">
        <span class="ttc-stat"><em>{{ t('profileGuguUi.recent30') }}</em>{{ fmtTok(total) }}</span>
        <span class="ttc-sep">·</span>
        <span class="ttc-stat"><em>{{ t('profileGuguUi.dailyAvg') }}</em>{{ fmtTok(dailyAvg) }}</span>
        <span class="ttc-sep">·</span>
        <span class="ttc-stat"><em>{{ t('profileGuguUi.todayTokens') }}</em>{{ fmtTok(today) }}</span>
        <span class="ttc-sep">·</span>
        <span class="ttc-stat"><em>{{ t('profileGuguUi.cacheRate') }}</em>{{ cachePct }}%</span>
      </span>
    </div>
    <div class="ttc-chart"><Line :data="chartData" :options="chartOpts" /></div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { Line } from 'vue-chartjs'
import {
  Chart as ChartJS, CategoryScale, LinearScale, PointElement,
  LineElement, Filler, Tooltip,
} from 'chart.js'
import { useI18n } from 'vue-i18n'
import { fmtTok, lineChartOptions, cssVar, chartThemeKey } from '@/utils/chartKit'

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Filler, Tooltip)

const props = defineProps<{
  labels: string[]
  tokensIn: number[]      // 未命中缓存的新增输入
  cacheRead: number[]     // 缓存命中
  tokensOut: number[]     // 输出
}>()

const { t } = useI18n()

const totalIn = computed(() => props.tokensIn.reduce((a, b) => a + b, 0))
const totalCache = computed(() => props.cacheRead.reduce((a, b) => a + b, 0))
const totalOut = computed(() => props.tokensOut.reduce((a, b) => a + b, 0))
const total = computed(() => totalIn.value + totalCache.value + totalOut.value)
const dailyAvg = computed(() => Math.round(total.value / Math.max(1, props.labels.length)))
const today = computed(() => {
  const i = props.labels.length - 1
  if (i < 0) return 0
  return props.tokensIn[i] + props.cacheRead[i] + props.tokensOut[i]
})
const cachePct = computed(() => {
  const denom = totalIn.value + totalCache.value
  return denom ? Math.round(totalCache.value / denom * 100) : 0
})

// 线条/文字颜色一律走令牌；canvas 里用 color-mix 派生透明版本（浏览器 canvas 支持 CSS color-mix）。
// chartData 读取 chartThemeKey 建立主题依赖：主题/调色板切换时重算线条色。
const full = (n: number) => new Intl.NumberFormat().format(Number(n) || 0)

const chartData = computed(() => {
  void chartThemeKey.value
  const lineColor = cssVar('--action-primary', 'rgba(123,127,178,1)')
  const lineFill = `color-mix(in srgb, ${lineColor} 16%, transparent)`
  return {
  labels: props.labels,
  datasets: [{
    label: t('profileGuguUi.tooltipTotal'),
    data: props.labels.map((_, i) => props.tokensIn[i] + props.cacheRead[i] + props.tokensOut[i]),
    borderColor: lineColor,
    backgroundColor: lineFill,
    fill: true,
    tension: 0.45,
    pointRadius: 0,
    pointHoverRadius: 4,
    pointBackgroundColor: lineColor,
    borderWidth: 1.5,
    // 允许越出绘图区绘制：贴 0 轴/边缘的 hover 点不被裁半。
    clip: 10,
  }],
  }
})

const chartOpts = computed(() => lineChartOptions({
  isTok: true,
  tooltipLabel: (ctx: any) => `${t('profileGuguUi.tooltipTotal')} ${full(Number(ctx.raw) || 0)}`,
  afterBody: (items: any[]) => {
    const i = items[0]?.dataIndex ?? -1
    if (i < 0) return []
    return [
      `${t('profileGuguUi.tooltipIn')} ${full(props.tokensIn[i])}`,
      `${t('profileGuguUi.tooltipIn')}（${t('profileGuguUi.tooltipCache')}） ${full(props.cacheRead[i])}`,
      `${t('profileGuguUi.tooltipOut')} ${full(props.tokensOut[i])}`,
    ]
  },
}))
</script>

<style scoped>
.ttc-card { border: 1px solid var(--subpanel-border); border-radius: 9px; background: var(--subpanel-bg); padding: 10px 12px 8px; }
.ttc-header { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; flex-wrap: wrap; margin-bottom: 6px; }
.ttc-title { color: var(--content-tertiary); font-size: 12px; }
.ttc-stats { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; }
.ttc-stat { color: var(--content-primary); font-size: 13px; font-variant-numeric: tabular-nums; }
.ttc-stat em { font-style: normal; color: var(--content-tertiary); font-size: 11px; margin-right: 4px; }
.ttc-sep { color: var(--content-tertiary); opacity: 0.5; }
.ttc-chart { position: relative; height: 180px; }
</style>
