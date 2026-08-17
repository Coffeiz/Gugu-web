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
})
