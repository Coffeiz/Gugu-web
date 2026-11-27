import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { TraceStore } from './store.js'

test('TraceStore 后续快照纠正平台后，run 应出现在正确的会话列表', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loopscope-routing-'))
  const store = new TraceStore(path.join(directory, 'trace.db'))
  const base = {
    id: 'run-mirror', trace_id: 'trace-mirror', external_session_id: '42',
    status: 'running', started_at: 100, spans: [],
  }
  try {
    store.ingestRun({ ...base, source: 'web', session_key: 'gugu:web:42' })
    store.ingestRun({ ...base, source: 'qq', session_key: 'gugu:qq:42',
      status: 'success', ended_at: 110, output: { text: '合成回复' } })
    assert.equal(store.getRun('run-mirror')?.session_key, 'gugu:qq:42')
    assert.equal(store.listRuns('gugu:qq:42').length, 1)
    assert.equal(store.listRuns('gugu:web:42').length, 0)
    assert.equal(store.getRun('run-mirror')?.status, 'success')
  } finally {
    store.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('桌面 IM 平台随会话列表返回，保留已有桌面会话键和运行历史', () => {
  const store = new TraceStore(':memory:')
  const base = { source: 'desktop', status: 'success', started_at: 100, spans: [] }
  try {
    store.ingestRun({ ...base, id: 'old', session_key: 'gugu:desktop:42', external_session_id: '42' })
    store.ingestRun({ ...base, id: 'new', session_key: 'gugu:desktop:42', external_session_id: '42',
      started_at: 101, attributes: { im_platform: 'wechat' } })
    store.ingestRun({ ...base, id: 'plain', session_key: 'gugu:desktop:43', external_session_id: '43' })
    assert.deepEqual(store.listSessions().map(row => [row.session_key, row.source, row.im_platform, row.run_count]), [
      ['gugu:desktop:42', 'desktop', 'wechat', 2],
      ['gugu:desktop:43', 'desktop', undefined, 1],
    ])
  } finally {
    store.close()
  }
})

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
    assert.equal(store.listContext('run-test-1')[0]?.token_count, null)
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
    assert.deepEqual(store.listRuns('session-title-1', { limit: 2 }).map(run => run.id), ['run-title-3', 'run-title-2'])
    assert.deepEqual(store.listRuns('session-title-1', { limit: 2, before: 3 }).map(run => run.id), ['run-title-2', 'run-title-1'])
  } finally {
    store.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('同一桌面会话的反思与对话分开查询，子代理保留父 Run 关系', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loopscope-reflections-'))
  const store = new TraceStore(path.join(directory, 'trace.db'))
  const base = { source: 'desktop', status: 'success', spans: [] }
  try {
    store.ingestRun({ ...base, id: 'main', session_key: 'desktop:1', started_at: 1 })
    store.ingestRun({ ...base, id: 'child', session_key: 'desktop:2', started_at: 2,
      attributes: { subagent_trace: { parent_session_id: '1', parent_run_id: 'main', child_id: 'aabbccdd', agent_id: 'builtin:searcher' } } })
    store.ingestRun({ ...base, id: 'reflection', session_key: 'desktop:2', started_at: 3,
      attributes: { scenario: 'reflection' } })
    store.ingestRun({ ...base, id: 'legacy', session_key: 'reflection:3', started_at: 4, source: 'reflection' })
    assert.deepEqual(store.listSessions().map(row => [row.session_key, row.run_count, row.parent_session_id, row.agent_id, row.child_id]),
      [['desktop:2', 1, '1', 'builtin:searcher', 'aabbccdd'], ['desktop:1', 1, undefined, undefined, undefined]])
    assert.deepEqual(store.listRuns('desktop:2').map(run => run.id), ['child'])
    assert.deepEqual(store.listReflectionRuns().map(run => run.id), ['legacy', 'reflection'])
  } finally {
    store.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
