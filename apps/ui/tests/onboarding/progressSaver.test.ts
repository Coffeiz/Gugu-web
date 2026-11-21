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

  it('旧响应到达后继续导航不会回退本地进度或丢失已完成步骤', async () => {
    vi.useFakeTimers()
    let state = { current_step: 'features', completed_steps: ['locale'] }
    const responses: Array<(response: unknown) => void> = []
    const update = vi.fn((_patch: Record<string, unknown>) => new Promise(resolve => { responses.push(resolve) }))
    const saver = createOnboardingProgressSaver(update, response => {
      state = (response as { guide: typeof state }).guide
    })
    saver.enqueue(state)
    const saving = saver.flush()
    state = { current_step: 'style', completed_steps: ['locale', 'features'] }
    saver.enqueue(state)

    responses[0]({ guide: { current_step: 'features', completed_steps: ['locale'] } })
    await vi.advanceTimersByTimeAsync(0)
    expect(state.current_step).toBe('style')
    expect(state.completed_steps).toEqual(['locale', 'features'])

    state = { current_step: 'model', completed_steps: [...state.completed_steps, 'style'] }
    saver.enqueue(state)
    responses[1]({ guide: { current_step: 'style', completed_steps: ['locale', 'features'] } })
    await vi.advanceTimersByTimeAsync(0)
    expect(state.current_step).toBe('model')
    responses[2]({ guide: state })
    await saving
    expect(update.mock.calls.at(-1)).toEqual([{
      current_step: 'model', completed_steps: ['locale', 'features', 'style'],
    }])
    expect(state.completed_steps).toEqual(['locale', 'features', 'style'])
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
