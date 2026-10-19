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
