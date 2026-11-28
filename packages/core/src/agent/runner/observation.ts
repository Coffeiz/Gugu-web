import type { RunEvent, RunIdentity, ToolCall, Usage } from '../models.js'
import type { AgentRunnerPorts } from '../ports.js'
import { recordAgentObservation } from '../observation.js'
import { recordAgentRunLog, type AgentRunLogEventName } from '../logging.js'

export function contextSummaryMetrics(snapshot: unknown) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return {}
  const entries = (snapshot as { entries?: unknown }).entries
  if (!Array.isArray(entries)) return {}
  const summaries: string[] = []
  const textOf = (value: unknown): string => {
    if (typeof value === 'string') return value
    if (Array.isArray(value)) return value.map(textOf).join('\n')
    if (!value || typeof value !== 'object') return ''
    const row = value as Record<string, unknown>
    return typeof row.text === 'string' ? row.text : textOf(row.content)
  }
  for (const value of entries) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const message = (value as { message?: unknown }).message
    const content = message && typeof message === 'object' && !Array.isArray(message)
      ? textOf((message as Record<string, unknown>).content) : ''
    if (content.includes('<compacted-summary>')) summaries.push(content)
  }
  return {
    message_count: entries.length,
    summary_count: summaries.length,
    summary_chars: summaries.reduce((total, value) => total + value.length, 0),
  }
}

export function skillInjectionMetadata(value: unknown): Record<string, string | number> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const result = value as Record<string, unknown>
  const marker = result._capability_usage
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) return null
  const usage = marker as Record<string, unknown>
  if (usage.kind !== 'skill' || usage.loaded !== true || typeof usage.id !== 'string'
    || !/^[SU][1-9][0-9]*$/.test(usage.id) || typeof usage.content_digest !== 'string'
    || !/^[a-f0-9]{16,64}$/i.test(usage.content_digest) || typeof result.content !== 'string') return null
  if (usage.id.startsWith('U') && (usage.source !== 'user' || typeof usage.owner_fingerprint !== 'string')) return null
  if (usage.id.startsWith('S') && usage.source !== undefined && usage.source !== 'builtin') return null
  return {
    skill: typeof usage.skill_key === 'string' ? usage.skill_key : usage.id,
    content_chars: result.content.length,
    content_digest: usage.content_digest,
    source: usage.id.startsWith('U') ? 'user' : 'builtin',
    ...(typeof usage.owner_fingerprint === 'string' ? { owner_fingerprint: usage.owner_fingerprint } : {}),
  }
}

