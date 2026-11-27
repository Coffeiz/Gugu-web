import { anthropicCrossRunToolThinking } from './anthropic/driver.js'
import { record } from './values.js'

export function supportsCrossRunProviderReasoning(protocol: string, sessionId: string): boolean {
  return !!sessionId && !sessionId.startsWith('scheduled-task:') && (protocol === 'anthropic' || protocol === 'responses')
}

/** 只发布可跨 Run 重建的协议状态。完整响应块仅属于活动 Run。 */
export function crossRunProviderReasoning(value: unknown) {
  const state = record(value)
  if (state.state_kind === 'openai_responses_reasoning' && Array.isArray(state.reasoning_items))
    return { state_kind: 'openai_responses_reasoning' as const, reasoning_items: state.reasoning_items }
  if (state.state_kind === 'anthropic_thinking_blocks' && typeof state.provider === 'string' && state.provider) {
    const payload = record(state.payload)
    return { state_kind: 'anthropic_thinking_blocks' as const, provider: state.provider,
      payload: { history_thinking_by_tool_id: anthropicCrossRunToolThinking(payload), tail_blocks: payload.tail_blocks ?? null } }
  }
  return null
}
