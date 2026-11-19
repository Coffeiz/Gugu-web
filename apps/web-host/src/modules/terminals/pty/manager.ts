import type { MxcPtyBridge, MxcPtyHandle, MxcPtyLaunchSpec } from '@gugu/sandbox/pty'

interface ManagedPty {
  readonly terminalId: string
  readonly handle: MxcPtyHandle
  readonly cols: number
  readonly rows: number
  readonly queues: Set<AsyncQueue<Uint8Array | null>>
  outputBytes: number
  windowStarted: number
  windowBytes: number
  attached: number
  detachedAt: number | null
  outputTask: Promise<void>
}

export interface TerminalPtyQueue {
  take(): Promise<Uint8Array | null>
}

class AsyncQueue<T> {
  private values: T[] = []
  private readers: Array<(value: T) => void> = []
  private ended = false
  constructor(private readonly capacity = 256) {}
  push(value: T): boolean {
    if (this.ended) return false
    const reader = this.readers.shift()
    if (reader) reader(value)
    else if (this.values.length < this.capacity) this.values.push(value)
    else return false
    return true
  }
  finish(discard = false): void {
    if (this.ended) return
    this.ended = true
    if (discard) this.values = []
    if (this.values.length < this.capacity) this.values.push(null as T)
    else this.values[this.values.length - 1] = null as T
    for (const reader of this.readers.splice(0)) reader(this.values.shift()!)
  }
  async take(): Promise<T> {
    const value = this.values.shift()
    if (value !== undefined) return value
    if (this.ended) return null as T
    return new Promise(resolve => this.readers.push(resolve))
  }
}

