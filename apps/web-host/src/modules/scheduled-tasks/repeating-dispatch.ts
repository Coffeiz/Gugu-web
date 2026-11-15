import type { ScheduledTaskLease } from '../../scheduled-task-runner.js'

export interface ScheduledFire {
  taskId: string
  fireAt: number
}

/** 收据必须原子认领同一任务的同一触发时间，未知结果不得自动重放。 */
export interface ScheduledFireReceipts {
  claim(fire: ScheduledFire, owner: string): Promise<boolean>
  finish(fire: ScheduledFire, owner: string, state: 'completed' | 'unknown'): Promise<void>
}

/** 重复任务的执行边界；调度器和执行器由 Host 明确注入。 */
export async function dispatchRepeatingFire(options: {
  fire: ScheduledFire
  owner: string
  lease: ScheduledTaskLease
  receipts: ScheduledFireReceipts
  /** 获锁后复核任务仍启用且当前调度仍包含此次触发。 */
  isCurrent(fire: ScheduledFire): Promise<boolean>
  execute(): Promise<void>
  leaseMs: number
}): Promise<'busy' | 'stale' | 'duplicate' | 'completed' | 'unknown'> {
  const { fire, owner, lease, receipts, leaseMs } = options
  if (!Number.isFinite(fire.fireAt) || !Number.isSafeInteger(leaseMs) || leaseMs < 1)
    throw new RangeError('定时任务触发时间或租约无效')
  if (!await lease.acquire(fire.taskId, owner, leaseMs)) return 'busy'
  let lost = false
  let renewal: Promise<void> = Promise.resolve()
  const timer = setInterval(() => {
    renewal = renewal.then(async () => {
      try { if (!await lease.renew(fire.taskId, owner, leaseMs)) lost = true }
      catch { lost = true }
    })
  }, Math.max(1, Math.floor(leaseMs / 3)))
  try {
    if (!await options.isCurrent(fire)) return 'stale'
    if (!await receipts.claim(fire, owner)) return 'duplicate'
    // 数据库查询和收据写入可能耗尽租约；开始外部副作用前再次确认所有权。
    await renewal
    let owned = false
    try { owned = !lost && await lease.renew(fire.taskId, owner, leaseMs) } catch { /* 无法确认租约 */ }
    if (!owned) {
      await receipts.finish(fire, owner, 'unknown')
      return 'unknown'
    }
    // 执行结果不明时保留收据，防止重启后重复产生外部副作用。
    try { await options.execute() }
    catch { await receipts.finish(fire, owner, 'unknown'); return 'unknown' }
    clearInterval(timer)
    await renewal
    if (lost || !await lease.renew(fire.taskId, owner, leaseMs)) {
      await receipts.finish(fire, owner, 'unknown')
      return 'unknown'
    }
    await receipts.finish(fire, owner, 'completed')
    return 'completed'
  } finally {
    clearInterval(timer)
    await renewal
    await lease.release(fire.taskId, owner)
  }
}
