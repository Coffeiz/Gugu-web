import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createWebAgentLog } from '../../src/modules/agent/run/diagnostics.js'

test('Agent 循环结构日志保留完整时间和 Run 指纹且过滤非枚举字符串', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-agent-log-'))
  try {
    const file = join(root, 'agent.log')
    const logger = createWebAgentLog(file, value => `fp-${value.length}`).log
    logger.write({
      identity: { ownerId: 'owner-synthetic', sessionId: 'session-synthetic', runId: 'run-synthetic' },
      at: Date.parse('2026-11-19T04:05:06.789Z'), level: 'warn', event: 'agent.provider.error', round: 3,
      attributes: { errorCode: 'timeout', contextOverflow: false, untrusted: 'private-user-message', secretPin: 1234 },
    })
    const line = (await readFile(file, 'utf8')).trim()
    const record = JSON.parse(line)
    assert.equal(record.time, '2026-11-19T04:05:06.789Z')
    assert.equal(record.event, 'agent.provider.error')
    assert.equal(record.round, 3)
    assert.deepEqual(record.attributes, { errorCode: 'timeout', contextOverflow: false })
    assert.equal(line.includes('private-user-message'), false)
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})
