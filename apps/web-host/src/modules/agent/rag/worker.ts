export type RagIndexWorkerResult = 'idle' | 'ready' | 'retrying' | 'superseded'

export interface RagIndexWorkerOptions {
  enabled: boolean
  /** 一个调用只领取并完成一条持久任务；Worker 内部负责 generation 与租约 fencing。 */
  work(signal: AbortSignal): Promise<RagIndexWorkerResult>
  intervalMs?: number
  onError(error: unknown): void
}

/**
 * Web Host 的单消费者调度器。
 * ready/superseded 继续排空已到期任务；idle/retrying 才等待下一轮，避免空转。
 * 停止时取消当前读取并等待 Worker 退出，不并发启动第二轮。
 */
export function startRagIndexWorker(options: RagIndexWorkerOptions): { stop(): Promise<void> } {
  if (!options.enabled) return { async stop() {} }
  const interval = options.intervalMs ?? 1_000
  if (!Number.isSafeInteger(interval) || interval < 1) throw new RangeError('RAG Worker 间隔必须是正整数毫秒')

  const controller = new AbortController()
  let stopping = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let resolveWait: (() => void) | undefined
  const wait = () => new Promise<void>(resolve => {
    resolveWait = resolve
    timer = setTimeout(resolve, interval)
    timer.unref?.()
  })

  const task = (async () => {
    while (!stopping) {
      let result: RagIndexWorkerResult = 'idle'
      try {
        result = await options.work(controller.signal)
      } catch (error) {
        if (controller.signal.aborted) break
        options.onError(error)
      }
      if (stopping) break
      if (result === 'ready' || result === 'superseded') continue
      await wait()
    }
  })()

  return {
    async stop() {
      stopping = true
      controller.abort(new Error('RAG Worker 已停止'))
      if (timer) clearTimeout(timer)
      resolveWait?.()
      await task
    },
  }
}
