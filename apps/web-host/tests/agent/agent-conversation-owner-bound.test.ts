import assert from 'node:assert/strict'
import test from 'node:test'
import type { ConversationSearchPort } from '@gugu/core/tools'
import { bindAgentConversationSearchOwner } from '../../src/modules/agent/tools/conversations.js'

test('Web lease owner mismatch is rejected before conversation source access', async () => {
  const calls: string[] = []
  const source: ConversationSearchPort = {
    async recent() { calls.push('recent'); return [] },
    async search() { calls.push('search'); return [] },
    async resolve() { calls.push('resolve'); return null },
  }
  const port = bindAgentConversationSearchOwner(source, 'owner-a')
  const signal = new AbortController().signal
  const foreign = { ownerId: 'owner-b', sessionId: '42', runId: 'run-web' }

  await assert.rejects(port.recent(foreign, 5, signal), /运行身份不匹配/u)
  await assert.rejects(port.search(foreign, ['部署'], 'OR', 5, signal), /运行身份不匹配/u)
  await assert.rejects(port.resolve(foreign, { session_id: 42 }, signal), /运行身份不匹配/u)
  assert.deepEqual(calls, [])

  const cancelled = new AbortController()
  cancelled.abort()
  await assert.rejects(port.search(foreign, ['部署'], 'OR', 5, cancelled.signal), { name: 'AbortError' })
  assert.deepEqual(calls, [])

  const owner = { ...foreign, ownerId: 'OWNER-A' }
  assert.deepEqual(await port.recent(owner, 5, signal), [])
  assert.deepEqual(await port.search(owner, ['部署'], 'OR', 5, signal), [])
  assert.equal(await port.resolve(owner, { session_id: 42 }, signal), null)
  assert.deepEqual(calls, ['recent', 'search', 'resolve'])
})
