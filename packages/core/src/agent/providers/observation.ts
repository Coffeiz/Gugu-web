import type { CanonicalRunContext, Json, RunIdentity } from '../models.js'
import type { AgentObservationPort } from '../observation.js'
import { recordAgentObservation } from '../observation.js'
import type { ProviderCacheDiagnostics } from './cache-probe.js'
import type { HistorySanitization, JsonObject } from './contracts.js'
import { record } from './values.js'
import { stableJson } from '../context/history/canonical-history.js'

/** 记录实际 Provider wire 的结构摘要；不在摘要 span 中复制消息正文。 */
export function recordProviderBoundaryObservations(input: {
  observation?: AgentObservationPort
  identity: RunIdentity
  round: number
  at: number
  roundSpanId: string
  protocol: string
  body: JsonObject
  capabilities: CanonicalRunContext['capabilities']
  tools: readonly JsonObject[]
  area: {
    revision: number
    digest: string
    entries: readonly { source: string }[]
    dynamicTail: readonly unknown[]
  }
  historySanitization?: HistorySanitization
  toolDiagnostics: ProviderCacheDiagnostics
  canonicalStats: { count: number; byType: Record<string, number>; schemaDigests: string[] }
  digest(value: unknown): string
}): void {
  if (!input.observation) return
  const selectedToolNames = (input.capabilities?.toolNames ?? input.tools.map(tool => {
    const definition = record(tool)
    const nested = record(definition.function)
    return String(definition.name ?? nested.name ?? '')
  })).filter(name => /^[A-Za-z0-9_.:-]{1,120}$/.test(name))
  const mcpToolNames = selectedToolNames.filter(name => name.startsWith('mcp_'))
  if (input.round === 1) {
    recordAgentObservation(input.observation, {
      identity: input.identity, kind: 'context', name: 'Tool schemas injected', at: input.at, round: input.round,
      spanId: `${input.roundSpanId}:context:tool-schema`, parentSpanId: input.roundSpanId, status: 'success',
      input: { selected_tool_names: selectedToolNames, mcp_tool_names: mcpToolNames },
      output: { tool_count: input.toolDiagnostics.tool_count, schema_bytes: input.toolDiagnostics.tool_schema_bytes },
      attributes: { context_source: 'tool_schema', api_format: input.protocol,
        schema_digest: input.toolDiagnostics.tool_schema_digest },
    })
    if (input.capabilities) {
      recordAgentObservation(input.observation, {
        identity: input.identity, kind: 'context', name: 'Capability catalog injected', at: input.at, round: input.round,
        spanId: `${input.roundSpanId}:context:capability-catalog`, parentSpanId: input.roundSpanId, status: 'success',
        input: { tool_names: selectedToolNames },
        output: { tool_count: input.capabilities.toolNames.length,
          user_skill_count: input.capabilities.userSkillSnapshot?.length ?? 0 },
        attributes: { context_source: 'capability_catalog' },
      })
    }
  }
  const rows: unknown[] = Array.isArray(input.body.messages) ? input.body.messages
    : Array.isArray(input.body.input) ? input.body.input : []
  const summarizeRow = (value: unknown) => {
    const row = record(value)
    const content = row.content ?? row.input ?? value
    const encoded = stableJson((content ?? null) as Json)
    const markers = ['[system-reminder]', '[群聊历史消息', '[当前群聊发言人', '[group-rag]',
      '[owner-rag]', '[group-member-rag]', '[knowledge-context]', '## 当前群组记忆',
      '## 当前 IM 身份事实', '## 回应时请遵循以下规则', '当前时间：']
      .filter(marker => encoded.includes(marker))
    return { role: String(row.role ?? row.type ?? 'unknown'), chars: encoded.length,
      fingerprint: input.digest(encoded).slice(0, 12), markers }
  }
  const rowSummaries = rows.map(summarizeRow)
  const system = input.body.system ?? input.body.instructions ?? null
  const areaSources: Record<string, number> = {}
  for (const entry of input.area.entries)
    areaSources[entry.source] = (areaSources[entry.source] ?? 0) + 1
  recordAgentObservation(input.observation, {
    identity: input.identity, kind: 'context', name: 'Canonical events at provider boundary', at: input.at, round: input.round,
    spanId: `${input.roundSpanId}:context:canonical-events`, parentSpanId: input.roundSpanId, status: 'success',
    output: { count: input.canonicalStats.count, by_type: input.canonicalStats.byType,
      schema_digests: input.canonicalStats.schemaDigests },
    attributes: { context_source: 'canonical_events' },
  })
  recordAgentObservation(input.observation, {
    identity: input.identity, kind: 'context', name: 'Context layout at provider boundary', at: input.at, round: input.round,
    spanId: `${input.roundSpanId}:context:provider-layout`, parentSpanId: input.roundSpanId, status: 'success',
    output: {
      phase: 'provider-input', provider_message_count: rowSummaries.length,
      provider_sequence_fingerprint: input.digest(rowSummaries).slice(0, 12),
      provider_head: rowSummaries.slice(0, 3), provider_tail: rowSummaries.slice(-3),
      system_chars: system == null ? 0 : stableJson(system as Json).length,
      system_fingerprint: input.digest(system as Json).slice(0, 12),
      canonical_area: { revision: input.area.revision, digest: input.area.digest,
        entry_count: input.area.entries.length, dynamic_tail_size: input.area.dynamicTail.length, sources: areaSources },
      provider_history_sanitization: input.historySanitization ?? null,
    },
    attributes: { context_source: 'provider-input', api_format: input.protocol },
  })
}
