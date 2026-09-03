<template>
  <div class="admin-bar-chart" :class="{ 'is-horizontal': horizontal }" :style="chartStyle">
    <Bar :data="data" :options="options" />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { Bar } from 'vue-chartjs'
import { BarElement, CategoryScale, Chart as ChartJS, LinearScale, Tooltip } from 'chart.js'
import { fmtTok } from '@/views/Admin/Analytics/_shared'

ChartJS.register(CategoryScale, LinearScale, BarElement, Tooltip)

type BarDataset = {
  label?: string
  values: number[]
  color?: string
}

const props = withDefaults(defineProps<{
  labels: string[]
  values?: number[]
  datasets?: BarDataset[]
  unit?: string
  horizontal?: boolean
  height?: number
  max?: number
}>(), {
  unit: '',
  horizontal: true,
})

const colors = [
  'var(--action-primary)',
  'var(--status-success)',
  'var(--status-warning)',
  'var(--status-danger)',
]

function resolveColor(color: string) {
  if (!color.startsWith('var(') || typeof document === 'undefined') return color
  const token = color.slice(4, -1).trim()
  return getComputedStyle(document.documentElement).getPropertyValue(token).trim() || color
}

const data = computed(() => ({
  labels: props.labels,
  datasets: props.datasets?.length
    ? props.datasets.map((dataset, index) => {
        const color = resolveColor(dataset.color || colors[index % colors.length])
        return {
          label: dataset.label,
          data: dataset.values,
          backgroundColor: color,
          hoverBackgroundColor: color,
          borderRadius: 4,
          borderSkipped: false,
          barThickness: props.datasets!.length > 1 ? 12 : 14,
        }
      })
    : (() => {
        const color = resolveColor(colors[0])
        return [{
          data: props.values || [],
          backgroundColor: color,
          hoverBackgroundColor: color,
          borderRadius: 4,
          borderSkipped: false,
          barThickness: 14,
        }]
      })(),
}))

const options = computed(() => ({
  indexAxis: (props.horizontal ? 'y' : 'x') as 'y' | 'x',
  responsive: true,
  maintainAspectRatio: false,
  animation: false as const,
  interaction: { mode: 'index' as const, intersect: true },
  scales: {
    x: {
      stacked: false,
      beginAtZero: true,
      suggestedMax: props.horizontal ? props.max : undefined,
      grid: { color: resolveColor('var(--chart-grid-line)') },
      border: { color: 'transparent' },
      ticks: { color: resolveColor('var(--content-tertiary)'), font: { size: 10 }, precision: 0 },
    },
    y: {
      stacked: false,
      grid: { display: false },
      border: { color: 'transparent' },
      ticks: { color: resolveColor('var(--content-secondary)'), font: { size: 11 } },
    },
  },
  plugins: {
    legend: {
      display: Boolean(props.datasets?.length && props.datasets.length > 1),
      position: 'bottom' as const,
      labels: { color: resolveColor('var(--content-secondary)'), boxWidth: 10, font: { size: 11 } },
    },
    tooltip: {
      displayColors: false,
      backgroundColor: resolveColor('var(--surface-floating)'),
      borderColor: resolveColor('var(--border-subtle)'),
      borderWidth: 1,
      titleColor: resolveColor('var(--content-tertiary)'),
      bodyColor: resolveColor('var(--content-primary)'),
      padding: 10,
      callbacks: {
        label: (ctx: any) => `${ctx.dataset.label ? `${ctx.dataset.label}: ` : ''}${fmtTok(Number(ctx.raw) || 0)}${props.unit}`,
      },
    },
  },
}))

const chartStyle = computed(() => ({
  height: `${props.height ?? (props.horizontal ? 196 : 176)}px`,
}))
</script>

<style scoped>
.admin-bar-chart { position: relative; width: 100%; }
</style>
