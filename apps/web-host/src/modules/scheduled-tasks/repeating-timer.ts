import { nextCronFire } from './cron-trigger.js'
import { nextIntervalFire } from './interval-trigger.js'
import type { RepeatingTask, ScheduledFire } from '@gugu/core/scheduled-task-run-now'

type RepeatingSchedule = Omit<RepeatingTask, 'userId' | 'version'>
type TimerSchedule = RepeatingSchedule | { id: string; kind: 'once'; startAt: number }

const maxTimerDelay = 2 ** 31 - 1

/** 计算严格晚于指定时刻的触发；无匹配时等待下一次 reconcile。 */
export function nextRepeatingFire(task: RepeatingSchedule, after: number): number | null {
  const lower = Math.max(after + 1, task.startAt ?? -Infinity)
  if (task.kind === 'interval') return nextIntervalFire({ intervalMinutes: task.intervalMinutes ?? 0,
    startAt: task.startAt ?? task.createdAt, endAt: task.endAt, after: lower })
  return nextCronFire(task.cron, lower, task.endAt)
}

/** 定时器只负责触发。调用方持任务租约复核当前计划。 */
export function createScheduledTaskTimer<Task extends TimerSchedule>(options: {
  list(): Promise<readonly Task[]>
  dispatch(fire: ScheduledFire, task: Task): Promise<unknown>
  onError(error: unknown): void
  now(): number
  setTimer(callback: () => void, delay: number): unknown
  clearTimer(handle: unknown): void
  reconcileMs?: number
}) {
  const interval = options.reconcileMs ?? 30_000
  if (!Number.isSafeInteger(interval) || interval < 1) throw new RangeError('调度协调间隔无效')
  let stopped = true
  let generation = 0
  let current: Promise<void> = Promise.resolve()
  let reconcileHandle: unknown
  const jobs = new Map<string, { signature: string; handle: unknown }>()
  const inflight = new Set<Promise<unknown>>()
  const report = (error: unknown) => { try { options.onError(error) } catch { /* 诊断失败不影响其他任务 */ } }
  const schedule = (task: Task, after: number, epoch: number) => {
    const next = task.kind === 'once'
      ? (task.startAt >= after - 1000 ? task.startAt : null)
      : nextRepeatingFire(task, after)
    if (next === null) { jobs.delete(task.id); return }
    const signature = JSON.stringify(task)
    const job: { signature: string; handle: unknown } = { signature, handle: undefined }
    const arm = () => {
      job.handle = options.setTimer(() => {
        if (stopped || generation !== epoch || jobs.get(task.id) !== job) return
        const now = options.now()
        if (now < next) {
          try { arm() } catch (error) { jobs.delete(task.id); report(error) }
          return
        }
        jobs.delete(task.id)
        if (now - next <= 1000) {
          const work = Promise.resolve().then(() => options.dispatch({ taskId: task.id, fireAt: next }, task)).catch(report)
          inflight.add(work)
          void work.finally(() => inflight.delete(work))
        }
        if (task.kind !== 'once') {
          try { schedule(task, now, epoch) } catch (error) { report(error) }
        }
      }, Math.min(maxTimerDelay, Math.max(1, next - options.now())))
    }
    arm()
    jobs.set(task.id, job)
  }
  const reconcile = async (epoch: number) => {
    try {
      const tasks = await options.list()
      if (stopped || generation !== epoch) return
      const ids = new Set(tasks.map(task => task.id))
      for (const [id, job] of jobs) if (!ids.has(id)) { options.clearTimer(job.handle); jobs.delete(id) }
      for (const task of tasks) {
        const old = jobs.get(task.id)
        if (old?.signature === JSON.stringify(task)) continue
        if (old) options.clearTimer(old.handle)
        try { schedule(task, options.now(), epoch) } catch (error) { jobs.delete(task.id); report(error) }
      }
    } catch (error) { report(error) }
    if (!stopped && generation === epoch) {
      const handle = options.setTimer(() => {
        if (!stopped && generation === epoch && reconcileHandle === handle) {
          reconcileHandle = undefined
          current = reconcile(epoch)
        }
      }, Math.min(maxTimerDelay, interval))
      reconcileHandle = handle
    }
  }
  return {
    start() { if (stopped) { stopped = false; current = reconcile(++generation) } },
    /** 提交后立即重新读取，避免新任务在下次周期扫描前到期。 */
    refresh() {
      if (stopped) return Promise.resolve()
      const epoch = generation
      if (reconcileHandle !== undefined) options.clearTimer(reconcileHandle)
      reconcileHandle = undefined
      current = current.then(async () => {
        if (stopped || generation !== epoch) return
        if (reconcileHandle !== undefined) options.clearTimer(reconcileHandle)
        reconcileHandle = undefined
        await reconcile(epoch)
      })
      return current
    },
    async stop() {
      stopped = true
      generation++
      const reconciling = current
      if (reconcileHandle !== undefined) options.clearTimer(reconcileHandle)
      reconcileHandle = undefined
      for (const job of jobs.values()) options.clearTimer(job.handle)
      jobs.clear()
      await Promise.allSettled([reconciling, ...inflight])
    },
  }
}

export const createRepeatingTimer = createScheduledTaskTimer
