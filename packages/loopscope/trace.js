import { createHash } from 'node:crypto'

export const loopScopeTraceEnabled = value => /^(1|true|yes|on)$/i.test(String(value ?? '').trim())

const secretKey = /^(authorization|cookie|set-cookie|api[_-]?key|password|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|credential)$/i
const secretText = /(?:\bBearer\s+[A-Za-z0-9._~+/-]{12,}\b|\bsk-[A-Za-z0-9]{16,}\b|(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|secret)\s*[=:]\s*[^\s,;]{8,}|\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?)\:\/\/[^\s/@:]+:[^\s/@]+@[^\s]+|\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/gi
const nowSeconds = () => Date.now() / 1000
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const cloneSafe = (value, depth = 0) => {
  if (depth > 64) return '[trace depth limit]'
  if (typeof value === 'string') return value.replace(secretText, '[credential omitted]')
  if (Array.isArray(value)) return value.map(item => cloneSafe(item, depth + 1))
  if (!isRecord(value)) return value
  const output = {}
  for (const [key, item] of Object.entries(value)) {
    if (secretKey.test(key) && ['string', 'number', 'boolean'].includes(typeof item) && item !== '') output[key] = '[credential omitted]'
    else if (key.toLowerCase() === 'headers' && isRecord(item)) output[key] = Object.fromEntries(Object.keys(item).map(header => [header, '[credential omitted]']))
    else output[key] = cloneSafe(item, depth + 1)
  }
  return output
}
const safeId = value => String(value ?? '').replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 240) || 'unknown'
const localSpanId = (run, event, value) => {
  const raw = String(value ?? '')
  const runId = String(event.identity?.runId ?? '')
  const suffix = raw === runId ? '' : raw.startsWith(`${runId}:`) ? raw.slice(runId.length) : `:${safeId(raw)}`
  return `${run.id}${suffix}`
}
const textOf = value => typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value)
const stableText = value => Array.isArray(value) ? `[${value.map(stableText).join(',')}]`
  : isRecord(value) ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableText(value[key])}`).join(',')}}`
    : JSON.stringify(value)
const digestText = value => createHash('sha1').update(stableText(value)).digest('hex').slice(0, 16)
const contentText = value => typeof value === 'string' ? value
  : Array.isArray(value) ? value.map(item => isRecord(item) && typeof item.text === 'string' ? item.text : '').filter(Boolean).join('\n')
    : isRecord(value) && typeof value.text === 'string' ? value.text : textOf(value)
const usageShape = usage => {
  if (!isRecord(usage)) return {}
  const read = Number.isFinite(usage.cacheRead) ? usage.cacheRead : Number.isFinite(usage.cache_read) ? usage.cache_read : 0
  const write = Number.isFinite(usage.cacheWrite) ? usage.cacheWrite : Number.isFinite(usage.cache_write) ? usage.cache_write : 0
  const fresh = Number.isFinite(usage.freshInput) ? usage.freshInput
    : Number.isFinite(usage.fresh_input) ? usage.fresh_input
      : Number.isFinite(usage.input) ? usage.input : 0
  const input = Number.isFinite(usage.contextInput) ? usage.contextInput
    : Number.isFinite(usage.context_input) ? usage.context_input
      : (Number.isFinite(usage.freshInput) || Number.isFinite(usage.fresh_input)) && Number.isFinite(usage.input)
        ? usage.input : fresh + read + write
  const output = Number.isFinite(usage.output) ? usage.output : 0
  return {
    input, output, cache_read: read, cache_write: write, fresh_input: fresh,
    total: input + output, cache_ratio: input ? read / input : 0,
  }
}
const addUsage = (current, next) => {
  const total = { ...current }
  for (const key of ['input', 'output', 'cache_read', 'cache_write', 'fresh_input']) {
    const value = next[key]
    if (Number.isFinite(value)) total[key] = (Number.isFinite(total[key]) ? total[key] : 0) + value
  }
  total.total = (total.input ?? 0) + (total.output ?? 0)
  total.cache_ratio = total.input ? (total.cache_read ?? 0) / total.input : 0
  return total
}
const providerRows = body => Array.isArray(body?.messages) ? body.messages : Array.isArray(body?.input) ? body.input : []
const userMessage = body => {
  const rows = providerRows(body)
  const message = [...rows].reverse().find(row => isRecord(row) && row.role === 'user')
  return message ? textOf(message.content ?? message) : ''
}
const systemText = body => {
  const value = body?.system ?? body?.instructions ?? providerRows(body).find(row => isRecord(row) && row.role === 'system')?.content
  return contentText(value)
}

