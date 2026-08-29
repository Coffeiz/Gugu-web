import { describe, expect, it } from 'vitest'
import {
  beginMindLanding,
  endMindLanding,
  isMindLandingActive,
  onMindLandingSettled,
} from './canvas'

describe('Mind landing 与实时刷新协调器', () => {
  it('所有 landing 结束后才通知等待中的刷新', async () => {
    const settled: string[] = []
    const stop = onMindLandingSettled(() => settled.push('settled'))

    beginMindLanding('drawer:1')
    beginMindLanding('canvas:2')
    expect(isMindLandingActive()).toBe(true)

    endMindLanding('drawer:1')
    expect(settled).toEqual([])
    endMindLanding('canvas:2')
    expect(settled).toEqual([])
    expect(isMindLandingActive()).toBe(true)

    await new Promise(resolve => setTimeout(resolve, 40))
    expect(settled).toEqual(['settled'])
    expect(isMindLandingActive()).toBe(false)

    stop()
    endMindLanding('missing')
    expect(settled).toEqual(['settled'])
  })
})
