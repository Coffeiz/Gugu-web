import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { TraceStore } from './store.js'

test('TraceStore 对重复 run 上报保持幂等并可读回 spans', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loopscope-storage-'))
  const store = new TraceStore(path.join(directory, 'loopscope.db'))
  const payload = {
    id: 'run-test-1',
    trace_id: 'trace-test-1',
    session_key: 'session-test-1',
    external_session_id: 'external-test-1',
    source: 'test',
    status: 'success',
    started_at: 100,
    ended_at: 120,
    duration_ms: 20,
    input: { user_message: '测试输入' },
    output: { content: '测试输出' },
    attributes: {},
    usage: { input: 100, output: 10, cache_read: 80 },
    spans: [{
      id: 'span-test-1',
      kind: 'context',
      name: 'Context assembly',
      status: 'success',
      started_at: 101,
      ended_at: 102,
      duration_ms: 1,
      input: {},
      output: { content: '固定上下文' },
      attributes: {},
      usage: { input: 20 },
      token_impact: { included_tokens: 20 },
    }],
  }

  try {
    assert.deepEqual(store.ingestRun(payload), { ok: true, run_id: 'run-test-1', spans: 1 })
    assert.deepEqual(store.ingestRun(payload), { ok: true, run_id: 'run-test-1', spans: 1 })
    assert.equal(store.listSessions()[0]?.run_count, 1)
    const run = store.getRun('run-test-1')
    assert.ok(run && 'spans' in run)
    assert.equal(run.spans.length, 1)
    assert.equal(store.listContext('run-test-1')[0]?.content_markdown, '固定上下文')
    assert.equal(store.listUsage('run-test-1').length, 2)
  } finally {
    store.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('TraceStore 保留用户已有的会话标题并按 before 分页', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loopscope-storage-'))
  const store = new TraceStore(path.join(directory, 'loopscope.db'))
  try {
    const base = {
      session_key: 'session-title-1',
      source: 'test',
      status: 'success',
      input: {},
      output: {},
      attributes: {},
      spans: [],
    }
    store.ingestRun({ ...base, id: 'run-title-1', started_at: 1, title: '用户自定义标题' })
    store.ingestRun({ ...base, id: 'run-title-2', started_at: 2, title: '新标题不应覆盖' })
    store.ingestRun({ ...base, id: 'run-title-3', started_at: 3, title: '新标题不应覆盖' })

    assert.equal(store.listSessions()[0]?.title, '用户自定义标题')
    assert.deepEqual(store.listRuns('session-title-1', { limit: 2 }).map(run => run.id), ['run-title-2', 'run-title-3'])
    assert.deepEqual(store.listRuns('session-title-1', { limit: 2, before: 3 }).map(run => run.id), ['run-title-1', 'run-title-2'])
  } finally {
    store.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
