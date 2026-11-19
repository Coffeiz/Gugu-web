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
  emit({ kind: 'provider', name: 'request', round: 1, input: {
    model: 'fixture-model', system: 'system fixture', messages: [{ role: 'user', content: 'synthetic user text' }],
    tools: [{ name: 'lookup', parameters: { type: 'object' } }], headers: { authorization: 'never persist' },
  }, attributes: { provider: 'fixture', protocol: 'openai' } })
  emit({ kind: 'provider', name: 'usage', round: 1, usage: { input: 7, output: 3, cacheRead: 2, cacheWrite: 1 } })
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
