import { createApp } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useDateScrubberMotion } from './useDateScrubberMotion'

describe('useDateScrubberMotion', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('时间轴开始新拖拽时可中止松手后的滑杆弹簧，不再持续发出旧位置', () => {
    const frames = new Map<number, FrameRequestCallback>()
    let nextFrameId = 0
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const id = ++nextFrameId
      frames.set(id, callback)
      return id
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))

    let motion!: ReturnType<typeof useDateScrubberMotion>
    const positions: number[] = []
    const app = createApp({
      setup() {
        motion = useDateScrubberMotion({
          getCount: () => 8,
          onPosition: position => positions.push(position),
          onSettled: () => undefined,
        })
        return () => null
      },
    })
    app.mount(document.createElement('div'))

    motion.settleTo(4)
    const [firstId, firstFrame] = frames.entries().next().value!
    frames.delete(firstId)
    firstFrame(16)
    expect(positions.at(-1)).toBeGreaterThan(0)

    const staleFrame = frames.values().next().value!
    const emittedBeforeInterrupt = positions.length
    motion.stopMotion()

    expect(frames.size).toBe(0)
    expect(motion.animating.value).toBe(false)
    // 即使已取出的旧回调恰好又被浏览器调度，也不能再写时间轴位置。
    staleFrame(32)
    expect(positions).toHaveLength(emittedBeforeInterrupt)

    app.unmount()
  })
})
