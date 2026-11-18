interface BackgroundWorker {
  stop(): Promise<void>
}

type StartWorker = () => BackgroundWorker | null | Promise<BackgroundWorker | null>

/** Host 停止并等待在途任务，确认旧实例退出后才启动新实例。 */
export function createBackgroundWorkerLifecycle(starters: readonly StartWorker[]) {
  let workers: BackgroundWorker[] = []
  let ready = false
  let closing = false
  let online = false
  let tail: Promise<unknown> = Promise.resolve()
  let restarting: Promise<boolean> | undefined

  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const operation = tail.then(work)
    tail = operation.catch(() => undefined)
    return operation
  }

  async function drain(): Promise<void> {
    online = false
    const results = await Promise.allSettled(workers.map(worker => Promise.resolve().then(() => worker.stop())))
    workers = workers.filter((_worker, index) => results[index]?.status === 'rejected')
    if (workers.length) throw new Error('后台任务停止失败')
  }

  async function startAll(): Promise<void> {
    try {
      for (const start of starters) {
        if (closing) break
        const worker = await start()
        if (worker) workers.push(worker)
      }
      online = workers.length > 0
    } catch (error) {
      await drain()
      throw error
    }
  }

  return {
    status: () => ({ online: online && !closing, restartable: ready && !closing && starters.length > 0 }),
    start: () => enqueue(async () => {
      if (ready || closing) return
      if (workers.length) await drain()
      await startAll()
      ready = true
    }),
    restart(): Promise<boolean> {
      if (!ready || closing || !starters.length) return Promise.resolve(false)
      restarting ??= enqueue(async () => {
        await drain()
        if (closing) return false
        await startAll()
        return !closing && online
      }).finally(() => { restarting = undefined })
      return restarting
    },
    stop() {
      closing = true
      return enqueue(drain)
    },
  }
}
