import { watch } from 'vue'
import {
  BarController, BarElement, CategoryScale, Chart, LineController, LineElement, LinearScale, PointElement, Tooltip, type Plugin,
} from 'chart.js'
import { barChartOptions, chartThemeKey, lineChartOptions } from '@/utils/chartKit'

Chart.register(BarController, BarElement, CategoryScale, LineController, LineElement, LinearScale, PointElement, Tooltip)

const barValueLabels: Plugin<'line' | 'bar', (number | null)[]> = {
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
  const kind = root.dataset.smartChart === 'line' ? 'line' : 'bar'
  const unit = root.dataset.smartChartUnit ?? ''
  const color = () => {
    const computed = getComputedStyle(canvas).color
    const srgb = /^color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)\)$/.exec(computed)
    return srgb ? `rgb(${srgb.slice(1).map(channel => Math.round(Number(channel) * 255)).join(', ')})` : computed
  }
  const options = () => {
    const tooltipLabel = ({ raw }: { raw: unknown }) => raw == null ? '—' : `${raw}${unit}`
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
  const chart = new Chart<'line' | 'bar', (number | null)[], string>(context, {
    type: kind,
    data: { labels: [], datasets: [{
      type: kind, data: [], backgroundColor: color(), borderColor: color(),
      ...(kind === 'bar'
        ? { borderWidth: 0, borderRadius: 6, maxBarThickness: 48, categoryPercentage: 0.72 }
        : { borderWidth: 2, pointRadius: 3, spanGaps: false }),
    }] },
    options: options(),
    plugins: [barValueLabels],
  })
  function refresh() {
    const rows = [...root.querySelectorAll<HTMLElement>(':scope > details > ul > li[data-smart-point]')]
    const points = kind === 'line' ? rows : rows.filter(row => !row.hidden)
    const dataset = chart.data.datasets[0]
    const seriesColor = color()
    chart.data.labels = points.map(row => row.firstElementChild?.textContent ?? '')
    dataset.data = points.map(row => row.hidden || row.dataset.smartCompare === undefined ? null : Number(row.dataset.smartCompare))
    dataset.borderColor = seriesColor
    dataset.backgroundColor = seriesColor
    if (dataset.type === 'line') {
      dataset.pointBackgroundColor = seriesColor
      dataset.pointBorderColor = seriesColor
    }
    const empty = !dataset.data.some(value => value !== null)
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
