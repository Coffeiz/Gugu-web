<template>
  <div class="admin-line-chart">
    <Line :data="data" :options="options" />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { Line } from 'vue-chartjs'
import { Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement, Filler, Tooltip } from 'chart.js'
import { BLUE, fmtTok } from '@/views/Admin/Analytics/_shared'

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Filler, Tooltip)
type ChartDataset = { label?: string; values: Array<number | null>; color?: string }
const props = withDefaults(defineProps<{
  labels: string[]
  values?: Array<number | null>
  datasets?: ChartDataset[]
  unit?: string
}>(), { unit: '' })

const lineDataset = {
  borderColor: BLUE,
  backgroundColor: 'rgba(123,127,178,0.16)',
  fill: true,
  tension: 0.45,
  pointRadius: 0,
  pointHoverRadius: 4,
  pointBackgroundColor: BLUE,
  borderWidth: 1.5,
}
const data = computed(() => ({
  labels: props.labels,
  datasets: props.datasets?.length
    ? props.datasets.map(dataset => ({
        label: dataset.label,
        data: dataset.values,
        ...lineDataset,
        ...(dataset.color ? {
          borderColor: dataset.color,
          pointBackgroundColor: dataset.color,
          backgroundColor: dataset.color.replace(/1\)$/, '0.16)'),
        } : {}),
      }))
    : [{ data: props.values || [], ...lineDataset }],
}))
const options = computed(() => ({
  responsive: true, maintainAspectRatio: false, animation: false as const,
  interaction: { mode: 'index' as const, intersect: false },
  plugins: {
    legend: { display: Boolean(props.datasets?.length && props.datasets.length > 1), position: 'bottom' as const, labels: { color: 'rgba(255,255,255,0.55)', boxWidth: 10, font: { size: 11 } } },
    tooltip: { displayColors: false, callbacks: { label: (ctx: any) => `${ctx.dataset.label ? `${ctx.dataset.label}: ` : ''}${fmtTok(Number(ctx.raw) || 0)}${props.unit}` } },
  },
  scales: {
    x: { grid: { color: 'rgba(255,255,255,0.04)' }, border: { color: 'transparent' }, ticks: { color: 'rgba(255,255,255,0.25)', font: { size: 10 }, maxTicksLimit: 8 } },
    y: { grid: { color: 'rgba(255,255,255,0.04)' }, border: { color: 'transparent' }, ticks: { color: 'rgba(255,255,255,0.25)', font: { size: 10 }, callback: (v: any) => fmtTok(Number(v)) }, beginAtZero: true },
  },
}))
</script>

<style scoped>
.admin-line-chart { height: 180px; position: relative; width: 100%; }
</style>
