import type { RunEvent, RunIdentity } from '@gugu/core/agent'
import type { LiveSubscriptionFactory } from '../../adapters/redis-live-subscription.js'

export interface AgentRunEventReader {
  /** 返回严格递增的所有已提交事件，包含已经投递确认的事件。 */
  readEventsAfter(identity: RunIdentity, sequence: number): Promise<readonly RunEvent[]>
  readState(identity: RunIdentity): Promise<{ sequence: number; status: string } | null>
}
interface Publisher { publish(channel: string, value: string): Promise<number> }
function channel(identity: RunIdentity): string {
  if (!identity.ownerId || !identity.runId || !/^[1-9]\d*$/.test(identity.sessionId)) throw new TypeError('Agent run 身份无效')
  return `agent-run-events:v1:${encodeURIComponent(identity.ownerId)}:${identity.sessionId}:${encodeURIComponent(identity.runId)}`
}
function equal(a: RunIdentity, b: RunIdentity): boolean {
  return a.ownerId === b.ownerId && a.sessionId === b.sessionId && a.runId === b.runId
}

/** Redis 只发送唤醒信号，事件内容及顺序以加密 outbox 为准。 */
export function createAgentRunEventStream(reader: AgentRunEventReader, redis: Publisher, subscribe: LiveSubscriptionFactory, pollMs = 10000) {
  if (!Number.isSafeInteger(pollMs) || pollMs < 1) throw new RangeError('Agent 事件轮询间隔无效')
  return {
    async notify(identity: RunIdentity): Promise<void> { await redis.publish(channel(identity), '1') },
    async open(identity: RunIdentity, afterSequence = 0, signal?: AbortSignal): Promise<AsyncIterable<RunEvent>> {
      if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new RangeError('Agent 事件序号无效')
      const name = channel(identity), bound = { ...identity }
      // 先订阅再读取，避免读取与监听之间漏掉通知；定时读取兜住 Redis 丢消息。
      const live = await subscribe([name])
      return (async function* () {
        let sequence = afterSequence
        try {
          for (;;) {
            if (signal?.aborted) return
            const events = await reader.readEventsAfter(bound, sequence)
            for (const event of events) {
              if (signal?.aborted) return
              if (!equal(bound, event.identity) || event.sequence !== sequence + 1) throw new Error('Agent 事件顺序无效')
              sequence = event.sequence
              yield event
              if (event.type === 'final') return
            }
            const state = await reader.readState(bound)
            if (state && state.sequence > sequence) continue
            if (state?.status === 'reconstruction_unavailable' || state?.status === 'reconstruction_version_conflict') {
              // 这是读取时的暂态提示，不是 outbox 事件，也不是运行终态。
              yield { identity: bound, id: `${bound.runId}:reconstruction-status`, sequence, round: 0, type: 'provider_diagnostic', payload: { reconstructionStatus: state.status } }
              return
            }
            if (state?.status === 'startup_failed') {
              yield { identity: bound, id: `${bound.runId}:startup-failed`, sequence: sequence + 1, round: 0, type: 'final', payload: { status: 'failed' } }
              return
            }
            if (state && ['completed', 'cancelled', 'failed', 'unknown', 'waiting', 'startup_failed'].includes(state.status)) return
            const controller = new AbortController()
            const abort = () => controller.abort()
            signal?.addEventListener('abort', abort, { once: true })
            if (signal?.aborted) controller.abort()
            const timer = setTimeout(() => controller.abort(), pollMs)
            try { await live.next(controller.signal) } catch (error) {
              if (!controller.signal.aborted) throw error
            } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
          }
        } finally { await live.close() }
      })()
    },
  }
}
