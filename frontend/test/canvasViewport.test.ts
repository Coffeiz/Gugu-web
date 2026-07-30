import { describe, expect, it } from 'vitest'
import { overlapsWorldRect, worldViewport } from '@/utils/canvasViewport'

describe('canvas viewport window', () => {
  it('将屏幕缓冲区正确换算为世界坐标', () => {
    expect(worldViewport({ x: 500, y: 300, scale: 2, width: 1000, height: 600 }, 200))
      .toEqual({ left: -350, top: -250, right: 350, bottom: 250 })
  })

  it('保留与窗口边缘相交的卡片，裁掉完全在窗口外的卡片', () => {
    const viewport = { left: 0, top: 0, right: 100, bottom: 100 }
    expect(overlapsWorldRect({ x: -20, y: 30, w: 24, h: 20 }, viewport)).toBe(true)
    expect(overlapsWorldRect({ x: 101, y: 30, w: 20, h: 20 }, viewport)).toBe(false)
  })
})
