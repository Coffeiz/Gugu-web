import { ref } from 'vue'
import { describe, expect, it } from 'vitest'
import { useMindCanvas } from './useMindCanvas'

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
})
