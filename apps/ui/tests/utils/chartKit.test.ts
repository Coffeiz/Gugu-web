import { describe, expect, it } from 'vitest'
import { lineChartOptions } from '@/utils/chartKit'

describe('折线图数值轴上限', () => {
  it('百分比图表固定在 100，不因自动留白扩展到 150', () => {
    const options = lineChartOptions({ yMax: 100 })

    expect(options.scales.y).toMatchObject({ beginAtZero: true, max: 100 })
    expect(options.scales.y).not.toHaveProperty('grace')
  })

  it('无上限指标继续使用自动刻度和顶部留白', () => {
    const options = lineChartOptions()

    expect(options.scales.y).toMatchObject({ beginAtZero: true, grace: '5%' })
    expect(options.scales.y).not.toHaveProperty('max')
  })
})

it('多入口折线悬浮时显示分类和值，包括零次调用', () => {
  const { tooltip } = lineChartOptions({ showLegend: true }).plugins

  expect(tooltip.callbacks.label({ dataset: { label: 'QQ' }, raw: 17 })).toBe('QQ: 17')
  expect(tooltip.callbacks.label({ dataset: { label: '飞书' }, raw: 0 })).toBe('飞书: 0')
})