/** 管理单 Web Host 实例持有的 MXC PTY，并限制输出与断线保留时间。 */
export function createTerminalPtyManager(options: {
  bridge: MxcPtyBridge
  now?: () => number
  detachedTtlMs?: number
  maxOutputBytes?: number
  maxOutputRateBytes?: number
  maxAttachedClients?: number
}) {
  const sessions = new Map<string, ManagedPty>()
  const lock = { tail: Promise.resolve() }
  const now = options.now ?? Date.now
  const ttl = options.detachedTtlMs ?? 900_000
  const maxBytes = options.maxOutputBytes ?? 120 * 1024
  const maxRate = options.maxOutputRateBytes ?? 256 * 1024
  const maxClients = options.maxAttachedClients ?? 2
  let reaper: ReturnType<typeof setInterval> | undefined

  async function exclusive<T>(work: () => Promise<T> | T): Promise<T> {
    const previous = lock.tail
    let release!: () => void
    lock.tail = new Promise<void>(resolve => { release = resolve })
    await previous
    try { return await work() } finally { release() }
  }
  function finishQueue(queue: AsyncQueue<Uint8Array | null>, discard = false) { queue.finish(discard) }
  function current(terminalId: string): ManagedPty {
    const session = sessions.get(terminalId)
    if (!session) throw new Error('PTY 终端不存在')
    return session
  }
  async function start(spec: MxcPtyLaunchSpec, subscribe = false) {
    return exclusive(async () => {
      if (sessions.has(spec.terminalId)) throw new Error('PTY 终端已经运行')
      const handle = await options.bridge.open(spec)
      const queue = subscribe ? new AsyncQueue<Uint8Array | null>() : null
      const session: ManagedPty = {
        terminalId: spec.terminalId, handle, cols: spec.cols, rows: spec.rows,
        queues: new Set(queue ? [queue] : []),
        outputBytes: 0, windowStarted: now(), windowBytes: 0, attached: 0,
        detachedAt: null, outputTask: Promise.resolve(),
      }
      sessions.set(spec.terminalId, session)
      session.outputTask = pump(session)
      return { session, queue }
    })
  }
  async function pump(session: ManagedPty): Promise<void> {
    let exceeded = false
    try {
      for await (const chunk of session.handle.output()) {
        if (!chunk.byteLength) continue
        const time = now()
        if (time - session.windowStarted >= 1000) {
          session.windowStarted = time
          session.windowBytes = 0
        }
        session.outputBytes += chunk.byteLength
        session.windowBytes += chunk.byteLength
        if (session.outputBytes > maxBytes || session.windowBytes > maxRate) {
          exceeded = true
          break
        }
        for (const queue of [...session.queues]) {
          if (!queue.push(chunk)) {
            session.queues.delete(queue)
            finishQueue(queue, true)
          }
        }
      }
    } catch {
      // MXC output failure ends this PTY; the request path will observe the closed queue.
    } finally {
      const ownsSession = sessions.get(session.terminalId) === session
      if (ownsSession) sessions.delete(session.terminalId)
      if (ownsSession || exceeded) {
        try { await session.handle.close() } catch { /* 退出回调不能伪装成仍可输入的 PTY。 */ }
      }
      for (const queue of session.queues) finishQueue(queue)
      session.queues.clear()
    }
  }
  return {
    async start(spec: MxcPtyLaunchSpec) { return (await start(spec)).session },
    async startWithSubscription(spec: MxcPtyLaunchSpec) {
      const result = await start(spec, true)
      return { session: result.session, queue: result.queue! }
    },
    get(terminalId: string) { return sessions.get(terminalId) },
    async attach(terminalId: string) {
      const session = current(terminalId)
      if (session.attached >= maxClients) throw new Error('PTY 活动连接数已达上限')
      session.attached += 1
      session.detachedAt = null
      return session
    },
    async subscribe(terminalId: string) {
      const session = current(terminalId)
      const queue = new AsyncQueue<Uint8Array | null>()
      session.queues.add(queue)
      return queue
    },
    async unsubscribe(terminalId: string, queue: TerminalPtyQueue) {
      const session = sessions.get(terminalId)
      if (!session) return
      for (const current of session.queues) {
        if (current !== queue) continue
        session.queues.delete(current)
        finishQueue(current, true)
        break
      }
    },
    async detach(terminalId: string) {
      const session = current(terminalId)
      session.attached = Math.max(0, session.attached - 1)
      if (!session.attached) session.detachedAt = now()
    },
    async write(terminalId: string, data: Uint8Array) {
      if (!data.byteLength) return
      const session = current(terminalId)
      if (!session.attached) throw new Error('PTY 没有活动连接')
      await session.handle.write(data)
    },
    async resize(terminalId: string, cols: number, rows: number) {
      const session = current(terminalId)
      await session.handle.resize(cols, rows)
    },
    async signal(terminalId: string, name: 'SIGINT' | 'SIGTERM' | 'SIGTSTP') {
      await current(terminalId).handle.signal(name)
    },
    async terminate(terminalId: string) {
      const session = sessions.get(terminalId)
      if (!session) throw new Error('PTY 终端不存在')
      await session.handle.close()
      if (sessions.get(terminalId) === session) sessions.delete(terminalId)
      for (const queue of session.queues) finishQueue(queue)
      session.queues.clear()
      await session.outputTask
    },
    async reapDetached(at = now()) {
      const expired: string[] = []
      for (const session of [...sessions.values()]) {
        if (!session.attached && session.detachedAt !== null && at >= session.detachedAt + ttl) {
          expired.push(session.terminalId)
          try { await this.terminate(session.terminalId) } catch { /* 清扫其余超时 PTY */ }
        }
      }
      return expired
    },
    startReaper(intervalMs = 30_000) {
      if (reaper) return
      reaper = setInterval(() => { void this.reapDetached() }, intervalMs)
      reaper.unref?.()
    },
    async closeAll() {
      if (reaper) clearInterval(reaper)
      reaper = undefined
      for (const terminalId of [...sessions.keys()]) {
        try { await this.terminate(terminalId) } catch { /* 继续关闭其他 PTY */ }
      }
    },
  }
}
