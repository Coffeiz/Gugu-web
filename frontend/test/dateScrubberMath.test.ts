import { describe, expect, it } from 'vitest'
import {
  clampScrubberPosition, detentPosition, pitchAt, positionForIndex,
  elasticPosition, rubberBandPosition, slotOpacity, tickVisual,
} from '@/views/Mind/utils/dateScrubberMath'

describe('dateScrubberMath', () => {
  it('限制逻辑位置并在两端施加有界橡皮筋', () => {
    expect(clampScrubberPosition(-3, 5)).toBe(0)
    expect(clampScrubberPosition(8, 5)).toBe(4)
    expect(rubberBandPosition(-100, 5)).toBeGreaterThan(-0.7)
    expect(rubberBandPosition(100, 5)).toBeLessThan(4.7)
  })

  it('无边界橡皮筋持续移动，但越往外增量越小', () => {
    const near = elasticPosition(-1, 5)
    const far = elasticPosition(-10, 5)
    expect(far).toBeLessThan(near)
    expect(Math.abs(far - near)).toBeLessThan(9)
  })

  it('中心间距大于两侧，且位置随连续焦点连续变化', () => {
    expect(pitchAt(2, 2.5)).toBeGreaterThan(pitchAt(0, 2.5))
    expect(Math.abs(positionForIndex(3, 1.499, 8) - positionForIndex(3, 1.501, 8))).toBeLessThan(.1)
  })

  it('日期凹槽不越过相邻整数边界', () => {
    expect(detentPosition(.25, 5)).toBeGreaterThan(0)
    expect(detentPosition(.25, 5)).toBeLessThan(1)
    expect(detentPosition(1.75, 5)).toBeGreaterThan(1)
    expect(detentPosition(1.75, 5)).toBeLessThan(2)
  })

  it('窗口边缘淡出与刻度视觉值都是连续的', () => {
    expect(slotOpacity(9, 0)).toBeLessThan(slotOpacity(8, 0))
    const before = tickVisual(0, -.2, 6, null)
    const after = tickVisual(0, -.21, 6, null)
    expect(Math.abs(before.tipOpacity - after.tipOpacity)).toBeLessThan(.03)
    expect(Math.abs(before.barHeight - after.barHeight)).toBeLessThan(.1)
  })

  it('边缘橡皮筋只缩短刻度，不把当前日期和标签改成半透明', () => {
    const edge = tickVisual(0, -.35, 4, null)
    expect(edge.tipOpacity).toBe(1)
    expect(edge.barOpacity).toBeLessThan(1)
    expect(edge.barOpacity).toBeGreaterThan(.6)
    expect(edge.barHeight).toBeLessThan(22)
    expect(edge.emphasized).toBe(true)
    expect(edge.emphasisAlpha).toBeLessThan(1)
  })

  it('标签保持选中态实色，跨中点才交给下一日期', () => {
    const left = tickVisual(0, .49, 4, null)
    const right = tickVisual(1, .49, 4, null)
    const next = tickVisual(1, .51, 4, null)
    expect(left.tipOpacity).toBe(1)
    expect(right.tipOpacity).toBe(0)
    expect(next.tipOpacity).toBe(1)
  })
})
