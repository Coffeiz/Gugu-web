import { nextCronFire } from './cron.js'
import { nextIntervalFire } from './interval.js'
import type { RepeatingTask } from './repeating-repository.js'

export type RepeatingSchedule = Omit<RepeatingTask, 'userId' | 'version' | 'eventId'>

/** 计算严格晚于指定时刻的触发；无匹配时等待下一次 reconcile。 */
export function nextRepeatingFire(task: RepeatingSchedule, after: number): number | null {
  const lower = Math.max(after + 1, task.startAt ?? -Infinity)
  if (task.kind === 'interval') return nextIntervalFire({ intervalMinutes: task.intervalMinutes ?? 0,
    startAt: task.startAt ?? task.createdAt, endAt: task.endAt, after: lower })
  return nextCronFire(task.cron, lower, task.endAt)
}

