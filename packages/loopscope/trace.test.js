import assert from 'node:assert/strict'
import test from 'node:test'
import { createLoopScopeTrace, loopScopeTraceEnabled } from './trace.js'

const identity = { ownerId: 'owner-fixture', sessionId: 'session-fixture', runId: 'run-fixture' }
const tick = (() => { let at = 1_800_000_000_000; return () => at += 10 })()
const response = () => ({ status: 200, cancel() {} })

test('trace gate accepts Python-compatible values and rejects disabled values', () => {
  for (const value of ['1', 'true', 'yes', 'on', ' TRUE ']) assert.equal(loopScopeTraceEnabled(value), true)
  for (const value of [undefined, '', '0', 'false', 'enabled']) assert.equal(loopScopeTraceEnabled(value), false)
})

test('Core observations replay as Collector snapshots with request context, usage, tools, and terminal status', async () => {
  const sent = []
  const trace = createLoopScopeTrace({ endpoint: 'http://127.0.0.1:4320', transport: { async request(request) { sent.push(request); return response() } } })
  const emit = (event) => trace.record({ identity, at: tick(), ...event })
  emit({ kind: 'run', name: 'started', status: 'running', spanId: identity.runId })
  emit({ kind: 'round', name: 'started', status: 'running', round: 1 })
  emit({ kind: 'provider', name: 'request', round: 1, spanId: `${identity.runId}:round:1:provider`, input: {
    model: 'fixture-model', system: 'system fixture', messages: [{ role: 'user', content: 'synthetic user text' }],
    tools: [{ name: 'lookup', parameters: { type: 'object' } }], headers: { authorization: 'never persist' },
  }, attributes: { provider: 'fixture', protocol: 'openai' } })
  emit({ kind: 'provider', name: 'usage', round: 1, usage: { input: 7, output: 3, cacheRead: 2, cacheWrite: 1 } })
  emit({ kind: 'provider', name: 'complete', round: 1, spanId: `${identity.runId}:round:1:provider`, status: 'success', output: 'synthetic model output' })
  emit({ kind: 'tool', name: 'lookup', round: 1, spanId: `${identity.runId}:round:1:tool:call-1`, parentSpanId: `${identity.runId}:round:1`, status: 'success', input: { query: 'synthetic query' }, output: { result: 'synthetic result' } })
  emit({ kind: 'round', name: 'completed', status: 'success', round: 1, output: 'synthetic assistant output' })
  emit({ kind: 'run', name: 'finished', status: 'completed', spanId: identity.runId, output: 'synthetic assistant output', usage: { input: 7, output: 3, cacheRead: 2, cacheWrite: 1 } })
  await new Promise(resolve => setTimeout(resolve, 20))
  await trace.close()

  const snapshot = sent.filter(item => item.url.endsWith('/api/collector/runs')).at(-1)?.body
  assert.ok(snapshot)
  assert.equal(snapshot.status, 'success')
  assert.equal(snapshot.input.user_message, 'synthetic user text')
  assert.equal(snapshot.spans.find(span => span.kind === 'provider')?.input.model, 'fixture-model')
  assert.equal(snapshot.spans.find(span => span.kind === 'provider')?.output, 'synthetic model output')
  assert.deepEqual(snapshot.spans.find(span => span.kind === 'tool')?.output, { result: 'synthetic result' })
  assert.equal(snapshot.usage.cache_read, 2)
  assert.equal(JSON.stringify(snapshot).includes('never persist'), false)
  assert.ok(sent.some(item => item.url.endsWith(`/api/collector/runs/${snapshot.id}/finish`)))
})

test('record remains synchronous when Collector transport is offline', () => {
  const trace = createLoopScopeTrace({ endpoint: 'http://127.0.0.1:4320', transport: { async request() { throw new Error('offline') } } })
  assert.doesNotThrow(() => trace.record({ identity, at: tick(), kind: 'run', name: 'started', status: 'running' }))
  void trace.close(0)
})

test('context phase spans preserve the Core measured duration', async () => {
  const sent = []
  const trace = createLoopScopeTrace({ endpoint: 'http://127.0.0.1:4320', transport: { async request(request) { sent.push(request); return response() } } })
  const endedAt = tick()
  trace.record({ identity, kind: 'run', name: 'started', at: endedAt - 500, status: 'running', spanId: identity.runId })
  trace.record({ identity, kind: 'context', name: 'Agent context prepared', at: endedAt, startedAt: endedAt - 125,
    endedAt, durationMs: 125, status: 'success', spanId: `${identity.runId}:phase:1`, parentSpanId: identity.runId })
  trace.record({ identity, kind: 'run', name: 'finished', at: endedAt + 10, status: 'completed', spanId: identity.runId })
  await new Promise(resolve => setTimeout(resolve, 20))
  await trace.close()

  const snapshot = sent.filter(item => item.url.endsWith('/api/collector/runs')).at(-1)?.body
  const phase = snapshot?.spans.find(span => span.name === 'Agent context prepared')
  assert.equal(phase?.duration_ms, 125)
  assert.equal(phase?.started_at, (endedAt - 125) / 1000)
  assert.equal(phase?.ended_at, endedAt / 1000)
})

