import { matchesCronMinute } from './cron-trigger.js'
import { nextIntervalFire } from './interval-trigger.js'
import type { ScheduledFire } from './repeating-dispatch.js'

export interface RepeatingSchedule {
  id: string
  kind: 'cron' | 'interval'
  cron: string
  intervalMinutes: number | null
  startAt: number | null
  createdAt: number
  endAt: number | null
}

/** 只选择时间窗口内最后一次触发，避免暂停期间批量重放。 */
export function dueRepeatingFire(task: RepeatingSchedule, now: number, lookbackMs: number): ScheduledFire | null {
  if (!Number.isFinite(now) || !Number.isFinite(lookbackMs) || lookbackMs < 0) throw new RangeError('调度窗口无效')
  const lower = Math.max(now - lookbackMs, task.startAt ?? -Infinity)
  const upper = Math.min(now, task.endAt ?? Infinity)
  if (lower > upper) return null
  let candidate: number | null = null
  if (task.kind === 'interval') {
    const anchor = task.startAt ?? task.createdAt
    const step = (task.intervalMinutes ?? 0) * 60_000
    const first = nextIntervalFire({ intervalMinutes: task.intervalMinutes ?? 0, startAt: anchor, endAt: task.endAt, after: lower })
    if (first !== null && first <= upper) candidate = first + Math.floor((upper - first) / step) * step
  } else {
    for (let at = Math.floor(upper / 60_000) * 60_000; at >= lower; at -= 60_000) {
      if (matchesCronMinute(task.cron, at)) { candidate = at; break }
    }
  }
  return candidate === null ? null : { taskId: task.id, fireAt: candidate }
}

/** 试验性轮询：回看窗口与 Python 的 1 秒 misfire 容限不同，不得装配生产。 */
export function createRepeatingPoller(options: {
  list(): Promise<RepeatingSchedule[]>
  dispatch(fire: ScheduledFire): Promise<unknown>
  onError(error: unknown): void
  intervalMs?: number
  lookbackMs?: number
  now?(): number
}) {
  const interval = options.intervalMs ?? 30_000
  const lookback = options.lookbackMs ?? 60_000
  if (!Number.isSafeInteger(interval) || interval < 1 || !Number.isSafeInteger(lookback) || lookback < 0 || lookback > 86_400_000)
    throw new RangeError('轮询间隔或窗口无效')
  let stopped = true
  let timer: ReturnType<typeof setTimeout> | undefined
  let current: Promise<void> = Promise.resolve()
  const report = (error: unknown) => { try { options.onError(error) } catch { /* 诊断失败不影响调度 */ } }
  const tick = async () => {
    try {
      const now = options.now?.() ?? Date.now()
      for (const task of await options.list()) {
        if (stopped) break
        try {
          const fire = dueRepeatingFire(task, now, lookback)
          if (fire) await options.dispatch(fire)
        } catch (error) { report(error) }
      }
    } catch (error) { report(error) }
    if (!stopped) timer = setTimeout(() => { current = tick() }, interval)
  }
  return {
    start() { if (!stopped) return; stopped = false; current = tick() },
    async stop() { stopped = true; if (timer) clearTimeout(timer); await current },
  }
}
