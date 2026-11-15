import type { ScheduledTaskRunner } from '../../scheduled-task-runner.js'

export interface OnceTaskPollerOptions {
  runner: ScheduledTaskRunner
  listDue(now: number): Promise<string[]>
  execute(taskId: string): Promise<Record<string, string>>
  onError(error: unknown): void
  intervalMs?: number
}

/** 一次性任务轮询器；执行与投递由 Host 显式注入。停止时等待当前轮结束。 */
export function createOnceTaskPoller(options: OnceTaskPollerOptions) {
  const interval = options.intervalMs ?? 30_000
  if (!Number.isSafeInteger(interval) || interval < 1) throw new RangeError('轮询间隔无效')
  let stopped = true
  let timer: ReturnType<typeof setTimeout> | undefined
  let current: Promise<void> = Promise.resolve()
  const report = (error: unknown) => { try { options.onError(error) } catch { /* 诊断失败不停止后续轮询 */ } }
  async function tick() {
    try {
      await options.runner.recoverAbandoned()
      for (const id of await options.listDue(Date.now())) {
        if (stopped) break
        try { await options.runner.runDue(id, () => options.execute(id)) } catch (error) { report(error) }
      }
    } catch (error) { report(error) }
    if (!stopped) timer = setTimeout(() => { current = tick() }, interval)
  }
  return {
    start() { if (!stopped) return; stopped = false; current = tick() },
    async stop() { stopped = true; if (timer) clearTimeout(timer); await current },
  }
}