test('branch Provider observations keep their own Round output and do not replace Run usage', async () => {
  const sent = []
  const trace = createLoopScopeTrace({ endpoint: 'http://127.0.0.1:4320', transport: { async request(request) { sent.push(request); return response() } } })
  const emit = event => trace.record({ identity, at: tick(), ...event })
  emit({ kind: 'run', name: 'started', status: 'running' })
  emit({ kind: 'provider', name: 'request', round: 0, spanId: `${identity.runId}:round:0:provider`, parentSpanId: `${identity.runId}:round:0`,
    input: { model: 'fixture-model', messages: [{ role: 'user', content: 'synthetic branch input' }] }, attributes: { purpose: 'branch' } })
  emit({ kind: 'provider', name: 'usage', round: 0, usage: { input: 11, output: 2 }, attributes: { purpose: 'branch' } })
  emit({ kind: 'provider', name: 'complete', round: 0, spanId: `${identity.runId}:round:0:provider`, status: 'success', output: 'synthetic branch output', attributes: { purpose: 'branch' } })
  emit({ kind: 'run', name: 'finished', status: 'completed' })
  await new Promise(resolve => setTimeout(resolve, 20))
  await trace.close()

  const snapshot = sent.filter(item => item.url.endsWith('/api/collector/runs')).at(-1)?.body
  assert.ok(snapshot)
  const round = snapshot.spans.find(span => span.kind === 'round' && span.name === 'Round 0')
  const provider = snapshot.spans.find(span => span.kind === 'provider')
  assert.equal(round.output, 'synthetic branch output')
  assert.equal(provider.output, 'synthetic branch output')
  assert.equal(provider.usage.input, 11)
  assert.equal(provider.status, 'success')
  assert.deepEqual(snapshot.usage, {})
})

test('branch Provider failures close only their own spans with a safe error category', async () => {
  const sent = []
  const trace = createLoopScopeTrace({ endpoint: 'http://127.0.0.1:4320', transport: { async request(request) { sent.push(request); return response() } } })
  const emit = event => trace.record({ identity, at: tick(), ...event })
  emit({ kind: 'run', name: 'started', status: 'running' })
  emit({ kind: 'provider', name: 'request', round: 0, spanId: `${identity.runId}:round:0:provider`, parentSpanId: `${identity.runId}:round:0`,
    input: { model: 'fixture-model' }, attributes: { purpose: 'branch' } })
  emit({ kind: 'provider', name: 'complete', round: 0, spanId: `${identity.runId}:round:0:provider`, status: 'error', attributes: { purpose: 'branch', error_code: 'authentication' } })
  emit({ kind: 'run', name: 'finished', status: 'completed' })
  await new Promise(resolve => setTimeout(resolve, 20))
  await trace.close()

  const snapshot = sent.filter(item => item.url.endsWith('/api/collector/runs')).at(-1)?.body
  assert.ok(snapshot)
  assert.equal(snapshot.spans.find(span => span.kind === 'round')?.status, 'error')
  assert.equal(snapshot.spans.find(span => span.kind === 'provider')?.status, 'error')
  assert.equal(snapshot.spans.find(span => span.kind === 'provider')?.attributes.error_code, 'authentication')
  assert.equal(JSON.stringify(snapshot).includes('synthetic upstream detail must not enter trace'), false)
})

test('大体积终态快照使用旧 Collector 可读取的 JSON，并保留模型输入及最终正文', async () => {
  const sent = []
  const trace = createLoopScopeTrace({
    endpoint: 'http://127.0.0.1:4320',
    transport: { async request(request) {
      if (request.headers['content-encoding']) return { status: 400 }
      sent.push(request)
      return response()
    } },
  })
  const emit = event => trace.record({ identity, at: tick(), ...event })
  const prompt = 'x'.repeat(1024 * 1024 + 1)
  emit({ kind: 'run', name: 'started' })
  emit({ kind: 'provider', name: 'request', round: 1, input: { messages: [{ role: 'user', content: prompt }] } })
  emit({ kind: 'output', name: 'Final response', output: '最终正文' })
  emit({ kind: 'run', name: 'finished', status: 'completed', output: '最终正文' })
  await trace.close()
  const snapshot = sent.find(request => request.url.endsWith('/runs') && request.body.ended_at != null)?.body
  assert.equal(snapshot?.status, 'success')
  assert.equal(snapshot.spans.find(span => span.kind === 'llm')?.input.messages[0].content, prompt)
  assert.equal(snapshot.spans.find(span => span.name === 'Final response')?.output, '最终正文')
})
