import type { RunEvent } from '@gugu/core/agent'
import type { AgentChatEvent } from './agent-chat-route.js'

/** 交互凭据由已授权的交互服务按 run 和 interaction ID 读取。 */
export interface AgentRunEventProjection {
  interaction(event: RunEvent): Promise<AgentChatEvent>
}

/** 只投影 UI 所需的已清洗字段，不发送内部 checkpoint 或 Provider 诊断。 */
export async function projectAgentRunEvent(event: RunEvent, ports: AgentRunEventProjection): Promise<AgentChatEvent[]> {
  const payload = event.payload
  const events: AgentChatEvent[] = []
  if (event.type === 'provider_diagnostic' && (payload.reconstructionStatus === 'reconstruction_unavailable' || payload.reconstructionStatus === 'reconstruction_version_conflict'))
    return [{ type: 'error', message: payload.reconstructionStatus === 'reconstruction_unavailable' ? '运行所需服务暂不可用，请稍后恢复。' : '运行配置已变化，无法安全恢复，请检查配置后重试。', recoverable: true }, { type: 'done', run_id: event.identity.runId, interrupted: true }]
  if (event.type === 'round_start')
    events.push({ type: 'round_start', run_id: event.identity.runId, round_id: `${event.identity.runId}:${event.round}` })
  if (payload.display && typeof payload.display === 'object')
    events.push({ type: 'display_event', item: payload.display })
  if (payload.artifactDisplay && typeof payload.artifactDisplay === 'object')
    events.push({ type: 'display_event', item: payload.artifactDisplay })
  if (event.type === 'tool_done') {
    events.push({ type: 'tool_done', tool_call_id: payload.toolCallId, name: payload.name, status: payload.status, result: payload.result })
  } else if (event.type === 'interaction_required') {
    events.push(await ports.interaction(event))
  } else if (event.type === 'compaction') {
    events.push({ type: '_context_compaction', phase: payload.phase, reason: payload.reason, applied: payload.applied })
  } else if (event.type === 'retry') {
    events.push({ type: 'retry', attempt: payload.attempt, max_retries: payload.maxRetries, next_retry_in: typeof payload.nextRetryMs === 'number' ? payload.nextRetryMs / 1000 : undefined })
  } else if (event.type === 'final') {
    if (Array.isArray(payload.sealedTools)) {
      for (const item of payload.sealedTools) events.push({ type: 'display_event', item })
    }
    if (payload.status === 'failed' || payload.status === 'unknown')
      events.push({ type: 'error', message: typeof payload.text === 'string' && payload.text ? payload.text : '生成失败，请稍后重试' })
    events.push({ type: 'done', run_id: event.identity.runId, cancelled: payload.status === 'cancelled', remote_status_unknown: payload.remoteStatusUnknown === true })
  }
  return events
}
