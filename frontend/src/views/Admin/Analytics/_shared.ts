/** Analytics 两页（数据总览 / 使用分析）共用：图表配置、格式化、排除开发者开关。 */
import { ref, watch } from 'vue'

// ── 排除开发者（全局开关，localStorage 持久，两页共享同一状态）──────────────
const _XD_KEY = 'admin_exclude_dev'
export const excludeDev = ref(localStorage.getItem(_XD_KEY) === '1')
watch(excludeDev, v => localStorage.setItem(_XD_KEY, v ? '1' : '0'))
/** 拼到请求 query 上（首参用 ?，已有 query 用 &） */
export function xdQuery(prefix: '?' | '&' = '?'): string {
  return excludeDev.value ? `${prefix}exclude_dev=true` : ''
}

// ── 颜色 ─────────────────────────────────────────────────────────────────────
export const BLUE  = 'rgba(123,127,178,1)'
export const AMBER = 'rgba(201,148,58,1)'
export const TEAL  = 'rgba(90,158,136,1)'
export const CORAL = 'rgba(180,100,100,1)'

export const donutColors = [
  'rgba(123,127,178,0.85)',
  'rgba(90,158,136,0.85)',
  'rgba(201,148,58,0.85)',
  'rgba(180,100,100,0.85)',
  'rgba(100,160,210,0.85)',
  'rgba(160,130,200,0.85)',
]

// ── 格式化 ───────────────────────────────────────────────────────────────────
export function fmtTok(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'K'
  return String(n)
}
export function sumArr(arr?: number[]): number { return arr?.reduce((a, b) => a + b, 0) ?? 0 }
export function dailyAvg(arr?: number[]): string {
  if (!arr?.length) return '0'
  return (sumArr(arr) / arr.length).toFixed(1)
}
export function pct(rate: number): string { return (rate * 100).toFixed(1) }
export function convRate(prev: number, curr: number): string {
  if (!prev) return '—'
  return (curr / prev * 100).toFixed(1) + '%'
}

// ── Chart.js ────────────────────────────────────────────────────────────────
export const crosshairPlugin = {
  id: 'crosshair',
  afterDraw(chart: any) {
    if (!chart.tooltip?._active?.length) return
    const { ctx, scales: { y } } = chart
    const x = chart.tooltip._active[0].element.x
    ctx.save()
    ctx.beginPath()
    ctx.moveTo(x, y.top)
    ctx.lineTo(x, y.bottom)
    ctx.lineWidth = 1
    ctx.strokeStyle = 'rgba(255,255,255,0.35)'
    ctx.setLineDash([])
    ctx.stroke()
    ctx.restore()
  },
}
export const chartPlugins = [crosshairPlugin]

export function mkDataset(data: number[], color: string) {
  return {
    data,
    borderColor: color,
    backgroundColor(ctx: any) {
      const chart = ctx.chart
      const { chartArea, ctx: c } = chart
      if (!chartArea) return color.replace(',1)', ',0.15)')
      const grad = c.createLinearGradient(0, chartArea.top, 0, chartArea.bottom)
      grad.addColorStop(0, color.replace(',1)', ',0.28)'))
      grad.addColorStop(0.6, color.replace(',1)', ',0.08)'))
      grad.addColorStop(1, color.replace(',1)', ',0.0)'))
      return grad
    },
    fill: true,
    tension: 0.45,
    pointRadius: 0,
    pointHoverRadius: 4,
    pointBackgroundColor: color,
    pointBorderColor: 'rgba(14,14,28,0.85)',
    pointBorderWidth: 1.5,
    borderWidth: 1.5,
  }
}

export function lineOpts(isTok: boolean) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false as const,
    interaction: { mode: 'index' as const, intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        mode: 'index' as const,
        intersect: false,
        displayColors: false,
        backgroundColor: 'rgba(10,10,22,0.92)',
        borderColor: 'rgba(255,255,255,0.08)',
        borderWidth: 1,
        titleColor: 'rgba(255,255,255,0.45)',
        bodyColor: 'rgba(255,255,255,0.85)',
        padding: 10,
        callbacks: isTok
          ? { label: (ctx: any) => fmtTok(ctx.raw) }
          : { label: (ctx: any) => String(ctx.raw) },
      },
    },
    scales: {
      x: {
        grid:   { color: 'rgba(255,255,255,0.04)' },
        border: { color: 'transparent' },
        ticks:  { color: 'rgba(255,255,255,0.25)', font: { size: 10 }, maxTicksLimit: 8 },
      },
      y: {
        grid:   { color: 'rgba(255,255,255,0.04)' },
        border: { color: 'transparent' },
        ticks:  {
          color: 'rgba(255,255,255,0.25)', font: { size: 10 },
          callback: isTok ? (v: any) => fmtTok(v) : undefined,
        },
        beginAtZero: true,
      },
    },
  }
}

export const donutOpts = {
  responsive: true,
  maintainAspectRatio: true,
  cutout: '68%',
  plugins: {
    legend: { display: false },
    tooltip: {
      backgroundColor: 'rgba(15,15,30,0.95)',
      borderColor: 'rgba(255,255,255,0.1)',
      borderWidth: 1,
      titleColor: 'rgba(255,255,255,0.6)',
      bodyColor: 'rgba(255,255,255,0.85)',
      padding: 10,
    },
  },
}