export function createRunnerObservation<C>(ports: AgentRunnerPorts<C>) {
  const observedAt = () => Date.parse(ports.clock.now()) || Date.now()
  const observePhase = (identity: RunIdentity, name: string, startedAt: number, round: number, status: string, attributes?: Readonly<Record<string, unknown>>) => {
    const endedAt = observedAt()
    recordAgentObservation(ports.observation, {
      identity, kind: 'context', name, at: endedAt, round,
      spanId: `${identity.runId}:phase:${name}:${startedAt}`,
      parentSpanId: identity.runId, status, startedAt, endedAt,
      durationMs: Math.max(0, endedAt - startedAt), attributes,
    })
  }
  const logRun = (identity: RunIdentity, level: 'info' | 'warn' | 'error', event: AgentRunLogEventName,
    round?: number, attributes?: Readonly<Record<string, string | number | boolean | null>>) => recordAgentRunLog(ports.log, {
    identity, at: observedAt(), level, event, ...(round === undefined ? {} : { round }), ...(attributes ? { attributes } : {}),
  })
  const recordToolSchemaFailure = (identity: RunIdentity, context: C | null, call: ToolCall, round: number,
    errorKind: string, error: unknown, parentSpanId: string): void => {
    let schema: unknown = null
    try { if (context !== null) schema = ports.toolSchemaSnapshot?.(context, call.name) ?? null } catch { /* Schema 观测失败不影响工具回执。 */ }
    logRun(identity, 'warn', 'agent.tools.schema_error', round, {
      errorCode: errorKind === 'parse_error' ? 'invalid_arguments' : 'tool_failed',
    })
    recordAgentObservation(ports.observation, {
      identity, kind: 'tool', name: `Tool schema error · ${call.name}`, at: observedAt(), round,
      spanId: `${parentSpanId}:schema-error`, parentSpanId, status: 'error',
      input: { tool_name: call.name, schema, arguments: call.input, error },
      output: { tool_name: call.name, error_kind: errorKind },
      attributes: { context_source: 'tool_schema_error', error_kind: errorKind, tool_name: call.name },
    })
  }
  const recordToolInvocation = (identity: RunIdentity, call: ToolCall, round: number,
    outcome: 'success' | 'error' | 'waiting' | 'unknown' | 'cancelled' | 'deferred' | 'invalid',
    startedAt?: number, attributes: Readonly<Record<string, string | number | boolean | null>> = {}) => {
    const endedAt = observedAt()
    const safeTool = /^[A-Za-z0-9_.:-]{1,120}$/.test(call.name) ? call.name : 'unknown_tool'
    const level = outcome === 'unknown' ? 'error' : outcome === 'error' || outcome === 'invalid' ? 'warn' : 'info'
    logRun(identity, level, 'agent.tools.invocation', round, {
      tool: safeTool, outcome,
      ...(startedAt === undefined ? {} : { durationMs: Math.max(0, endedAt - startedAt) }),
      ...attributes,
    })
  }
  const observeEvent = (event: RunEvent) => {
    const payload = event.payload
    if (event.type === 'run_started') {
      logRun(event.identity, 'info', 'agent.run.started')
      recordAgentObservation(ports.observation, {
        identity: event.identity, kind: 'run', name: 'started', at: observedAt(), spanId: event.identity.runId, status: 'running',
      })
    }
    else if (event.type === 'run_resumed') {
      logRun(event.identity, 'info', 'agent.run.resumed')
      recordAgentObservation(ports.observation, {
        identity: event.identity, kind: 'run', name: 'resumed', at: observedAt(), spanId: event.identity.runId, status: 'running',
      })
    }
    else if (event.type === 'round_start') recordAgentObservation(ports.observation, {
      identity: event.identity, kind: 'round', name: 'started', at: observedAt(), round: event.round,
      spanId: `${event.identity.runId}:round:${event.round}`, parentSpanId: event.identity.runId, status: 'running',
    })
    else if (event.type === 'round_end') recordAgentObservation(ports.observation, {
      identity: event.identity, kind: 'round', name: 'completed', at: observedAt(), round: event.round,
      spanId: `${event.identity.runId}:round:${event.round}`, parentSpanId: event.identity.runId, status: 'success',
      output: payload.text,
    })
    else if (event.type === 'token') recordAgentObservation(ports.observation, {
      identity: event.identity, kind: 'round', name: 'output_delta', at: observedAt(), round: event.round,
      spanId: `${event.identity.runId}:round:${event.round}`, output: payload.text,
    })
    else if (event.type === 'final') {
      const at = observedAt()
      const status = String(payload.status ?? 'unknown')
      const text = typeof payload.text === 'string' ? payload.text : ''
      const safeStatus = ['completed', 'failed', 'cancelled', 'unknown'].includes(status)
        ? status as 'completed' | 'failed' | 'cancelled' | 'unknown' : 'unknown'
      logRun(event.identity, safeStatus === 'failed' ? 'error' : 'info', 'agent.run.finished', event.round,
        { status: safeStatus })
      recordAgentObservation(ports.observation, {
        identity: event.identity, kind: 'run', name: 'finished', at, spanId: event.identity.runId,
        status, output: text,
        usage: payload.usage && typeof payload.usage === 'object' ? payload.usage as Usage : undefined,
      })
      if (status === 'completed' || status === 'failed')
        recordAgentObservation(ports.observation, {
          identity: event.identity, kind: 'output', name: status === 'failed' ? 'Agent error' : 'Final response', at,
          startedAt: at, endedAt: at, durationMs: 0, spanId: `${event.identity.runId}:output`,
          parentSpanId: event.identity.runId, status: status === 'failed' ? 'error' : 'success',
          output: { text, ...(typeof payload.errorCode === 'string' ? { code: payload.errorCode } : {}) },
          attributes: { source: 'agent.run.finalization' },
        })
    }
  }
  return { observedAt, observePhase, logRun, recordToolSchemaFailure, recordToolInvocation, observeEvent }
}
