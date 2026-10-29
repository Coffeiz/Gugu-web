import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { TraceStore } from '@loopscope/storage'
import { createCollectorServer } from './server.js'

const payload = {
  id: 'run-http-1',
  session_key: 'session-http-1',
  external_session_id: 'external-http-1',
  source: 'test',
  started_at: 100,
  ended_at: 101,
  status: 'success',
  input: { user_message: 'HTTP integration test' },
  output: { text: 'ok' },
  attributes: {},
  usage: { input: 100, output: 3, cache_read: 80 },
  spans: Array.from({ length: 3 }, (_, ordinal) => ({
    id: `span-http-${ordinal}`,
    kind: 'custom',
    name: `span ${ordinal}`,
    status: 'success',
    started_at: 100 + ordinal,
    ended_at: 101 + ordinal,
    input: {},
    output: {},
    attributes: {},
    code: {},
    usage: {},
    token_impact: {},
  })),
}

async function request(base: string, pathname: string, init?: RequestInit) {
  const response = await fetch(base + pathname, init)
  const body = await response.json() as unknown
  return { response, body }
}

test('失败请求经 Collector 和 SQLite 往返后完整保留原生推理与深层 Schema', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'loopscope-capture-'))
  const store = new TraceStore(path.join(directory, 'trace.db'))
  const server = createCollectorServer(store).listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const base = `http://127.0.0.1:${address.port}`
  const requestJson = JSON.stringify({
    model: 'synthetic-model',
    input: [{ type: 'reasoning', summary: [], content: [{ type: 'reasoning_text', text: '合成推理' }] }],
    tools: [{ parameters: { properties: { nested: { items: { properties: { value: { enum: ['合成选项'] } } } } } } }],
  })
  const capture = { protocol: 'responses', replayable: true, request_json: requestJson }
  const parent = { ...payload.spans[0]!, kind: 'llm', name: 'LLM round 2' }
  const child = {
    ...payload.spans[1]!, kind: 'context', name: 'Responses 失败请求',
    parent_span_id: parent.id, input: { provider_request_capture: capture },
  }
  try {
    const ingest = await request(base, '/api/collector/runs', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...payload, spans: [parent, child] }),
    })
    assert.equal(ingest.response.status, 200)
    const loaded = await request(base, `/api/runs/${payload.id}/spans`)
    assert.equal(loaded.response.status, 200)
    const spans = (loaded.body as { items: Array<Record<string, unknown>> }).items
    assert.equal(spans[1]?.parent_span_id, parent.id)
    assert.deepEqual(spans[1]?.input, { provider_request_capture: capture })
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    store.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('Collector HTTP API ingests and paginates traces', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'loopscope-collector-'))
  const store = new TraceStore(path.join(directory, 'trace.db'))
  const server = createCollectorServer(store).listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const base = `http://127.0.0.1:${address.port}`

  try {
    const health = await request(base, '/api/health')
    assert.equal(health.response.status, 200)
    assert.deepEqual(health.body, { ok: true, version: '0.3.0', runtime: 'node', orm: 'drizzle', db: path.join(directory, 'trace.db') })

    const ingest = await request(base, '/api/collector/runs', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    })
    assert.equal(ingest.response.status, 200)
    assert.deepEqual(ingest.body, { ok: true, run_id: 'run-http-1', spans: 3 })

    const sessions = await request(base, '/api/sessions')
    assert.equal(sessions.response.status, 200)
    assert.equal((sessions.body as Array<Record<string, unknown>>)[0]?.title, 'HTTP integration test')

    const runs = await request(base, '/api/sessions/session-http-1/runs?limit=1')
    assert.equal(runs.response.status, 200)
    assert.equal((runs.body as Array<Record<string, unknown>>).length, 1)

    const spans = await request(base, '/api/runs/run-http-1/spans?limit=2')
    assert.equal(spans.response.status, 200)
    assert.deepEqual(spans.body, {
      items: [
        { id: 'span-http-0', run_id: 'run-http-1', parent_span_id: null, kind: 'custom', name: 'span 0', status: 'success', started_at: 100, ended_at: 101, duration_ms: null, input: {}, output: {}, attributes: {}, code: {}, usage: {}, token_impact: {}, ordinal: 0 },
        { id: 'span-http-1', run_id: 'run-http-1', parent_span_id: null, kind: 'custom', name: 'span 1', status: 'success', started_at: 101, ended_at: 102, duration_ms: null, input: {}, output: {}, attributes: {}, code: {}, usage: {}, token_impact: {}, ordinal: 1 },
      ],
      offset: 0, limit: 2, hasMore: true,
    })

    const invalid = await request(base, '/api/runs/run-http-1/spans?limit=201')
    assert.equal(invalid.response.status, 400)
    const missing = await request(base, '/api/runs/missing')
    assert.equal(missing.response.status, 404)
    const malformed = await request(base, '/api/collector/runs', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{',
    })
    assert.equal(malformed.response.status, 400)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    store.close()
  }
})

test('Collector Monitor Run 列表只读摘要字段并显著缩小响应体', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'loopscope-run-summary-'))
  const store = new TraceStore(path.join(directory, 'trace.db'))
  const server = createCollectorServer(store).listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const base = `http://127.0.0.1:${address.port}`
  const largeContext = 'synthetic diagnostic context '.repeat(4_000)

  try {
    for (let index = 0; index < 20; index += 1) {
      store.ingestRun({
        ...payload,
        id: `summary-run-${index}`,
        session_key: 'summary-session',
        started_at: index + 1,
        input: { prompt: largeContext },
        output: { content: largeContext },
        attributes: { diagnostic_context: largeContext },
        usage: { input: 1200, output: 80 },
        spans: [],
      })
    }

    const fullStarted = performance.now()
    const fullList = store.listRuns('summary-session')
    const fullJson = JSON.stringify(fullList)
    const fullMs = performance.now() - fullStarted

    const summaryStarted = performance.now()
    const { response, body } = await request(base, '/api/sessions/summary-session/runs?limit=20')
    const summaryMs = performance.now() - summaryStarted
    assert.equal(response.status, 200)
    const summaries = body as Array<Record<string, any>>
    const fullBytes = Buffer.byteLength(fullJson)
    const summaryBytes = Buffer.byteLength(JSON.stringify(summaries))

    assert.equal(summaries.length, 20)
    assert.equal(summaries[0]?.id, 'summary-run-19')
    assert.ok(!('input' in (summaries[0] ?? {})))
    assert.ok(!('output' in (summaries[0] ?? {})))
    assert.ok(!('attributes' in (summaries[0] ?? {})))
    assert.ok(!('usage' in (summaries[0] ?? {})))
    assert.ok(summaryBytes < fullBytes / 100, `摘要 ${summaryBytes} B 应小于完整列表 ${fullBytes} B 的 1%`)
    if (process.env.LOOPSCOPE_BENCHMARK === '1') {
      console.log(`合成 A/B（20 Runs，约 3×100KB 上下文/Run）：完整列表 ${fullBytes} B / ${fullMs.toFixed(1)} ms；摘要接口 ${summaryBytes} B / ${summaryMs.toFixed(1)} ms`)
    }
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    store.close()
    await rm(directory, { recursive: true, force: true })
  }
})
