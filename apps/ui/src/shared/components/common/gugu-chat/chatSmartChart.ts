import { watch } from 'vue'
import {
  ArcElement, BarController, BarElement, CategoryScale, Chart, LineController, LineElement, LinearScale, PieController, PointElement, Tooltip, type Plugin, type TooltipItem,
} from 'chart.js'
import { barChartOptions, chartThemeKey, lineChartOptions } from '@/utils/chartKit'

declare module 'chart.js' {
  interface ChartTypeRegistry {
    smartPie: ChartTypeRegistry['pie']
  }
}

class SmartPieArc extends ArcElement {
  static id = 'smartPieArc'

  draw(ctx: CanvasRenderingContext2D) {
    if (this.circumference <= 0 || this.circumference >= 2 * Math.PI - 1e-10) {
      super.draw(ctx)
      return
    }

    const { x, y, outerRadius } = this
    const reach = outerRadius + 8
    const halfGap = 1.5
    const halfPlane = (angle: number) => {
      const dx = Math.cos(angle)
      const dy = Math.sin(angle)
      ctx.moveTo(x - dx * reach - dy * halfGap, y - dy * reach + dx * halfGap)
      ctx.lineTo(x + dx * reach - dy * halfGap, y + dy * reach + dx * halfGap)
      ctx.lineTo(x + dx * reach - dy * reach, y + dy * reach + dx * reach)
      ctx.lineTo(x - dx * reach - dy * reach, y - dy * reach + dx * reach)
      ctx.closePath()
    }

    // 半圆以内取两侧的交集，超过半圆取并集。每侧让出相同的像素宽度。
    ctx.save()
    ctx.beginPath()
    halfPlane(this.startAngle)
    if (this.circumference <= Math.PI) {
      ctx.clip()
      ctx.beginPath()
    }
    halfPlane(this.endAngle + Math.PI)
    ctx.clip()
    super.draw(ctx)
    ctx.restore()
  }
}

class SmartPieController extends PieController {
  static id = 'smartPie'
  static defaults = { ...PieController.defaults, dataElementType: SmartPieArc.id }

  setHoverStyle(arc: ArcElement, datasetIndex: number, index: number) {
    super.setHoverStyle(arc, datasetIndex, index)
    this.updateElement(arc, index, { outerRadius: this.outerRadius + 4 }, 'active')
  }

  removeHoverStyle(arc: ArcElement, datasetIndex: number, index: number) {
    super.removeHoverStyle(arc, datasetIndex, index)
    this.updateElement(arc, index, { outerRadius: this.outerRadius }, 'active')
  }
}

Chart.register(SmartPieArc, ArcElement, BarController, BarElement, CategoryScale, LineController, LineElement, LinearScale, SmartPieController, PointElement, Tooltip)

type SmartChartKind = 'line' | 'bar' | 'smartPie'

const piePalette = [
  '#7487C4', '#68A69F', '#DAAC74', '#AC8ABF', '#D194A2', '#79A8C3',
  '#99A978', '#B68C78', '#828AB1', '#65A6B2', '#C598B5', '#C4A26A',
] as const

const barValueLabels: Plugin<SmartChartKind> = {
  id: 'smart-view-bar-values',
  afterDatasetsDraw(chart) {
    const dataset = chart.data.datasets[0]
    if (dataset?.type !== 'bar' || dataset.data.length > 8) return
    const { ctx, chartArea } = chart
    const bars = chart.getDatasetMeta(0).data
    const style = getComputedStyle(chart.canvas)
    ctx.save()
    ctx.font = `600 11px ${style.fontFamily}`
    ctx.fillStyle = style.getPropertyValue('--content-secondary').trim()
    ctx.textAlign = 'center'
    for (const [index, bar] of bars.entries()) {
      const value = dataset.data[index]
      if (typeof value !== 'number') continue
      const label = String(value)
      if (ctx.measureText(label).width + 8 > chartArea.width / bars.length) continue
      ctx.textBaseline = value < 0 ? 'top' : 'bottom'
      ctx.fillText(label, bar.x, bar.y + (value < 0 ? 5 : -5))
    }
    ctx.restore()
  },
}

