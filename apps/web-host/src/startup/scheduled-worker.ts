import { setTimeout as sleep } from 'node:timers/promises'
import { createRedisAgentCancellationCommands } from '../adapters/cache/redis-events.js'
import { createRedisLiveSubscription } from '../adapters/cache/redis-live-subscription.js'

const channel = 'gugu:scheduled-tasks:refresh'

/** 提交后的唤醒只传信号，数据库仍是任务状态的事实来源。 */
export async function notifyScheduledTaskWorker(redisUrl: string): Promise<void> {
  try { await createRedisAgentCancellationCommands(redisUrl).publish(channel, 'refresh') }
  catch { console.error('定时任务调度唤醒失败，将在下次协调时重读') }
}

export async function startScheduledTaskRefresh(redisUrl: string, refresh: () => Promise<void>) {
  const subscribe = createRedisLiveSubscription(redisUrl)
  const controller = new AbortController()
  const { signal } = controller
  const initial = await subscribe([channel])

  async function consume() {
    let subscription = initial
    while (!signal.aborted) {
      try {
        while (await subscription.next(signal)) await refresh()
      } catch {
        if (!signal.aborted) console.error('定时任务调度订阅中断')
      } finally {
        await subscription.close()
      }
      if (signal.aborted) break
      while (!signal.aborted) {
        try {
          await sleep(1000, undefined, { signal })
          subscription = await subscribe([channel])
          break
        } catch {
          if (signal.aborted) return
        }
      }
      if (signal.aborted) await subscription.close()
      else {
        try { await refresh() } catch { console.error('定时任务调度协调失败') }
      }
    }
  }

  const running = consume()
  return async () => { controller.abort(); await running }
}