function cacheDropProbe(run, span, previous, current) {
  if (!previous || !previous.cache_supported || !current.cache_supported
    || previous.cache_read_tokens < 32_000 || current.input_tokens <= 0 || previous.cache_hit_ratio < 0.5) return
  const drop = previous.cache_hit_ratio - current.cache_hit_ratio
  if (current.cache_hit_ratio > 0.05 && drop < 0.8) return
  const attribution = []
  if (current.prefix_unchanged === false || previous.stable_prefix_digest !== current.stable_prefix_digest) attribution.push('prefix_changed')
  if (previous.tool_schema_digest !== current.tool_schema_digest) attribution.push('tool_schema_changed')
  if (previous.system_digest !== current.system_digest) attribution.push('system_prompt_changed')
  if (previous.memory_digest !== current.memory_digest) attribution.push('memory_changed')
  if (previous.summary_digest !== current.summary_digest) attribution.push('summary_changed')
  if (previous.provider !== current.provider) attribution.push('provider_changed')
  if (previous.model !== current.model) attribution.push('model_changed')
  if (previous.api_format !== current.api_format) attribution.push('api_format_changed')
  const gap = Math.max(0, current.at - previous.at)
  if (gap >= 300) attribution.push('time_gap_suspected')
  if (!attribution.length) attribution.push('provider_cache_drop_unexplained')
  const keys = ['provider', 'model', 'api_format', 'input_tokens', 'cache_read_tokens', 'cache_write_tokens', 'cache_hit_ratio',
    'stable_prefix_digest', 'tool_schema_digest', 'system_digest', 'memory_digest', 'summary_digest']
  const event = {
    previous: Object.fromEntries(keys.map(key => [key, previous[key] ?? null])),
    current: Object.fromEntries(keys.map(key => [key, current[key] ?? null])),
    request_gap_seconds: Math.round(gap * 1000) / 1000, hit_ratio_drop: Math.round(drop * 1_000_000) / 1_000_000,
    prefix_unchanged: current.prefix_unchanged, attribution,
  }
  const bucket = run.attributes.cache_drop_probe ??= { event_count: 0, events: [] }
  bucket.event_count += 1
  if (!bucket.events.length) bucket.events.push(event)
  span.attributes = { ...span.attributes, cache_drop_probe: event }
}

function createRun(event, source, maxSpans) {
  const identity = event.identity
  const id = `run-${safeId(identity.runId)}`
  const startedAt = event.at / 1000
  return {
    id, trace_id: safeId(identity.runId), session_key: `gugu:${source}:${safeId(identity.sessionId)}`,
    external_session_id: String(identity.sessionId), source, status: 'running', started_at: startedAt,
    ended_at: null, duration_ms: null, input: {}, output: {}, attributes: {}, usage: {}, spans: [],
    _spans: new Map(), _startedAtMs: event.at, _output: '', _lastRequest: null, _maxSpans: maxSpans,
    _adapterRequests: new Set(), _adapterResults: new Set(),
  }
}

function spanFor(run, event, id, name, kind, parentSpanId) {
  let span = run._spans.get(id)
  if (!span) {
    if (run._spans.size >= run._maxSpans) {
      run.attributes.span_limit_reached = true
      return { id, run_id: run.id, parent_span_id: parentSpanId ?? null, kind, name, status: 'unknown', started_at: event.at / 1000,
        ended_at: null, duration_ms: null, input: {}, output: {}, attributes: {}, code: {}, usage: {} }
    }
    span = { id, run_id: run.id, parent_span_id: parentSpanId ?? null, kind, name, status: 'running', started_at: event.at / 1000,
      ended_at: null, duration_ms: null, input: {}, output: {}, attributes: {}, code: {}, usage: {} }
    run._spans.set(id, span)
  }
  return span
}

