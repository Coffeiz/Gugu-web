import { matchesCronMinute } from './cron-trigger.js'
import { nextIntervalFire } from './interval-trigger.js'
import type { RepeatingSchedule } from './repeating-poller.js'
import type { ScheduledFire } from './repeating-dispatch.js'

/** 计算严格晚于指定时刻的触发；无匹配时等待下一次 reconcile。 */
export function nextRepeatingFire(task: RepeatingSchedule, after: number): number | null {
  const lower = Math.max(after + 1, task.startAt ?? -Infinity)
  if (task.kind === 'interval') return nextIntervalFire({ intervalMinutes: task.intervalMinutes ?? 0,
    startAt: task.startAt ?? task.createdAt, endAt: task.endAt, after: lower })
  const limit = Math.min(task.endAt ?? Infinity, after + 366 * 86_400_000)
  for (let time = Math.ceil(lower / 60_000) * 60_000; time <= limit; time += 60_000)
    if (matchesCronMinute(task.cron, time)) return time
  return null
}

/** 未接入生产：调度触发后由调用方持租约复核任务及执行 fence。 */
export function createRepeatingTimer(options: {
  list(): Promise<RepeatingSchedule[]>
  dispatch(fire: ScheduledFire): Promise<unknown>
  onError(error: unknown): void
  now(): number
  setTimer(callback: () => void, delay: number): unknown
  clearTimer(handle: unknown): void
  reconcileMs?: number
}) {
  const interval = options.reconcileMs ?? 30_000
  if (!Number.isSafeInteger(interval) || interval < 1) throw new RangeError('调度协调间隔无效')
  let stopped = true
  let reconcileHandle: unknown
  const jobs = new Map<string, { signature: string; handle: unknown }>()
  const inflight = new Set<Promise<unknown>>()
  const report = (error: unknown) => { try { options.onError(error) } catch { /* 诊断失败不影响其他任务 */ } }
  const schedule = (task: RepeatingSchedule, after: number) => {
    const next = nextRepeatingFire(task, after)
    if (next === null) { jobs.delete(task.id); return }
    const signature = JSON.stringify(task)
    const handle = options.setTimer(() => {
      jobs.delete(task.id)
      if (stopped) return
      const now = options.now()
      if (now >= next && now - next <= 1000) {
        const work = options.dispatch({ taskId: task.id, fireAt: next }).catch(report)
        inflight.add(work)
        void work.finally(() => inflight.delete(work))
      }
      try { schedule(task, Math.max(next, now)) } catch (error) { report(error) }
    }, Math.max(0, next - options.now()))
    jobs.set(task.id, { signature, handle })
  }
  const reconcile = async () => {
    try {
      const tasks = await options.list()
      if (stopped) return
      const ids = new Set(tasks.map(task => task.id))
      for (const [id, job] of jobs) if (!ids.has(id)) { options.clearTimer(job.handle); jobs.delete(id) }
      for (const task of tasks) {
        const old = jobs.get(task.id)
        if (old?.signature === JSON.stringify(task)) continue
        if (old) options.clearTimer(old.handle)
        try { schedule(task, options.now()) } catch (error) { jobs.delete(task.id); report(error) }
      }
    } catch (error) { report(error) }
    if (!stopped) reconcileHandle = options.setTimer(() => { void reconcile() }, interval)
  }
  return {
    start() { if (stopped) { stopped = false; void reconcile() } },
    async stop() {
      stopped = true
      if (reconcileHandle !== undefined) options.clearTimer(reconcileHandle)
      for (const job of jobs.values()) options.clearTimer(job.handle)
      jobs.clear()
      await Promise.allSettled([...inflight])
    },
  }
}
