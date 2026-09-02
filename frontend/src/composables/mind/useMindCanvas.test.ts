import { ref } from 'vue'
import { describe, expect, it } from 'vitest'
import { pickRelationAnchorSides, useMindCanvas } from './useMindCanvas'

describe('mind canvas relation anchors', () => {
  it('uses one outer side for vertically stacked cards', () => {
    expect(pickRelationAnchorSides(
      { x: 100, y: 0, w: 240, h: 120 },
      { x: 100, y: 180, w: 240, h: 120 },
    )).toEqual({ srcSide: 'right', dstSide: 'right' })
  })

  it('keeps opposite sides for horizontally separated cards', () => {
    expect(pickRelationAnchorSides(
      { x: 0, y: 0, w: 240, h: 120 },
      { x: 300, y: 180, w: 240, h: 120 },
    )).toEqual({ srcSide: 'right', dstSide: 'left' })
  })
})

describe('useMindCanvas pan state', () => {
  it('reuses the same camera pan math without pointer capture', () => {
    const viewport = ref<HTMLElement | null>(null)
    const { camera, startPan, panMove, panEnd } = useMindCanvas(viewport)

    startPan({ pointerId: -1, clientX: 100, clientY: 80 }, false)
    expect(panMove({ pointerId: -1, clientX: 132, clientY: 61 })).toBe(true)
    expect(camera.x).toBe(32)
    expect(camera.y).toBe(-19)
    expect(panEnd({ pointerId: -1, clientX: 132, clientY: 61 })).toBe(true)
    expect(panMove({ pointerId: -1, clientX: 140, clientY: 70 })).toBe(false)
  })

  it('keeps ordinary pan transient until commit while coordinate conversion follows the visual camera', () => {
    const viewport = ref<HTMLElement | null>(null)
    const { camera, startPan, panMove, panPosition, commitPan, panEnd, screenToWorld } = useMindCanvas(viewport)

    startPan({ pointerId: 7, clientX: 40, clientY: 30 }, false)
    expect(panMove({ pointerId: 7, clientX: 140, clientY: 80 }, false)).toBe(true)

    expect(camera.x).toBe(0)
    expect(camera.y).toBe(0)
    expect(panPosition()).toEqual({ x: 100, y: 50 })
    expect(screenToWorld(100, 50)).toEqual({ x: 0, y: 0 })

    expect(commitPan()).toBe(true)
    expect(camera.x).toBe(100)
    expect(camera.y).toBe(50)
    expect(panEnd({ pointerId: 7, clientX: 140, clientY: 80 }, false)).toBe(true)
  })

  it('rebases the pan origin after a committed buffer rebase', () => {
    const viewport = ref<HTMLElement | null>(null)
    const { camera, startPan, panMove, panEnd } = useMindCanvas(viewport)

    startPan({ pointerId: 8, clientX: 0, clientY: 0 }, false)
    expect(panMove({ pointerId: 8, clientX: 220, clientY: 140 }, false)).toBe(true)
    expect(panMove({ pointerId: 8, clientX: 220, clientY: 140 })).toBe(true)
    expect(camera.x).toBe(220)
    expect(camera.y).toBe(140)

    // 提交后继续拖动只能增加新的位移，不应重新叠加 pointerdown 到旧 origin 的距离。
    expect(panMove({ pointerId: 8, clientX: 230, clientY: 150 }, false)).toBe(true)
    expect(panEnd({ pointerId: 8, clientX: 230, clientY: 150 })).toBe(true)
    expect(camera.x).toBe(230)
    expect(camera.y).toBe(150)
  })

  it('keeps the grabbed point stable when zooming during a pan', () => {
    const viewport = ref<HTMLElement | null>(null)
    const { camera, startPan, panMove, zoomAt, panEnd } = useMindCanvas(viewport)

    startPan({ pointerId: 9, clientX: 100, clientY: 100 }, false)
    expect(panMove({ pointerId: 9, clientX: 150, clientY: 125 }, false)).toBe(true)
    zoomAt(200, 175, 2)

    // 缩放后的下一次移动从最新指针位置继续，不能跳回旧的 pointerdown 基线。
    expect(panMove({ pointerId: 9, clientX: 160, clientY: 135 }, false)).toBe(true)
    expect(panEnd({ pointerId: 9, clientX: 160, clientY: 135 })).toBe(true)
    expect(camera.x).toBe(-15)
    expect(camera.y).toBe(-40)
  })
})