export function mountSmartChart(root: HTMLElement) {
  const canvas = root.querySelector('canvas')
  const frame = canvas?.parentElement
  const context = canvas?.getContext('2d')
  if (!canvas || !context || !frame) {
    if (frame) frame.hidden = true
    return () => {}
  }
  const kind = root.dataset.smartChart === 'pie' ? 'smartPie' : root.dataset.smartChart === 'line' ? 'line' : 'bar'
  const unit = root.dataset.smartChartUnit ?? ''
  const legend = root.querySelector<HTMLElement>('[data-smart-pie-legend]')
  const percent = new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 1 })
  const color = () => {
    const computed = getComputedStyle(canvas).color
    const srgb = /^color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)\)$/.exec(computed)
    return srgb ? `rgb(${srgb.slice(1).map(channel => Math.round(Number(channel) * 255)).join(', ')})` : computed
  }
  const options = () => {
    const tooltipLabel = ({ raw }: { raw: unknown }) => raw == null ? '—' : `${raw}${unit}`
    if (kind === 'smartPie') return {
      responsive: true, maintainAspectRatio: false,
      layout: { padding: 7 },
      animation: window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? false as const : { duration: 0, animateRotate: false, animateScale: false },
      transitions: { active: { animation: { duration: 180, easing: 'easeOutCubic' as const } } },
      plugins: { tooltip: { callbacks: {
        label: ({ raw, dataset }: TooltipItem<SmartChartKind>) => {
          const total = dataset.data.reduce<number>((sum, value) => sum + (typeof value === 'number' ? value : 0), 0)
          if (typeof raw !== 'number' || total <= 0) return tooltipLabel({ raw })
          return `${tooltipLabel({ raw })} (${(raw / total * 100).toFixed(1)}%)`
        },
      } } },
    }
    const horizontalAxis = <T extends { ticks: object }>(axis: T) => ({
      ...axis, ticks: { ...axis.ticks, maxRotation: 0, autoSkip: true },
    })
    if (kind === 'line') {
      const line = lineChartOptions({ tooltipLabel })
      return { ...line, scales: { ...line.scales, x: horizontalAxis(line.scales.x) } }
    }
    const bar = barChartOptions({ tooltipLabel })
    return {
      ...bar,
      layout: { padding: { top: 8, right: 6 } },
      scales: {
        ...bar.scales,
        x: horizontalAxis(bar.scales.x),
        y: {
          ...bar.scales.y, grace: '15%',
          border: { ...bar.scales.y.border, dash: [3, 4] },
          ticks: { ...bar.scales.y.ticks, precision: undefined, maxTicksLimit: 5 },
        },
      },
    }
  }
  const chart = new Chart<SmartChartKind, (number | null)[], string>(context, {
    type: kind,
    data: { labels: [], datasets: [{
      type: kind, data: [], backgroundColor: color(), borderColor: color(),
      ...(kind === 'bar'
        ? { borderWidth: 0, borderRadius: 6, maxBarThickness: 48, categoryPercentage: 0.72 }
        : kind === 'smartPie' ? { spacing: 0, offset: 0, hoverOffset: 0, borderWidth: 0, hoverBorderWidth: 0 }
          : { borderWidth: 2, pointRadius: 3, spanGaps: false }),
    }] },
    options: options(),
    plugins: [barValueLabels],
  })
  function highlightSlice(index?: number) {
    chart.setActiveElements(index === undefined ? [] : [{ datasetIndex: 0, index }])
    chart.render()
  }

  function refresh() {
    if (legend) chart.setActiveElements([])
    const rows = [...root.querySelectorAll<HTMLElement>(':scope > details > ul > li[data-smart-point]')]
    const points = kind === 'line' ? rows : rows.filter(row => !row.hidden)
    const dataset = chart.data.datasets[0]
    const seriesColor = color()
    chart.data.labels = points.map(row => row.firstElementChild?.textContent ?? '')
    dataset.data = points.map(row => row.hidden || row.dataset.smartCompare === undefined ? null : Number(row.dataset.smartCompare))
    dataset.borderColor = seriesColor
    dataset.backgroundColor = kind === 'smartPie'
      ? points.map(row => piePalette[rows.indexOf(row) % piePalette.length])
      : seriesColor
    if (dataset.type === 'line') {
      dataset.pointBackgroundColor = seriesColor
      dataset.pointBorderColor = seriesColor
    }
    const empty = !dataset.data.some(value => value !== null && (kind !== 'smartPie' || value > 0))
    if (legend && Array.isArray(dataset.backgroundColor)) {
      const colors = dataset.backgroundColor
      const total = dataset.data.reduce<number>((sum, value) => sum + (value ?? 0), 0)
      legend.hidden = empty
      legend.replaceChildren(...points.map((_, index) => {
        const item = document.createElement('li')
        const dot = document.createElement('span')
        dot.setAttribute('aria-hidden', 'true')
        dot.style.backgroundColor = String(colors[index])
        const label = document.createElement('span')
        label.textContent = chart.data.labels?.[index] ?? ''
        const share = document.createElement('strong')
        const value = dataset.data[index]
        share.textContent = value == null || total === 0 ? '—' : percent.format(value / total)
        if (value != null && value > 0) {
          item.addEventListener('pointerenter', () => highlightSlice(index))
          item.addEventListener('pointerleave', () => highlightSlice())
        }
        item.append(dot, label, share)
        return item
      }))
    }
    frame.hidden = empty
    const notice = root.querySelector<HTMLElement>(':scope > [data-smart-empty]')
    if (notice) notice.hidden = !empty
    chart.options = options()
    chart.update('none')
  }
  refresh()
  root.addEventListener('smart-chart-update', refresh)
  const stop = watch(chartThemeKey, refresh, { flush: 'post' })
  return () => {
    stop()
    root.removeEventListener('smart-chart-update', refresh)
    chart.destroy()
  }
}
