import type { TerminalEventItem } from './events.js'
import type { TerminalListItem } from './list.js'

export interface TerminalCommandInput { command: string; cwd: string; timeout: number; maxOutputChars: number; network: 'none' | 'egress'; confirmCode?: string }
export interface TerminalCommandPorts {
  authorize(owner: string, terminal: string): Promise<void>
  append(owner: string, terminal: string, event: { kind: 'running'; command: string; runId: string } | { kind: 'result'; command: string; runId: string; stdout: string; stderr: string; exitCode: number | null; ok: boolean }): Promise<(TerminalEventItem & { terminalSnapshot?: TerminalListItem }) | null>
  execute(owner: string, terminal: string, requestId: string, input: TerminalCommandInput, signal: AbortSignal): Promise<{ stdout: string; stderr: string; exitCode: number | null; ok: boolean }>
  publish(owner: string, terminal: string, event: TerminalEventItem & { terminalSnapshot?: TerminalListItem }, origin?: string): Promise<void>
  nextId(): string
  diagnose(error?: unknown): void
  lease?: { acquire(owner: string, terminal: string, request: string): Promise<string | null>; renew(owner: string, terminal: string, request: string, token: string): Promise<boolean>; release(owner: string, terminal: string, request: string, token: string): Promise<boolean>; cancel(owner: string, terminal: string, request: string): Promise<boolean> }
}

/** 后台任务仅持有认证后的身份；通知失败不会撤销已提交事件或阻止执行。 */
export function createTerminalCommandService(ports: TerminalCommandPorts) {
  const tasks = new Map<string, { owner: string; terminal: string; controller: AbortController; done: Promise<void>; finish(): void }>()
  const reserved = new Set<string>()
  let closing = false
  let starting = 0
  const startWaiters = new Set<() => void>()
  function diagnose(error?: unknown) { try { ports.diagnose(error) } catch { /* 诊断失败不能中断命令生命周期。 */ } }
  async function publish(owner: string, terminal: string, event: TerminalEventItem & { terminalSnapshot?: TerminalListItem }, origin?: string) {
    try { await ports.publish(owner, terminal, event, origin) } catch (error) { diagnose(error) }
  }
  return {
    async start(owner: string, terminal: string, input: TerminalCommandInput, origin?: string) {
      if (closing) throw Object.assign(new Error('终端服务正在关闭'), { statusCode: 503 })
      starting++
      try {
      await ports.authorize(owner, terminal)
      if (closing) throw Object.assign(new Error('终端服务正在关闭'), { statusCode: 503 })
      const requestId = ports.nextId()
      if (!requestId || reserved.has(requestId)) throw new Error('终端请求标识冲突')
      reserved.add(requestId)
      let token: string | null = null
      try { if (ports.lease) { token = await ports.lease.acquire(owner, terminal, requestId); if (!token) throw new Error('终端租约不可用') } }
      catch (error) { reserved.delete(requestId); throw error }
      let event: Awaited<ReturnType<TerminalCommandPorts['append']>>
      try { event = await ports.append(owner, terminal, { kind: 'running', command: input.command, runId: requestId }) }
      catch (error) { reserved.delete(requestId); if (token) await ports.lease!.release(owner, terminal, requestId, token).catch(diagnose); throw error }
      if (!event) { reserved.delete(requestId); if (token) await ports.lease!.release(owner, terminal, requestId, token).catch(diagnose); throw Object.assign(new Error('终端不存在'), { statusCode: 404 }) }
      const controller = new AbortController()
      let finish!: () => void
      const done = new Promise<void>(resolve => { finish = resolve })
      tasks.set(requestId, { owner, terminal, controller, done, finish })
      if (closing) controller.abort()
      await publish(owner, terminal, event, origin)
      void (async () => {
        let renewing = false
        const timer = token ? setInterval(() => {
          if (renewing) return
          renewing = true
          void ports.lease!.renew(owner, terminal, requestId, token!).then(ok => { if (!ok) controller.abort() }).catch(() => controller.abort()).finally(() => { renewing = false })
        }, 10000) : undefined
        let result: { stdout: string; stderr: string; exitCode: number | null; ok: boolean }
        try {
          controller.signal.throwIfAborted()
          result = await ports.execute(owner, terminal, requestId, input, controller.signal)
          if (controller.signal.aborted) result = { stdout: '', stderr: '命令已取消', exitCode: null, ok: false }
        }
        catch (error) {
          if (!controller.signal.aborted) diagnose(error)
          result = { stdout: '', stderr: controller.signal.aborted ? '命令已取消' : '命令执行失败', exitCode: controller.signal.aborted ? null : 1, ok: false }
        }
        try {
          const completed = await ports.append(owner, terminal, { kind: 'result', command: input.command, runId: requestId, ...result })
          if (completed) await publish(owner, terminal, completed)
        } catch (error) { diagnose(error) }
        finally { if (timer) clearInterval(timer); if (token) await ports.lease!.release(owner, terminal, requestId, token).catch(diagnose); tasks.delete(requestId); reserved.delete(requestId); finish() }
      })()
      return { requestId, event }
      } finally {
        starting--
        if (!starting) for (const wake of startWaiters) wake()
      }
    },
    async cancel(owner: string, terminal: string, requestId: string) {
      await ports.authorize(owner, terminal)
      const task = tasks.get(requestId)
      if (!task || task.owner !== owner || task.terminal !== terminal) {
        return ports.lease && await ports.lease.cancel(owner, terminal, requestId) ? { cancelled: true, requestId } : { cancelled: false }
      }
      if (task.controller.signal.aborted) return { cancelled: false }
      task.controller.abort()
      return { cancelled: true, requestId }
    },
    async close() {
      closing = true
      if (starting) await new Promise<void>(resolve => { startWaiters.add(resolve) })
      startWaiters.clear()
      const pending = [...tasks.values()]
      for (const task of pending) task.controller.abort()
      await Promise.all(pending.map(task => task.done))
    },
  }
}
