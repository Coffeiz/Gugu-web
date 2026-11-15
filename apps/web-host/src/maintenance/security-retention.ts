import type { Pool } from 'pg'

/** 不访问用户配置；只删除到期安全事件。 */
export async function cleanupExpiredSecurityEvents(pool: Pick<Pool, 'query'>, now: Date): Promise<number> {
  const result = await pool.query('DELETE FROM security_events WHERE expires_at <= $1', [now])
  return result.rowCount ?? 0
}

/** 首轮及后续均等待间隔；停止时等待在途清理结束。 */
export function startSecurityRetentionWorker(options: {
  pool: Pick<Pool, 'query'>
  intervalMs?: number
  now?: () => Date
  onError(): void
}): { stop(): Promise<void> } {
  const interval = options.intervalMs ?? 3_600_000
  if (!Number.isSafeInteger(interval) || interval < 1) throw new RangeError('清理间隔无效')
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let wake: (() => void) | undefined
  const wait = () => new Promise<void>(resolve => {
    wake = resolve
    timer = setTimeout(resolve, interval)
    timer.unref()
  })
  const running = (async () => {
    while (!stopped) {
      await wait()
      if (stopped) break
      try { await cleanupExpiredSecurityEvents(options.pool, options.now?.() ?? new Date()) }
      catch { try { options.onError() } catch { /* 诊断失败不能终止后续清理 */ } }
    }
  })()
  return { async stop() { stopped = true; if (timer) clearTimeout(timer); wake?.(); await running } }
}
