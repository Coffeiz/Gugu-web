import assert from 'node:assert/strict'
import test from 'node:test'
import { createWebAgentFilePathLookup } from '../../src/modules/agent/tools/files/paths.js'

const identity = { ownerId: '00000000-0000-4000-8000-000000000001', sessionId: '71', runId: 'grep-synthetic' }
const lease = { identity, token: 'lease-synthetic', fence: 5, mode: 'start', cancelRequested: false,
  input: { v: 2, source: 'web' } } as never

test('文件库路径解析 在访问数据库前拒绝身份不匹配或非 Web 来源', async () => {
  let calls = 0
  const pool = { async query() { calls++; return { rows: [] } } }
  const port = createWebAgentFilePathLookup(pool as never, lease)
  await assert.rejects(port.list({ ...identity, ownerId: '00000000-0000-4000-8000-000000000002' }, new AbortController().signal), /授权已失效/u)
  assert.equal(calls, 0)
  assert.throws(() => createWebAgentFilePathLookup(pool as never,
    { ...lease, input: { v: 2, source: 'telegram' } } as never), /来源无法验证/u)
})
