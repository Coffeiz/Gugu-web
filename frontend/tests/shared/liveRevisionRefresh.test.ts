// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import { watchDebouncedRevision } from '@/composables/shared/liveRevisionRefresh'

afterEach(() => vi.useRealTimers())

describe('实时资源 revision 刷新', () => {
  it('revision 补刷触发权威刷新，并合并短时间内的连续变化', async () => {
    vi.useFakeTimers()
    const revision = ref(0)
    const refresh = vi.fn()
    const stop = watchDebouncedRevision(() => revision.value, refresh, 120)

    revision.value += 1
    await nextTick()
    vi.advanceTimersByTime(80)
    revision.value += 1
    await nextTick()
    vi.advanceTimersByTime(119)
    expect(refresh).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(refresh).toHaveBeenCalledOnce()

    stop()
    revision.value += 1
    await nextTick()
    vi.advanceTimersByTime(120)
    expect(refresh).toHaveBeenCalledOnce()
  })
})
