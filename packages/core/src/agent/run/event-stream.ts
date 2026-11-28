import type { AgentChatEventBus } from '../chat-service.js'
import type { RunEvent, RunIdentity } from '../models.js'

export interface AgentRunEventReader {
  /** 返回严格递增的所有已提交事件，包含已经投递确认的事件。 */
  readEventsAfter(identity: RunIdentity, sequence: number): Promise<readonly RunEvent[]>
  readState(identity: RunIdentity): Promise<{ sequence: number; status: string } | null>
}

/** 重建状态属于当前订阅，不占用持久事件序号。 */
export function reconstructionStatusEvent(identity: RunIdentity, sequence: number, status: string | undefined): RunEvent | undefined {
  if (status !== 'reconstruction_unavailable' && status !== 'reconstruction_version_conflict') return
  return { identity, id: `${identity.runId}:reconstruction-status`, sequence, round: 0,
    type: 'provider_diagnostic', payload: { reconstructionStatus: status } }
}

/** 准入失败可能发生在持久运行事件写入前。 */
export function startupFailureEvent(identity: RunIdentity, sequence: number): RunEvent {
  return { identity, id: `${identity.runId}:startup-failed`, sequence: sequence + 1,
    round: 0, type: 'final', payload: { status: 'failed' } }
}

interface AgentRunEventWakeup {
  notify(identity: RunIdentity): Promise<void>
  subscribe(identity: RunIdentity): Promise<{
    next(signal: AbortSignal): Promise<unknown>
    close(): Promise<void>
  }>
}

type RunReadState = NonNullable<Awaited<ReturnType<AgentRunEventReader['readState']>>>

/** checkpoint 为权威状态；重建暂态只覆盖未启动或正在运行的状态。 */
export function createAgentRunStateReader(
  checkpoint: { read(identity: RunIdentity): Promise<RunReadState | null> },
  startup: { readFailure(identity: RunIdentity): Promise<boolean> },
  dispatch?: { readReconstructionStatus(identity: RunIdentity): Promise<'unavailable' | 'version_conflict' | null> },
): AgentRunEventReader['readState'] {
  return async identity => {
    const state = await checkpoint.read(identity)
    const blocked = await dispatch?.readReconstructionStatus(identity)
    if (blocked && (!state || state.status === 'preparing' || state.status === 'running')) {
      return { sequence: state?.sequence ?? 0, status: `reconstruction_${blocked}` }
    }
    if (state) return { sequence: state.sequence, status: state.status }
    return await startup.readFailure(identity) ? { sequence: 0, status: 'startup_failed' } : null
  }
}

function equal(a: RunIdentity, b: RunIdentity): boolean {
  return a.ownerId === b.ownerId && a.sessionId === b.sessionId && a.runId === b.runId
}

/** 通知只唤醒读取，事件内容和顺序以已提交的 outbox 为准。 */
export function createAgentRunEventStream(reader: AgentRunEventReader, wakeup: AgentRunEventWakeup, pollMs = 10000): AgentChatEventBus {
  if (!Number.isSafeInteger(pollMs) || pollMs < 1) throw new RangeError('Agent 事件轮询间隔无效')
  return {
    notify: identity => wakeup.notify(identity),
    async open(identity: RunIdentity, afterSequence = 0, signal?: AbortSignal, onCaughtUp?: () => void): Promise<AsyncIterable<RunEvent>> {
      if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new RangeError('Agent 事件序号无效')
      const bound = { ...identity }
      return (async function* () {
        if (signal?.aborted) return
        // 首次消费时先订阅再读持久事件，避免未被消费的响应留下订阅。
        const live = await wakeup.subscribe(bound)
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
            onCaughtUp?.()
            onCaughtUp = undefined
            const reconstruction = reconstructionStatusEvent(bound, sequence, state?.status)
            if (reconstruction) {
              yield reconstruction
              return
            }
            if (state?.status === 'startup_failed') {
              yield startupFailureEvent(bound, sequence)
              return
            }
            if (state && ['completed', 'cancelled', 'failed', 'unknown', 'waiting'].includes(state.status)) return
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
