import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createWebAgentLog } from '../../../src/modules/agent/run/diagnostics.js'
import { createSecurityEventFingerprint } from '../../../src/modules/admin/audit.js'

test('管理后台的 Web 日志记录脱敏的 Agent 失败诊断', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gugu-agent-failure-log-'))
  const file = join(dir, 'gugu.log')
  try {
    const log = createWebAgentLog(file, createSecurityEventFingerprint('synthetic-log-key')).diagnose
    const identity = { ownerId: 'synthetic-owner', sessionId: 'synthetic-session', runId: 'synthetic-run' }
    await log('run_failed', { identity, phase: 'prepare', error: Object.assign(new Error('合成私有正文'), { code: '42703' }) })
    await log('run_failed', { identity, phase: 'idle', error: Object.assign(new Error('合成凭据'), { code: 'synthetic-private-code' }) })
    const text = await readFile(file, 'utf8')
    const records = text.trim().split('\n').map(line => JSON.parse(line))
    assert.deepEqual(records.map(record => record.attributes), [
      { phase: 'prepare', errorCode: '42703' },
      { phase: 'idle', errorCode: 'internal_error' },
    ])
    assert.ok(records.every(record => record.event === 'agent.run.failure' && /^[a-f0-9]{16}$/.test(record.run)))
    const diagnostic = await readFile(join(dir, 'gugu-diag.log'), 'utf8')
    const traces = diagnostic.trim().split('\n').map(line => JSON.parse(line))
    assert.deepEqual(traces.map(record => record.run), records.map(record => record.run))
    assert.ok(traces[0].frames.some((frame: string) => frame.startsWith(`${basename(fileURLToPath(import.meta.url))}:`)))
    assert.doesNotMatch(diagnostic, /synthetic-|私有正文|合成凭据/)
    assert.doesNotMatch(text, /synthetic-|私有正文|合成凭据/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
