export interface AgentDispatchSubscription {
  next(signal: AbortSignal): Promise<unknown | null>
  close(): Promise<void>
}

export interface AgentDispatchSupervisorPorts {
  scanReady?(signal: AbortSignal): Promise<void>
  listReady(limit?: number): Promise<Array<{ ownerId: string; sessionId: string }>>
  kick(ownerId: string, sessionId: string): Promise<void>
  publish(channel: string, value: string): Promise<number>
  subscribe(channels: readonly string[]): Promise<AgentDispatchSubscription>
  diagnose(code: 'scan_failed' | 'worker_failed' | 'subscription_failed'): void
  recoveryIntervalMs?: number
  concurrency?: number
}

export const agentDispatchReadyChannel = 'agent-dispatch-ready:v1'

/** Agent dispatch 恢复编排；队列读取、唤醒传输和进程启停由 Host 注入/管理。 */
export function createAgentDispatchSupervisor(ports: AgentDispatchSupervisorPorts) {
  const interval = ports.recoveryIntervalMs ?? 30000, concurrency = ports.concurrency ?? 8
  if (!Number.isSafeInteger(interval) || interval < 1000 || !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 100) throw new RangeError('调度扫描配置无效')
  return {
    async notify(): Promise<void> { await ports.publish(agentDispatchReadyChannel, '1') },
    async start() {
      let live: AgentDispatchSubscription | null = null
      try { live = await ports.subscribe([agentDispatchReadyChannel]) } catch { ports.diagnose('subscription_failed') }
      const controller = new AbortController()
      const active = new Map<string, Promise<void>>()
      async function scan() {
        let ready: Array<{ ownerId: string; sessionId: string }>
        try { await ports.scanReady?.(controller.signal) } catch { ports.diagnose('scan_failed') }
        try { ready = await ports.listReady(100) } catch { ports.diagnose('scan_failed'); return }
        for (const item of ready) {
          if (controller.signal.aborted || active.size >= concurrency) break
          const key = JSON.stringify([item.ownerId, item.sessionId])
          if (active.has(key)) continue
          const task = ports.kick(item.ownerId, item.sessionId).catch(() => { ports.diagnose('worker_failed') }).finally(() => { active.delete(key) })
          active.set(key, task)
        }
      }
      const loop = (async () => {
        try {
          while (!controller.signal.aborted) {
            await scan()
            if (!live) {
              try { live = await ports.subscribe([agentDispatchReadyChannel]) } catch { ports.diagnose('subscription_failed') }
            }
            const wait = new AbortController(), abort = () => wait.abort()
            controller.signal.addEventListener('abort', abort, { once: true })
            if (controller.signal.aborted) wait.abort()
            const timer = setTimeout(() => wait.abort(), interval)
            try {
              if (live) {
                const message = await live.next(wait.signal)
                if (!message && !wait.signal.aborted) { await live.close(); live = null; ports.diagnose('subscription_failed') }
              } else await new Promise<void>(resolve => { if (wait.signal.aborted) resolve(); else wait.signal.addEventListener('abort', () => resolve(), { once: true }) })
            } catch {
              if (!wait.signal.aborted) { await live?.close(); live = null; ports.diagnose('subscription_failed') }
            }
            finally { clearTimeout(timer); controller.signal.removeEventListener('abort', abort) }
          }
        } catch { if (!controller.signal.aborted) ports.diagnose('subscription_failed') }
        finally { await live?.close() }
      })()
      return { async stop() { controller.abort(); await loop }, async drain() { await Promise.allSettled([...active.values()]) } }
    },
  }
}
