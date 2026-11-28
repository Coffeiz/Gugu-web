import type { RunEvent, AgentRunner, RunIdentity } from './models.js'
import type { CancellationPort } from './ports.js'

export interface AgentChatEvent {
  type: string
  [key: string]: unknown
}

export interface AgentChatEventBus {
  open(identity: RunIdentity, afterSequence?: number, signal?: AbortSignal, onCaughtUp?: () => void): Promise<AsyncIterable<RunEvent>>
  notify(identity: RunIdentity): Promise<void>
}

/** Core Agent Chat 的跨端调用契约；Host 只负责认证、准备与持久端口装配。 */
export interface AgentChatService<I> {
  start(ownerId: string, input: I, origin: string | undefined, signal?: AbortSignal): Promise<AsyncIterable<AgentChatEvent>>
  resume(ownerId: string, sessionId: number, signal?: AbortSignal, runId?: string): Promise<AsyncIterable<AgentChatEvent> | null>
  wake(ownerId: string, sessionId: number): Promise<boolean>
  cancel(ownerId: string, sessionId: number): Promise<Record<string, unknown> | null>
  retryReconstruction?(ownerId: string, sessionId: number): Promise<Record<string, unknown> | null>
}

/** Chat 生命周期用例的可信 Host 端口；Core 不依赖 Web、数据库或消息代理。 */
export interface AgentChatServicePorts<C, I> {
  /** 直接模式复用进程 Harness；调度模式由每个 lease 的 Worker 重建。 */
  harness?: Pick<AgentRunner<C>, 'start' | 'cancel'>
  cancellation: Pick<CancellationPort, 'request' | 'notify'>
  prepare(ownerId: string, input: I, origin: string | undefined): Promise<{ identity: RunIdentity; userMessageId: number; replay?: boolean; goalMode?: boolean }>
  active(ownerId: string, sessionId: number, runId?: string): Promise<{ identity: RunIdentity | null } | null>
  events: AgentChatEventBus
  project(event: RunEvent): Promise<readonly AgentChatEvent[]>
  /** 已装配的持久调度路径；缺重建器时 kick 不得执行。 */
  dispatch?: {
    kick(owner: string, sessionId: string): Promise<void>
    notify(): Promise<void>
    diagnose(): void
    requestCancel(owner: string, sessionId: string): Promise<RunIdentity | null>
    retryReconstruction?(identity: RunIdentity): Promise<boolean>
  }
  /** 仅在 checkpoint 不存在时原子记录启动失败；不得覆盖已有运行。 */
  failStart(identity: RunIdentity): Promise<void>
}

function assertIdentity(identity: RunIdentity, owner: string, session?: number): void {
  if (identity.ownerId !== owner || (session !== undefined && identity.sessionId !== String(session))) throw new Error('运行身份不匹配')
}

