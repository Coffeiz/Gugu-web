import type { TraceRoundExport, TraceRun, TraceSpan } from '../types'

function roundNumber(span: TraceSpan): number | null {
  const value = span.attributes?.round
  const round = typeof value === 'number' ? value : Number(value)
  return Number.isInteger(round) && round > 0 ? round : null
}

/**
 * 为导出文件生成按 round 组织的索引。
 * 原始 spans 仍然保留，rounds 只复制主 LLM span 的诊断字段，避免重复写入工具结果。
 */
export function buildTraceRounds(run: TraceRun): TraceRoundExport[] {
  const groups = new Map<number, TraceSpan[]>()
  for (const span of run.spans ?? []) {
    const round = roundNumber(span)
    if (round === null) continue
    const group = groups.get(round) ?? []
    group.push(span)
    groups.set(round, group)
  }

  return [...groups.entries()]
    .sort(([left], [right]) => left - right)
    .map(([round, spans]) => {
      const primary = spans.find(span => span.kind === 'llm' || /^LLM round\b/i.test(span.name)) ?? spans[0]
      return {
        round,
        span_id: primary.id,
        span_ids: spans.map(span => span.id),
        span_count: spans.length,
        name: primary.name,
        kind: primary.kind,
        status: primary.status,
        started_at: primary.started_at,
        ended_at: primary.ended_at,
        duration_ms: primary.duration_ms,
        input: primary.input,
        output: primary.output,
        attributes: primary.attributes,
        usage: primary.usage,
        token_impact: primary.token_impact,
      }
    })
}