function updateRun(run, event) {
  if (run._traceDisabled) {
    if (event.kind === 'run' && event.name === 'finished') {
      run.status = ({ completed: 'success', failed: 'error', cancelled: 'cancelled', unknown: 'unknown' })[event.status] ?? event.status ?? 'unknown'
      run.ended_at = event.at / 1000
      run.duration_ms = Math.max(0, event.at - run._startedAtMs)
      if (event.usage) run.usage = usageShape(event.usage)
    }
    return
  }
  if (event.kind === 'run' && ['started', 'resumed'].includes(event.name)) {
    const span = spanFor(run, event, run.id, 'Agent run', 'run', null)
    run.status = 'running'; run.ended_at = null; run.duration_ms = null
    span.status = 'running'; span.ended_at = null; span.duration_ms = null
    span.attributes = { ...span.attributes, ...cloneSafe(event.attributes ?? {}) }
    run.attributes = { ...run.attributes, ...cloneSafe(event.attributes ?? {}) }
    return
  }
  const roundId = `${run.id}:round:${event.round ?? 0}`
  const spanId = event.spanId ? localSpanId(run, event, event.spanId) : `${roundId}:${safeId(event.name)}`
  if (event.kind === 'provider' && event.name === 'request') {
    const body = isRecord(event.input) ? cloneSafe(event.input) : {}
    const isBranch = event.attributes?.purpose === 'branch'
    if (isBranch) {
      const round = spanFor(run, { ...event, kind: 'round', name: 'started' }, roundId, `Round ${event.round ?? 0}`, 'round', run.id)
      round.status = 'running'
    }
    const modelSpanId = isBranch ? spanId : roundId
    const span = spanFor(run, event, modelSpanId, isBranch ? 'Provider request' : `LLM round ${event.round ?? 0}`,
      isBranch ? 'provider' : 'llm', isBranch ? roundId : run.id)
    const rows = providerRows(body)
    const system = body.system ?? body.instructions ?? rows.find(row => isRecord(row) && row.role === 'system')?.content
    const snapshotMessage = rows.find(row => isRecord(row) && contentText(row.content).startsWith('[system-reminder]'))
    // 每轮只保存一份 Provider 正文。完整 body 同时放在
    // LLM span 和 Provider context span 会让长历史按轮数成倍膨胀，触发整条 trace 丢弃。
    const messages = rows.filter(row => !(isRecord(row) && row.role === 'system'))
    const providerOptions = Object.fromEntries(Object.entries(body)
      .filter(([key]) => !['messages', 'input', 'system', 'instructions'].includes(key)))
    const cache = isRecord(event.attributes?.cache_diagnostics) ? cloneSafe(event.attributes.cache_diagnostics) : null
    const previous = !isBranch ? run.attributes.cache_rounds?.at(-1) : null
    const previousRows = providerRows(isRecord(run._lastRequest) ? run._lastRequest : {})
    const previousBoundary = Number(previous?.stable_message_count ?? 0)
    const prefixStable = previous && previousBoundary <= previousRows.length && previousBoundary <= rows.length
      ? stableText(previousRows.slice(0, previousBoundary)) === stableText(rows.slice(0, previousBoundary)) : null
    const canonical = isRecord(run.attributes.canonical_events) ? cloneSafe(run.attributes.canonical_events) : null
    const assembly = {
      system: { location: body.system != null ? 'system' : body.instructions != null ? 'instructions' : 'messages[0]', reused: (event.round ?? 0) > 1, source_round: 1 },
      messages: { count: rows.length, round: event.round ?? 0 },
      ...(cache ? { cache: { ...cache, prefix_unchanged: prefixStable } } : {}),
      ...(canonical ? { canonical_events: canonical } : {}),
      provider_history_sanitization: cloneSafe(event.attributes?.history_sanitization ?? null),
      adapter: { provider: event.attributes?.provider, api_format: event.attributes?.protocol },
      canonical_context: {
        phase: 'provider-input', provider_message_count: rows.length,
        ...run._spans.get(`${roundId}:context:provider-layout`)?.output,
        prefix_integrity: { stable: prefixStable,
          basis: 'stable_prefix_digest' },
      },
    }
    span.input = {
      ...(system !== undefined ? { system_prompt: system } : {}),
      messages,
      provider_options: providerOptions,
      provider_request: {
        fields: Object.keys(body),
        history_field: Array.isArray(body.messages) ? 'messages' : Array.isArray(body.input) ? 'input' : null,
        message_count: rows.length,
        snapshot_message_index: snapshotMessage ? rows.indexOf(snapshotMessage) : null,
        body_bytes: new TextEncoder().encode(JSON.stringify(body)).byteLength,
        body_digest: digestText(body),
      },
      assembly,
    }
    span.attributes = { ...span.attributes, ...cloneSafe(event.attributes ?? {}), round: event.round ?? 0 }
    span.status = 'running'
    if (!isBranch) {
      run._lastRequest = body
      run.input = { user_message: userMessage(body), system_prompt: systemText(body) }
    }
    const contextId = `${modelSpanId}:context`
    const context = spanFor(run, event, contextId, 'Provider context', 'context', modelSpanId)
    context.input = { protocol: event.attributes?.protocol }
    context.output = span.input.provider_request
    context.attributes = { context_source: 'provider_request', provider: event.attributes?.provider, model: event.attributes?.model }
    context.status = 'success'; context.ended_at = event.at / 1000; context.duration_ms = 0
    if (cache && !isBranch) {
      const cacheRound = { at: event.at / 1000, provider: event.attributes?.provider, model: event.attributes?.model,
        api_format: event.attributes?.protocol, round: event.round ?? 0, ...cache,
        prefix_unchanged: prefixStable }
      run.attributes.cache_rounds ??= []
      run.attributes.cache_rounds.push(cacheRound)
      run.attributes.cache_rounds.splice(12)
      const cacheSpan = spanFor(run, event, `${modelSpanId}:cache`, 'Provider cache boundary', 'cache', modelSpanId)
      cacheSpan.input = { stable_message_count: cache.stable_message_count, cache_anchor_indices: cache.cache_anchor_indices }
      cacheSpan.output = cacheRound
      cacheSpan.status = 'success'; cacheSpan.ended_at = event.at / 1000; cacheSpan.duration_ms = 0
    }
    if (event.attributes?.history_sanitization) run.attributes.history_sanitization = cloneSafe(event.attributes.history_sanitization)
    if (!isBranch && !run._adapterRequests.has(spanId)) {
      run._adapterRequests.add(spanId)
      const calls = run.attributes.adapter_calls ??= { count: 0, success: 0, errors: 0, canonical_render_calls: 0, by_provider: {}, by_api_format: {} }
      calls.count += 1
      if (canonical?.count) calls.canonical_render_calls += 1
      const provider = String(event.attributes?.provider ?? 'unknown')
      const format = String(event.attributes?.protocol ?? 'unknown')
      calls.by_provider[provider] = (calls.by_provider[provider] ?? 0) + 1
      calls.by_api_format[format] = (calls.by_api_format[format] ?? 0) + 1
    }
    return
  }
  if (event.kind === 'provider' && event.name === 'timing') {
    const span = run._spans.get(`${run.id}:round:${event.round ?? 0}`)
    if (span) {
      const timings = span.attributes.request_timings ??= []
      timings.push(cloneSafe(event.attributes ?? {}))
    }
    return
  }
  if (event.kind === 'provider' && event.name === 'usage') {
    const shapedUsage = usageShape(event.usage)
    if (event.attributes?.purpose !== 'branch') run.usage = addUsage(run.usage, shapedUsage)
    const requestId = localSpanId(run, event, event.spanId ?? `${event.identity.runId}:round:${event.round}:provider`)
    const spanId = event.attributes?.purpose === 'branch' ? requestId : `${run.id}:round:${event.round ?? 0}`
    const span = run._spans.get(spanId)
    if (span) {
      span.usage = shapedUsage
      if (shapedUsage.input > 0) span.token_impact = { prompt_tokens_actual: shapedUsage.input, prompt_tokens_source: 'provider' }
      if (event.attributes?.purpose !== 'branch') {
        const rounds = run.attributes.cache_rounds ?? []
        const current = [...rounds].reverse().find(item => item.round === (event.round ?? 0))
        if (current) {
          current.input_tokens = shapedUsage.input
          current.cache_read_tokens = shapedUsage.cache_read
          current.cache_write_tokens = shapedUsage.cache_write
          current.cache_hit_ratio = shapedUsage.cache_ratio
          const messages = Array.isArray(span.input?.messages) ? [...span.input.messages] : []
          if (span.input?.snapshot) messages.push(span.input.snapshot)
          const summaries = messages.map(row => contentText(row?.content ?? row)).filter(value => value.includes('<compacted-summary>'))
          const memory = [...run._spans.values()].filter(item => item.kind === 'context' && /memory/i.test(item.name))
            .map(item => [item.name, item.output])
          current.system_digest = digestText(span.input?.system_prompt ?? '')
          current.summary_digest = digestText(summaries)
          current.memory_digest = digestText(memory)
          const previous = [...rounds].reverse().find(item => item.round < current.round && Number.isFinite(item.cache_hit_ratio))
          cacheDropProbe(run, span, previous, current)
          const cacheSpan = run._spans.get(`${run.id}:round:${event.round ?? 0}:cache`)
          if (cacheSpan) cacheSpan.output = cloneSafe(current)
        }
      }
    }
    return
  }
  if (event.kind === 'provider' && event.name === 'complete') {
    const requestId = localSpanId(run, event, event.spanId ?? `${event.identity.runId}:round:${event.round}:provider`)
    const isBranch = event.attributes?.purpose === 'branch'
    const spanId = isBranch ? requestId : `${run.id}:round:${event.round ?? 0}`
    const span = run._spans.get(spanId)
    if (span) {
      if (event.output !== undefined) span.output = cloneSafe(event.output)
      span.attributes = { ...span.attributes, ...cloneSafe(event.attributes ?? {}) }
      span.status = event.status ?? 'success'; span.ended_at = event.at / 1000
      span.duration_ms = Math.max(0, (span.ended_at - span.started_at) * 1000)
    }
    if (!isBranch && run._adapterRequests.has(requestId) && !run._adapterResults.has(requestId)) {
      run._adapterResults.add(requestId)
      const calls = run.attributes.adapter_calls
      if (calls) calls[event.status === 'success' ? 'success' : 'errors'] += 1
    }
    if (isBranch) {
      const round = run._spans.get(roundId)
      if (round) {
        round.output = cloneSafe(event.output ?? '')
        round.attributes = { ...round.attributes, ...cloneSafe(event.attributes ?? {}) }
        round.status = event.status ?? 'success'; round.ended_at = event.at / 1000
        round.duration_ms = Math.max(0, (round.ended_at - round.started_at) * 1000)
      }
    }
    return
  }
  if (event.kind === 'tool') {
    const hasStart = run._spans.has(spanId) || Number.isFinite(event.startedAt)
    const span = spanFor(run, event, spanId, event.name, 'tool', event.parentSpanId ? localSpanId(run, event, event.parentSpanId) : roundId)
    if (event.input !== undefined) span.input = cloneSafe(event.input)
    if (event.output !== undefined) span.output = cloneSafe(event.output)
    span.attributes = { ...span.attributes, ...cloneSafe(event.attributes ?? {}) }
    if (Number.isFinite(event.startedAt)) span.started_at = event.startedAt / 1000
    span.status = event.status ?? span.status
    if (event.status !== 'running' && event.status !== 'waiting') {
      span.ended_at = event.at / 1000
      span.duration_ms = hasStart ? Math.max(0, (span.ended_at - span.started_at) * 1000) : null
    }
    if (event.attributes?.context_source === 'tool_schema_error') {
      const input = isRecord(span.input) ? span.input : {}
      const error = isRecord(input.error) ? input.error : {}
      const issues = Array.isArray(error.issues) ? error.issues : []
      const paths = [...new Set(issues.filter(isRecord).map(item => String(item.path ?? '')).filter(Boolean))].sort()
      const tool = String(event.attributes?.tool_name ?? input.tool_name ?? event.name).slice(0, 120)
      const kind = String(event.attributes?.error_kind ?? 'validation_error').slice(0, 80)
      const aggregate = run.attributes.tool_schema_errors ??= { count: 0, by_tool: {}, by_error_kind: {}, by_field_path: {}, by_provider: {} }
      aggregate.count += 1
      aggregate.by_tool[tool] = (aggregate.by_tool[tool] ?? 0) + 1
      aggregate.by_error_kind[kind] = (aggregate.by_error_kind[kind] ?? 0) + 1
      for (const path of paths) aggregate.by_field_path[path] = (aggregate.by_field_path[path] ?? 0) + 1
      const providers = Object.keys(run.attributes.adapter_calls?.by_provider ?? {})
      const provider = providers.length === 1 ? providers[0] : 'unknown'
      aggregate.by_provider[provider] = (aggregate.by_provider[provider] ?? 0) + 1
      if (input.schema) span.attributes = { ...span.attributes, schema_digest: digestText(input.schema) }
    }
    return
  }
  if (['output', 'history', 'guard', 'state'].includes(event.kind)) {
    const span = spanFor(run, event, spanId, event.name, event.kind,
      event.parentSpanId ? localSpanId(run, event, event.parentSpanId) : run.id)
    if (event.input !== undefined) span.input = cloneSafe(event.input)
    if (event.output !== undefined) span.output = cloneSafe(event.output)
    span.attributes = { ...span.attributes, ...cloneSafe(event.attributes ?? {}) }
    if (Number.isFinite(event.startedAt)) span.started_at = event.startedAt / 1000
    span.status = event.status ?? 'success'
    span.ended_at = (Number.isFinite(event.endedAt) ? event.endedAt : event.at) / 1000
    span.duration_ms = Number.isFinite(event.durationMs)
      ? Math.max(0, event.durationMs)
      : Math.max(0, (span.ended_at - span.started_at) * 1000)
    if (event.kind === 'state') {
      const allowed = ['phase', 'state_status', 'continuation_attempted', 'continuation_reused', 'continuation_unavailable',
        'state_model', 'state_provider', 'state_api_format', 'state_kind', 'state_size', 'state_version', 'sequence',
        'state_digest', 'invalidated_reason', 'unavailable_reason']
      const summary = {}
      for (const key of allowed) {
        const value = span.attributes[key]
        if (typeof value === 'boolean' || typeof value === 'string' && value.length <= 128
          || typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8 * 1024 * 1024)
          summary[key] = value
      }
      const bucket = run.attributes.reasoning_state ??= { events: [] }
      const previous = Object.fromEntries(Object.keys(summary).map(key => [key, bucket[key]]))
      Object.assign(bucket, summary)
      const eventSummary = Object.fromEntries(['phase', 'state_status', 'invalidated_reason', 'unavailable_reason']
        .filter(key => key in summary).map(key => [key, summary[key]]))
      if (Object.keys(eventSummary).length && stableText(eventSummary) !== stableText(Object.fromEntries(Object.keys(eventSummary).map(key => [key, previous[key] ?? null])))) {
        bucket.events.push(eventSummary)
        bucket.events.splice(0, Math.max(0, bucket.events.length - 12))
      }
    }
    return
  }
  if (event.kind === 'context') {
    const span = spanFor(run, event, spanId, event.name, 'context', event.parentSpanId ? localSpanId(run, event, event.parentSpanId) : run.id)
    if (event.input !== undefined) span.input = cloneSafe(event.input)
    if (event.output !== undefined) span.output = cloneSafe(event.output)
    span.attributes = { ...span.attributes, ...cloneSafe(event.attributes ?? {}) }
    if (Number.isFinite(event.startedAt)) span.started_at = event.startedAt / 1000
    span.status = event.status ?? 'success'; span.ended_at = (Number.isFinite(event.endedAt) ? event.endedAt : event.at) / 1000
    span.duration_ms = Number.isFinite(event.durationMs)
      ? Math.max(0, event.durationMs)
      : Math.max(0, (span.ended_at - span.started_at) * 1000)
    if (event.attributes?.context_source === 'canonical_events' && isRecord(event.output)) {
      run.attributes.canonical_events = cloneSafe(event.output)
    }
    if (event.attributes?.context_source === 'canonical_history_fallback') {
      const bucket = run.attributes.canonical_history_fallback ??= { count: 0 }
      bucket.count = Math.min(1_000_000, bucket.count + 1)
    }
    if (event.attributes?.context_source === 'provider-input' && isRecord(event.output)) {
      const round = Number(event.round ?? 0)
      const model = run._spans.get(`${run.id}:round:${round}`)
      if (model && isRecord(model.input) && isRecord(model.input.assembly)) {
        const prior = isRecord(model.input.assembly.canonical_context) ? model.input.assembly.canonical_context : {}
        model.input.assembly.canonical_context = { ...prior, ...cloneSafe(event.output),
          prefix_integrity: prior.prefix_integrity }
      }
    }
    return
  }
  if (event.kind === 'round') {
    const span = spanFor(run, event, `${run.id}:round:${event.round ?? 0}`, `LLM round ${event.round ?? 0}`, 'llm', run.id)
    if (event.name === 'started') { span.status = 'running'; return }
    if (event.name === 'output_delta') {
      if (typeof event.output === 'string') {
        run._output += event.output
        span.output = cloneSafe(run._output)
      }
      return
    }
    if (event.name === 'completed') {
      span.output = cloneSafe(event.output ?? run._output)
      span.status = event.status ?? 'success'; span.ended_at = event.at / 1000
      span.duration_ms = Math.max(0, (span.ended_at - span.started_at) * 1000)
      run._output = ''
    }
    return
  }
  if (event.kind === 'run' && event.name === 'finished') {
    run.status = ({ completed: 'success', failed: 'error', cancelled: 'cancelled', unknown: 'unknown' })[event.status] ?? event.status ?? 'unknown'
    run.ended_at = event.at / 1000
    run.duration_ms = Math.max(0, event.at - run._startedAtMs)
    run.output = { text: event.output ?? run._output }
    if (event.usage) run.usage = usageShape(event.usage)
    const span = run._spans.get(run.id)
    if (span) { span.status = run.status; span.ended_at = run.ended_at; span.duration_ms = run.duration_ms; span.output = cloneSafe(run.output) }
    for (const provider of run._spans.values()) if (['provider', 'llm'].includes(provider.kind) && provider.status === 'running') {
      provider.status = run.status
      provider.ended_at = run.ended_at; provider.duration_ms = Math.max(0, (provider.ended_at - provider.started_at) * 1000)
    }
  }
}

