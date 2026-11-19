import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createWebAgentFailureLogger } from '../../src/modules/agent-sessions/agent-failure-log.js'
import { createSecurityEventFingerprint } from '../../src/modules/admin/audit.js'

test('管理后台的 Web 日志记录脱敏的 Agent 失败诊断', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gugu-agent-failure-log-'))
  const file = join(dir, 'gugu.log')
  try {
    const log = createWebAgentFailureLogger(file, createSecurityEventFingerprint('synthetic-log-key'))
    const identity = { ownerId: 'synthetic-owner', sessionId: 'synthetic-session', runId: 'synthetic-run' }
    await log('run_failed', { identity, phase: 'prepare', error: Object.assign(new Error('合成私有正文'), { code: '42703' }) })
    await log('run_failed', { identity, phase: 'idle', error: Object.assign(new Error('合成凭据'), { code: 'synthetic-private-code' }) })
    const text = await readFile(file, 'utf8')
    assert.match(text, /phase=prepare code=42703 run=[a-f0-9]{16}/)
    assert.match(text, /phase=idle code=internal_error run=[a-f0-9]{16}/)
    assert.doesNotMatch(text, /synthetic-|私有正文|合成凭据/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
