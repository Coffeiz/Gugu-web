import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { TraceStore } from './store.js'
import fixture from '../../../compat/trace-parity.json'

test('脱敏 parity fixture 的关键查询结构稳定', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loopscope-parity-'))
  const store = new TraceStore(path.join(directory, 'loopscope.db'))
  try {
    store.ingestRun(fixture)
    const sessions = store.listSessions()
    const runs = store.listRuns('gugu:test:parity')
    const run = store.getRun('run-parity-1')
    assert.deepEqual(sessions[0], {
      session_key: 'gugu:test:parity',
      external_session_id: 'parity',
      source: 'test',
      title: 'parity fixture',
      created_at: 100,
      updated_at: 125,
      run_count: 1,
      error_count: 0,
    })
    assert.equal(runs[0]?.id, 'run-parity-1')
    assert.ok(run && 'spans' in run)
    assert.equal(run.spans[0]?.code.file, 'backend/agent/loop_drivers.py')
    assert.ok(run)
    assert.equal(typeof run.input === 'object' && run.input !== null && 'user_message' in run.input, true)
    const spanPage = store.listSpans('run-parity-1')
    assert.ok(spanPage)
    assert.equal(spanPage.items.length, 1)
  } finally {
    store.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
