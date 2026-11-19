import type { TraceSpan } from '../types'

/** 同时识别旧 Collector 的 llm 和新版 AgentLoop 的 provider span。 */
export function isModelSpan(span: Pick<TraceSpan, 'kind' | 'name'>): boolean {
  return span.kind === 'llm' || span.kind === 'provider' || /^LLM round\b/i.test(span.name)
}
