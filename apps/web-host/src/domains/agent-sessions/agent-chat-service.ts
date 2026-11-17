import type { CancellationPort, RunEvent, AgentRunner, RunIdentity } from '@gugu/core/agent'
import type { AgentChatEvent, AgentChatInput, AgentChatService } from './agent-chat-route.js'
import { projectAgentRunEvent, type AgentRunEventProjection } from './agent-run-events.js'

export interface AgentChatEventBus {
  open(identity: RunIdentity, afterSequence?: number, signal?: AbortSignal): Promise<AsyncIterable<RunEvent>>
  notify(identity: RunIdentity): Promise<void>
}
export interface AgentChatServicePorts<C> {
  harness: Pick<AgentRunner<C>, 'start' | 'cancel'>
  cancellation: Pick<CancellationPort, 'request' | 'notify'>
  prepare(ownerId: string, input: AgentChatInput, origin: string | undefined): Promise<{ identity: RunIdentity; userMessageId: number }>
  active(ownerId: string, sessionId: number): Promise<{ identity: RunIdentity | null } | null>
  events: AgentChatEventBus
  projection: AgentRunEventProjection
  /** 已装配的持久调度路径；缺重建器时 kick 不得执行。 */
  dispatch?: { kick(owner: string, sessionId: string): Promise<void>; notify(): Promise<void>; diagnose(): void; requestCancel(owner: string, sessionId: string): Promise<RunIdentity | null>; retryReconstruction?(identity: RunIdentity): Promise<boolean> }
  /** 仅在 checkpoint 不存在时原子记录启动失败；不得覆盖已有运行。 */
  failStart(identity: RunIdentity): Promise<void>
}
function assertIdentity(identity: RunIdentity, owner: string, session?: number): void {
  if (identity.ownerId !== owner || (session !== undefined && identity.sessionId !== String(session))) throw new Error('运行身份不匹配')
}
export function createAgentChatService<C>(ports: AgentChatServicePorts<C>): AgentChatService {
  async function drive(identity: RunIdentity): Promise<void> {
    try {
      for await (const event of ports.harness.start(identity)) {
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
  async function project(identity: RunIdentity, signal?: AbortSignal): Promise<AsyncIterable<AgentChatEvent>> {
    const subscription = await ports.events.open(identity, 0, signal)
    return (async function* () {
      let waiting = false
      let finalized = false
      for await (const event of subscription) {
        if (event.type === 'interaction_required') waiting = true
        if (event.type === 'interaction_resolved') waiting = false
        if (event.type === 'final') finalized = true
        yield* await projectAgentRunEvent(event, ports.projection)
      }
      if (waiting && !finalized) yield { type: 'done' }
    })()
  }
  return {
    async start(owner, input, origin, signal) {
      const { identity, userMessageId } = await ports.prepare(owner, input, origin)
      assertIdentity(identity, owner)
      if (!Number.isSafeInteger(userMessageId) || userMessageId < 1) throw new Error('用户消息身份无效')
      const subscription = await project(identity, signal)
      if (ports.dispatch) {
        try { await ports.dispatch.notify() } catch { ports.dispatch.diagnose() }
        void ports.dispatch.kick(owner, identity.sessionId).catch(() => { ports.dispatch?.diagnose() })
      }
      else void drive(identity).catch(() => {})
      return (async function* () { yield { type: 'session_id', session_id: Number(identity.sessionId), user_message_id: userMessageId, ...(input.client_message_id ? { client_message_id: input.client_message_id } : {}) }; yield* subscription })()
    },
    async resume(owner, sessionId, signal) {
      const active = await ports.active(owner, sessionId)
      if (!active) return null
      if (!active.identity) return (async function* () { yield { type: 'done', idle: true } })()
      assertIdentity(active.identity, owner, sessionId)
      return project(active.identity, signal)
    },
    async cancel(owner, sessionId) {
      const active = await ports.active(owner, sessionId)
      if (!active) return null
      const selected = ports.dispatch ? await ports.dispatch.requestCancel(owner, String(sessionId)) : null
      const target = selected ?? active.identity
      if (!target) return { ok: true, active: false, recovered: false, cancelled_locally: false, outcome: 'already_completed' }
      assertIdentity(target, owner, sessionId)
      const cancelled = await ports.harness.cancel(target)
      if (!cancelled) {
        await ports.cancellation.request(target)
        try { await ports.cancellation.notify(target) } catch { /* 持久标记仍然有效。 */ }
      }
      return { ok: true, active: true, recovered: false, cancelled_locally: false, outcome: 'requested' }
    },
    async retryReconstruction(owner, sessionId) {
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
