import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOnboardingProgressSaver } from '@/composables/onboarding/progressSaver'

afterEach(() => vi.useRealTimers())

describe('新手引导进度保存', () => {
  it('快速前进和后退只保存合并后的最新进度', async () => {
    vi.useFakeTimers()
    const update = vi.fn(async (patch: Record<string, unknown>) => ({ guide: patch }))
    const onSaved = vi.fn()
    const saver = createOnboardingProgressSaver(update, onSaved, 250)

    saver.enqueue({ current_step: 'features', completed_steps: ['locale'] })
    saver.enqueue({ current_step: 'style', completed_steps: ['locale', 'features'] })
    saver.enqueue({ current_step: 'features', dismissed: false })

    expect(update).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(250)

    expect(update).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledWith({
      current_step: 'features',
      completed_steps: ['locale', 'features'],
      dismissed: false,
    })
    expect(onSaved).toHaveBeenCalledTimes(1)
  })

  it('关闭时立即冲刷待保存进度，并与关闭状态合并为一个请求', async () => {
    vi.useFakeTimers()
    const update = vi.fn(async (patch: Record<string, unknown>) => ({ guide: patch }))
    const saver = createOnboardingProgressSaver(update, vi.fn(), 250)

    saver.enqueue({ current_step: 'im', completed_steps: ['locale', 'features', 'style', 'model'] })
    await saver.flush({ current_step: 'im', dismissed: true })

    expect(update).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledWith({
      current_step: 'im',
      completed_steps: ['locale', 'features', 'style', 'model'],
      dismissed: true,
    })
  })

  it('前一笔写入未结束时继续导航会串行保存最新状态，不并发覆盖', async () => {
    vi.useFakeTimers()
    let finishFirst!: (value: unknown) => void
    const update = vi.fn((patch: Record<string, unknown>) => {
      if (update.mock.calls.length === 1) {
        return new Promise(resolve => { finishFirst = resolve })
      }
      return Promise.resolve({ guide: patch })
    })
    const saver = createOnboardingProgressSaver(update, vi.fn(), 250)

    saver.enqueue({ current_step: 'features' })
    const firstFlush = saver.flush()
    saver.enqueue({ current_step: 'style', completed_steps: ['locale', 'features'] })
    const secondFlush = saver.flush()

    expect(update).toHaveBeenCalledTimes(1)
    finishFirst({ guide: { current_step: 'features' } })
    await Promise.all([firstFlush, secondFlush])

    expect(update).toHaveBeenCalledTimes(2)
    expect(update.mock.calls[1][0]).toEqual({
      current_step: 'style',
      completed_steps: ['locale', 'features'],
    })
  })

  it('A/B 对照：同样的 250ms API 延迟下，快速连续操作由多次等待变为一次合并保存', async () => {
    vi.useFakeTimers()
    const steps = ['features', 'style', 'model', 'im']
    const delayedUpdate = vi.fn((patch: Record<string, unknown>) => new Promise(resolve => {
      setTimeout(() => resolve({ guide: patch }), 250)
    }))

    const controlStart = Date.now()
    const controlRun = (async () => {
      for (const current_step of steps) await delayedUpdate({ current_step })
    })()
    await vi.advanceTimersByTimeAsync(1000)
    await controlRun
    const controlElapsed = Date.now() - controlStart
    const controlRequests = delayedUpdate.mock.calls.length

    delayedUpdate.mockClear()
    const saver = createOnboardingProgressSaver(delayedUpdate, vi.fn(), 250)
    const optimizedStart = Date.now()
    for (const current_step of steps) saver.enqueue({ current_step })
    const optimizedRun = saver.flush()
    await vi.advanceTimersByTimeAsync(250)
    await optimizedRun
    const optimizedElapsed = Date.now() - optimizedStart

    expect(controlRequests).toBe(4)
    expect(controlElapsed).toBe(1000)
    expect(delayedUpdate).toHaveBeenCalledTimes(1)
    expect(delayedUpdate).toHaveBeenCalledWith({ current_step: 'im' })
    expect(optimizedElapsed).toBe(250)
  })
})