function snapshot(run) {
  const { _spans, _startedAtMs, _output, _lastRequest, _maxSpans, _traceDisabled, _adapterRequests, _adapterResults, ...payload } = run
  payload.spans = [..._spans.values()].map(span => ({ ...span }))
  return cloneSafe(payload)
}

function unavailableTrace(run, originalBytes, maxBytes) {
  run._traceDisabled = true
  run._spans.clear()
  run._lastRequest = null
  run._output = ''
  run.input = {}
  run.output = {}
  run.attributes = { trace_capture_unavailable: 'trace_size_limit',
    trace_capture_original_bytes: originalBytes, trace_capture_max_bytes: maxBytes }
  const payload = snapshot(run)
  return { payload, size: new TextEncoder().encode(JSON.stringify(payload)).byteLength }
}

/** 可信 Host 开启采集后才构造；`record` 同步入队且不等待网络 I/O。 */
export function createLoopScopeTrace({ endpoint, transport, source = 'web', maxQueue = 64, maxRuns = 12, maxSpans = 600, maxTraceBytes = 48 * 1024 * 1024, maxQueueBytes = 64 * 1024 * 1024, requestTimeoutMs = 15000 }) {
  const base = String(endpoint ?? '').replace(/\/+$/, '')
  const parsed = new URL(base)
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('LoopScope Collector 地址配置无效')
  if (typeof transport?.request !== 'function') throw new TypeError('LoopScope 安全传输不可用')
  const runs = new Map(), queue = new Map(), queueSizes = new Map(), terminal = new Map()
  let queuedBytes = 0
  let pumping = false, closed = false
  const request = async (path, body) => {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), requestTimeoutMs)
    timer.unref?.()
    try {
      // Collector 与 Host 可独立部署，使用普通 JSON 上报协议。
      const response = await transport.request({
        url: `${base}/api/collector/${path}`, method: 'POST', allowLocal: true,
        headers: { 'content-type': 'application/json' }, body,
      }, controller.signal)
      await response.cancel?.()
      if (response.status < 200 || response.status >= 300) throw new Error(`collector_status_${response.status}`)
    } finally { clearTimeout(timer) }
  }
  const pump = async () => {
    if (pumping || closed) return
    pumping = true
    try {
      while (!closed && (queue.size || terminal.size)) {
        const [id, payload] = queue.entries().next().value ?? []
        if (id) { queue.delete(id); queuedBytes -= queueSizes.get(id) ?? 0; queueSizes.delete(id) }
        const finish = id ? terminal.get(id) : [...terminal.entries()][0]?.[1]
        const finishId = id && finish ? id : [...terminal.keys()][0]
        try {
          if (id) await request('runs', payload)
          if (finishId && finish && !queue.has(finishId)) {
            await request(`runs/${encodeURIComponent(finishId)}/finish`, finish)
            terminal.delete(finishId)
          }
        } catch {
          // spans 快照必须先成功落库，之后才能提交结束摘要。否则 runs 表会显示
          // 已完成，而最后一份 trace 仍停留在 running，Final response 也会丢失。
          // 请求期间如果有更新快照入队，保留较新的那份，不用旧快照覆盖。
          if (id && !queue.has(id)) {
            const size = new TextEncoder().encode(JSON.stringify(payload)).byteLength
            queue.set(id, payload); queueSizes.set(id, size); queuedBytes += size
          }
          if (finishId && finish) terminal.set(finishId, finish)
          await new Promise(resolve => setTimeout(resolve, 300))
          const retry = setTimeout(() => { void pump() }, 500)
          retry.unref?.()
          break
        }
      }
    } finally { pumping = false }
  }
  return {
    record(event) {
      if (closed || !event?.identity || !Number.isFinite(event.at)) return
      const id = `run-${safeId(event.identity.runId)}`
      let run = runs.get(id)
      if (!run) {
        if (runs.size >= maxRuns) {
          const oldest = runs.keys().next().value
          if (oldest) { runs.delete(oldest); queue.delete(oldest); queuedBytes -= queueSizes.get(oldest) ?? 0; queueSizes.delete(oldest); terminal.delete(oldest) }
        }
        run = createRun(event, source, maxSpans); runs.set(id, run)
      }
      updateRun(run, event)
      let payload = snapshot(run)
      let size = new TextEncoder().encode(JSON.stringify(payload)).byteLength
      if (run._traceDisabled || size > maxTraceBytes) {
        const unavailable = unavailableTrace(run, size, maxTraceBytes)
        payload = unavailable.payload
        size = unavailable.size
      }
      queue.delete(id); queuedBytes -= queueSizes.get(id) ?? 0
      queue.set(id, payload); queueSizes.set(id, size); queuedBytes += size
      if (payload.ended_at !== null) terminal.set(id, {
        id: payload.id, session_key: payload.session_key, external_session_id: payload.external_session_id,
        source: payload.source, started_at: payload.started_at, status: payload.status,
        ended_at: payload.ended_at, duration_ms: payload.duration_ms,
      })
      while (queue.size > maxQueue || queuedBytes > maxQueueBytes) {
        // 结束快照承载最终状态和 Final response；队列压力下只淘汰仍在运行的快照。
        // 已结束的快照数量由 maxRuns 限制，短暂超出队列字节预算优于丢失最终 trace。
        const oldest = [...queue.keys()].find(queuedId => !terminal.has(queuedId))
        if (!oldest) break
        queue.delete(oldest); queuedBytes -= queueSizes.get(oldest) ?? 0; queueSizes.delete(oldest)
        const dropped = runs.get(oldest)
        if (dropped) dropped.attributes.observation_queue_dropped = true
      }
      void pump()
    },
    async close(drainMs = 2000) {
      const until = Date.now() + Math.max(0, drainMs)
      while (Date.now() < until) {
        if (!pumping && (queue.size || terminal.size)) void pump()
        if (!pumping && !queue.size && !terminal.size) break
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      closed = true; queue.clear(); queueSizes.clear(); queuedBytes = 0; terminal.clear(); runs.clear()
    },
  }
}
