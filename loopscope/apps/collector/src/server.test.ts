import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp } from 'node:fs/promises'
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
