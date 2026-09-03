<template>
  <div class="admin-line-chart">
    <Line :data="data" :options="options" />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { Line } from 'vue-chartjs'
import { Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement, Filler, Tooltip } from 'chart.js'
import { fmtTok, lineChartOptions, cssVar, chartThemeKey } from '@/utils/chartKit'

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Filler, Tooltip)
type ChartDataset = { label?: string; values: Array<number | null>; color?: string }
const props = withDefaults(defineProps<{
  labels: string[]
  values?: Array<number | null>
  datasets?: ChartDataset[]
  unit?: string
}>(), { unit: '' })

// 线条色走令牌（主色），透明填充在 canvas 里用 color-mix 派生。
// data computed 读取 chartThemeKey（经 lineDataset）建立主题依赖：主题/调色板切换时重算配色。
const lineDataset = computed(() => {
  void chartThemeKey.value
  const lineColor = cssVar('--action-primary', 'rgba(123,127,178,1)')
  return {
    borderColor: lineColor,
    backgroundColor: `color-mix(in srgb, ${lineColor} 16%, transparent)`,
    fill: true,
    tension: 0.45,
    pointRadius: 0,
    pointHoverRadius: 4,
    pointBackgroundColor: lineColor,
    borderWidth: 1.5,
    clip: 10,   // 允许越出绘图区绘制：贴边 hover 点不被裁半
  }
})
const data = computed(() => ({
  labels: props.labels,
  datasets: props.datasets?.length
    ? props.datasets.map(dataset => ({
        label: dataset.label,
        data: dataset.values,
        ...lineDataset.value,
        ...(dataset.color ? {
          borderColor: dataset.color,
          pointBackgroundColor: dataset.color,
          backgroundColor: dataset.color.replace(/1\)$/, '0.16)'),
        } : {}),
      }))
    : [{ data: props.values || [], ...lineDataset.value }],
}))
const options = computed(() => lineChartOptions({
  isTok: true,
  showLegend: Boolean(props.datasets?.length && props.datasets.length > 1),
  tooltipLabel: (ctx: any) => `${ctx.dataset.label ? `${ctx.dataset.label}: ` : ''}${fmtTok(Number(ctx.raw) || 0)}${props.unit}`,
}))</script>

<style scoped>
.admin-line-chart { height: 180px; position: relative; width: 100%; }
</style>
