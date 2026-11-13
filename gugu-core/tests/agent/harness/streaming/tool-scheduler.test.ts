import { describe,expect,it } from 'vitest'
import { HarnessError,ParallelDispatchCancelled,runParallelDispatches } from "../../../../src/agent/harness/index.js"

describe('独立工具批次并发与共享取消', () => {
  it('并发不越过配置上限，结果保持模型顺序，单项异常不终止兄弟任务', async () => {
    let active = 0
    let peak = 0
    const controller = new AbortController()
    const result = await runParallelDispatches([0, 1, 2, 3, 4], async (id) => {
      active++
      peak = Math.max(peak, active)
      await Promise.resolve()
      active--
      if (id === 2) throw new Error('合成私有上游异常')
      return id
    }, { signal: controller.signal, maxConcurrency: 2 })
    expect(peak).toBe(2)
    expect(result.map((item) => item.status === 'completed' ? item.value : item.status)).toEqual([0, 1, 'error', 3, 4])
  })

  it('共享取消等待兄弟清理，保留完成回执，并跳过未启动工具', async () => {
    const controller = new AbortController()
    const finished: number[] = []
    const started: number[] = []
    let stopped = false
    let siblingStarted!: () => void
    const sibling = new Promise<void>((resolve) => { siblingStarted = resolve })
    try {
      await runParallelDispatches([0, 1, 2, 3], async (id, signal) => {
        started.push(id)
        if (id === 0) { finished.push(id); return id }
        if (id === 1) { await sibling; throw new HarnessError('cancelled', '任务取消') }
        siblingStarted()
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
        await Promise.resolve()
        stopped = true
        throw new HarnessError('cancelled', '兄弟任务回收')
      }, { signal: controller.signal, maxConcurrency: 3 })
      expect.unreachable('共享取消必须传播')
    } catch (error) {
      expect(error).toBeInstanceOf(ParallelDispatchCancelled)
      const cancellation = error as ParallelDispatchCancelled<number>
      expect(cancellation.results).toEqual([{ status: 'completed', value: 0 }, { status: 'cancelled' }, { status: 'cancelled' }, { status: 'deferred' }])
    }
    expect(started).toEqual([0, 1, 2])
    expect(finished).toEqual([0])
    expect(stopped).toBe(true)
  })

  it('取消前未启动的批次不执行；空批次不制造错误', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(runParallelDispatches([], async () => 1, { signal: controller.signal })).resolves.toEqual([])
    await expect(runParallelDispatches([0], async () => 1, { signal: controller.signal })).rejects.toMatchObject({ code: 'cancelled', results: [{ status: 'deferred' }] })
    await expect(runParallelDispatches([0], async () => 1, { signal: controller.signal, maxConcurrency: 0 })).rejects.toMatchObject({ code: 'invalid_state' })
  })
})