/** 跨端 Agent Chat 用例；身份仍由认证 Host 传入，事件与执行能力通过端口提供。 */
export function createAgentChatService<C, I>(ports: AgentChatServicePorts<C, I>): AgentChatService<I> {
  if (!ports.dispatch && !ports.harness) throw new TypeError('Agent Chat 执行器未配置')
  async function drive(identity: RunIdentity, userMessageId: number, goalMode?: boolean): Promise<void> {
    try {
      const harness = ports.harness
      if (!harness) throw new Error('Agent Chat 直接执行器不可用')
      for await (const event of harness.start(identity, { anchorMessageId: String(userMessageId), ...(goalMode ? { goalMode } : {}) })) {
        assertIdentity(event.identity, identity.ownerId, Number(identity.sessionId))
        if (event.identity.runId !== identity.runId) throw new Error('运行身份不匹配')
        // 权威事件由 Harness 在 yield 前提交，通知只用于缩短订阅等待。
        try { await ports.events.notify(identity) } catch { /* 订阅者仍会定时读取 outbox。 */ }
      }
    } catch {
      await ports.failStart(identity)
    } finally {
      try { await ports.events.notify(identity) } catch { /* 持久状态仍可读取。 */ }
    }
  }
  async function project(identity: RunIdentity, signal?: AbortSignal, replaying = false): Promise<AsyncIterable<AgentChatEvent>> {
    const subscription = await ports.events.open(identity, 0, signal, () => { replaying = false })
    return (async function* () {
      let waiting = false
      let finalized = false
      for await (const event of subscription) {
        if (event.type === 'interaction_required') waiting = true
        if (event.type === 'interaction_resolved') waiting = false
        if (event.type === 'final') finalized = true
        for (const item of await ports.project(event))
          yield replaying && item.type === 'display_event' ? { ...item, replayed: true } : item
      }
      if (waiting && !finalized) yield { type: 'done', waiting_for_interaction: true }
    })()
  }
  return {
    async start(owner: string, input: I, origin: string | undefined, signal?: AbortSignal): Promise<AsyncIterable<AgentChatEvent>> {
      const { identity, userMessageId, replay, goalMode } = await ports.prepare(owner, input, origin)
      assertIdentity(identity, owner)
      if (!Number.isSafeInteger(userMessageId) || userMessageId < 1) throw new Error('用户消息身份无效')
      const subscription = await project(identity, signal, replay === true)
      if (ports.dispatch) {
        try { await ports.dispatch.notify() } catch { ports.dispatch.diagnose() }
        void ports.dispatch.kick(owner, identity.sessionId).catch(() => { ports.dispatch?.diagnose() })
      }
      else if (!replay) void drive(identity, userMessageId, goalMode).catch(() => {})
      return (async function* () {
        yield { type: 'session_id', session_id: Number(identity.sessionId), user_message_id: userMessageId, run_id: identity.runId,
          ...(typeof input === 'object' && input !== null && 'client_message_id' in input && typeof input.client_message_id === 'string'
            ? { client_message_id: input.client_message_id } : {}) }
        yield* subscription
      })()
    },
    async resume(owner: string, sessionId: number, signal?: AbortSignal, runId?: string): Promise<AsyncIterable<AgentChatEvent> | null> {
      const active = await ports.active(owner, sessionId, runId)
      if (!active) return null
      if (runId !== undefined && active.identity?.runId !== runId) return null
      if (!active.identity) return (async function* () { yield { type: 'done', idle: true } })()
      assertIdentity(active.identity, owner, sessionId)
      return project(active.identity, signal, true)
    },
    /** 持久交互已在 Host 事务中提交后，按 owner/session 唤醒同一 dispatch 生命周期。 */
    async wake(owner: string, sessionId: number): Promise<boolean> {
      if (!ports.dispatch) return false
      const active = await ports.active(owner, sessionId)
      if (!active?.identity) return false
      assertIdentity(active.identity, owner, sessionId)
      try { await ports.dispatch.notify() } catch { ports.dispatch.diagnose() }
      void ports.dispatch.kick(owner, String(sessionId)).catch(() => { ports.dispatch?.diagnose() })
      return true
    },
    async cancel(owner: string, sessionId: number): Promise<Record<string, unknown> | null> {
      const active = await ports.active(owner, sessionId)
      if (!active) return null
      const selected = ports.dispatch ? await ports.dispatch.requestCancel(owner, String(sessionId)) : null
      const target = selected ?? active.identity
      if (!target) return { ok: true, active: false, recovered: false, cancelled_locally: false, outcome: 'already_completed' }
      assertIdentity(target, owner, sessionId)
      if (ports.dispatch) {
        await ports.cancellation.request(target)
        try { await ports.cancellation.notify(target) }
        finally {
          try { await ports.dispatch.notify() } catch { ports.dispatch.diagnose() }
        }
        return { ok: true, active: true, recovered: false, cancelled_locally: false, outcome: 'requested' }
      }
      const harness = ports.harness
      if (!harness) throw new Error('Agent Chat 直接执行器不可用')
      const cancelled = await harness.cancel(target)
      if (!cancelled) {
        await ports.cancellation.request(target)
        try { await ports.cancellation.notify(target) } catch { /* 持久标记仍然有效。 */ }
      }
      return { ok: true, active: true, recovered: false, cancelled_locally: false, outcome: 'requested' }
    },
    async retryReconstruction(owner: string, sessionId: number): Promise<Record<string, unknown> | null> {
      const active = await ports.active(owner, sessionId)
      if (!active) return null
      if (!active.identity || !ports.dispatch?.retryReconstruction) return { ok: false, retried: false }
      assertIdentity(active.identity, owner, sessionId)
      const retried = await ports.dispatch.retryReconstruction(active.identity)
      if (retried) {
        try { await ports.dispatch.notify() } catch { ports.dispatch.diagnose() }
        void ports.dispatch.kick(owner, String(sessionId)).catch(() => { ports.dispatch?.diagnose() })
      }
      return { ok: true, retried }
    },
  }
}
