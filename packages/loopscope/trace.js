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
const usageShape = usage => {
  if (!isRecord(usage)) return {}
  const pairs = [['input','input'],['output','output'],['cacheRead','cache_read'],['cacheWrite','cache_write'],['freshInput','fresh_input'],['total','total'],['cacheRatio','cache_ratio'],['contextInput','context_input']]
  return Object.fromEntries(pairs.filter(([key]) => typeof usage[key] === 'number' && Number.isFinite(usage[key])).map(([key, target]) => [target, usage[key]]))
}
const providerRows = body => Array.isArray(body?.messages) ? body.messages : Array.isArray(body?.input) ? body.input : []
const userMessage = body => {
  const rows = providerRows(body)
  const message = [...rows].reverse().find(row => isRecord(row) && row.role === 'user')
  return message ? textOf(message.content ?? message) : ''
}
const systemText = body => {
  const value = body?.system ?? body?.instructions ?? providerRows(body).find(row => isRecord(row) && row.role === 'system')?.content
  return textOf(value)
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
    return
  }
  const roundId = `${run.id}:round:${event.round ?? 0}`
  const spanId = event.spanId ? localSpanId(run, event, event.spanId) : `${roundId}:${safeId(event.name)}`
  if (event.kind === 'provider' && event.name === 'request') {
    const body = isRecord(event.input) ? cloneSafe(event.input) : {}
    if (event.attributes?.purpose === 'branch') {
      const round = spanFor(run, { ...event, kind: 'round', name: 'started' }, roundId, `Round ${event.round ?? 0}`, 'round', run.id)
      round.status = 'running'
    }
    const span = spanFor(run, event, spanId, 'Provider request', 'provider', roundId)
    span.input = body
    span.attributes = cloneSafe(event.attributes ?? {})
    span.status = 'running'
    run._lastRequest = body
    run.input = { user_message: userMessage(body), system_prompt: systemText(body) }
    const contextId = `${spanId}:context`
    const context = spanFor(run, event, contextId, 'Provider context', 'context', spanId)
    context.input = { protocol: event.attributes?.protocol }
    context.output = body
    context.attributes = { context_source: 'provider_request', provider: event.attributes?.provider, model: event.attributes?.model }
    context.status = 'success'; context.ended_at = event.at / 1000; context.duration_ms = 0
    const cache = isRecord(event.attributes?.cache_diagnostics) ? cloneSafe(event.attributes.cache_diagnostics) : null
    if (cache) {
      const previous = run.attributes.cache_rounds?.at(-1)
      const cacheRound = { at: event.at / 1000, provider: event.attributes?.provider, model: event.attributes?.model,
        api_format: event.attributes?.protocol, ...cache,
        prefix_unchanged: previous && typeof cache.stable_prefix_digest === 'string'
          ? previous.stable_prefix_digest === cache.stable_prefix_digest : null }
      run.attributes.cache_rounds ??= []
      run.attributes.cache_rounds.push(cacheRound)
      run.attributes.cache_rounds.splice(12)
      const cacheSpan = spanFor(run, event, `${spanId}:cache`, 'Provider cache boundary', 'cache', spanId)
      cacheSpan.input = { stable_message_count: cache.stable_message_count, cache_anchor_indices: cache.cache_anchor_indices }
      cacheSpan.output = cacheRound
      cacheSpan.status = 'success'; cacheSpan.ended_at = event.at / 1000; cacheSpan.duration_ms = 0
    }
    if (event.attributes?.history_sanitization) run.attributes.history_sanitization = cloneSafe(event.attributes.history_sanitization)
    return
  }
  if (event.kind === 'provider' && event.name === 'usage') {
    if (event.attributes?.purpose !== 'branch') run.usage = usageShape(event.usage)
    const span = run._spans.get(localSpanId(run, event, event.spanId ?? `${event.identity.runId}:round:${event.round}:provider`))
    if (span) {
      span.usage = usageShape(event.usage); span.status = 'success'; span.ended_at = event.at / 1000
      span.duration_ms = Math.max(0, (span.ended_at - span.started_at) * 1000)
    }
    return
  }
  if (event.kind === 'provider' && event.name === 'complete') {
    const span = run._spans.get(localSpanId(run, event, event.spanId ?? `${event.identity.runId}:round:${event.round}:provider`))
    if (span) {
      if (event.output !== undefined) span.output = cloneSafe(event.output)
      span.attributes = { ...span.attributes, ...cloneSafe(event.attributes ?? {}) }
      span.status = event.status ?? 'success'; span.ended_at = event.at / 1000
      span.duration_ms = Math.max(0, (span.ended_at - span.started_at) * 1000)
    }
    if (event.attributes?.purpose === 'branch') {
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
    const span = spanFor(run, event, spanId, event.name, 'tool', event.parentSpanId ? localSpanId(run, event, event.parentSpanId) : roundId)
    if (event.input !== undefined) span.input = cloneSafe(event.input)
    if (event.output !== undefined) span.output = cloneSafe(event.output)
    span.attributes = { ...span.attributes, ...cloneSafe(event.attributes ?? {}) }
    span.status = event.status ?? span.status
    if (event.status !== 'running' && event.status !== 'waiting') {
      span.ended_at = event.at / 1000
      span.duration_ms = Math.max(0, (span.ended_at - span.started_at) * 1000)
    }
    return
  }
  if (event.kind === 'context') {
    const span = spanFor(run, event, spanId, event.name, 'context', event.parentSpanId ? localSpanId(run, event, event.parentSpanId) : run.id)
    if (event.input !== undefined) span.input = cloneSafe(event.input)
    if (event.output !== undefined) span.output = cloneSafe(event.output)
    span.attributes = { ...span.attributes, ...cloneSafe(event.attributes ?? {}) }
    span.status = event.status ?? 'success'; span.ended_at = event.at / 1000; span.duration_ms = 0
    return
  }
  if (event.kind === 'round') {
    const span = spanFor(run, event, `${run.id}:round:${event.round ?? 0}`, `Round ${event.round ?? 0}`, 'round', run.id)
    if (event.name === 'started') { span.status = 'running'; return }
    if (event.name === 'output_delta') { if (typeof event.output === 'string') run._output += event.output; return }
    if (event.name === 'completed') {
      span.output = cloneSafe(event.output ?? run._output)
      span.status = event.status ?? 'success'; span.ended_at = event.at / 1000
      span.duration_ms = Math.max(0, (span.ended_at - span.started_at) * 1000)
      const provider = run._spans.get(`${run.id}:round:${event.round ?? 0}:provider`)
      if (provider && provider.status === 'running') {
        provider.status = 'success'; provider.ended_at = event.at / 1000
        provider.duration_ms = Math.max(0, (provider.ended_at - provider.started_at) * 1000)
      }
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
    for (const provider of run._spans.values()) if (provider.kind === 'provider' && provider.status === 'running') {
      provider.status = run.status
      provider.ended_at = run.ended_at; provider.duration_ms = Math.max(0, (provider.ended_at - provider.started_at) * 1000)
    }
  }
}

function snapshot(run) {
  const { _spans, _startedAtMs, _output, _lastRequest, _maxSpans, _traceDisabled, ...payload } = run
  payload.spans = [..._spans.values()].map(span => ({ ...span }))
  return cloneSafe(payload)
}

/** 可信 Host 开启采集后才构造；`record` 同步入队且不等待网络 I/O。 */
export function createLoopScopeTrace({ endpoint, transport, source = 'web', maxQueue = 64, maxRuns = 12, maxSpans = 600, maxTraceBytes = 16 * 1024 * 1024, maxQueueBytes = 32 * 1024 * 1024, requestTimeoutMs = 2500 }) {
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
      const response = await transport.request({ url: `${base}/api/collector/${path}`, method: 'POST', allowLocal: true,
        headers: { 'content-type': 'application/json' }, body }, controller.signal)
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
          if (id && payload.status === 'running') {
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
      if (size > maxTraceBytes && !run._traceDisabled) {
        run._spans.clear(); run._output = ''; run.input = {}; run.output = {}
        run.attributes = { trace_capture_unavailable: 'trace_size_limit' }; run._traceDisabled = true
        payload = snapshot(run)
        size = new TextEncoder().encode(JSON.stringify(payload)).byteLength
      }
      queue.delete(id); queuedBytes -= queueSizes.get(id) ?? 0
      queue.set(id, payload); queueSizes.set(id, size); queuedBytes += size
      while (queue.size > maxQueue || queuedBytes > maxQueueBytes) {
        const oldest = queue.keys().next().value
        if (!oldest) break
        queue.delete(oldest); queuedBytes -= queueSizes.get(oldest) ?? 0; queueSizes.delete(oldest)
        const dropped = runs.get(oldest)
        if (dropped) dropped.attributes.observation_queue_dropped = true
      }
      if (payload.ended_at !== null) terminal.set(id, {
        id: payload.id, session_key: payload.session_key, external_session_id: payload.external_session_id,
        source: payload.source, started_at: payload.started_at, status: payload.status,
        ended_at: payload.ended_at, duration_ms: payload.duration_ms,
      })
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
