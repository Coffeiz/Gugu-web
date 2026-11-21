import { setTimeout as delay } from 'node:timers/promises'

/** 给在途运行留出提交终态的时间，再取消仍在执行的运行并等待释放资源。 */
export async function drainAgentRuns(tasks: readonly Promise<unknown>[], cancelRemaining: () => Promise<unknown>): Promise<void> {
  if (!tasks.length) return
  const drained = Promise.allSettled(tasks)
  const timer = new AbortController()
  try {
    const finished = await Promise.race([
      drained.then(() => true),
      delay(1_000, false, { signal: timer.signal, ref: false }),
    ])
    if (!finished) {
      try { await cancelRemaining() }
      finally { await drained }
    }
  } finally { timer.abort() }
}
