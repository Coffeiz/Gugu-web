import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Pool, PoolClient } from 'pg'
import { createPostgresAgentChatPreparation, type AgentChatPreparationPorts } from '../../src/modules/agent-sessions/persistence/agent-chat-preparation.js'
function fixture(failure?: string) {
  const calls: string[] = []
  const dispatchInputs: Array<{ owner: string; session: string; run: string; accessVersion: string }> = []
  const client = { async query(sql: string) {
    calls.push(sql)
    if (sql.startsWith('SELECT id')) return { rowCount: 1, rows: [{ id: 7 }] }
    if (sql.startsWith('UPDATE conversation_sessions')) return { rowCount: 1, rows: [{ last_message_seq: '8' }] }
    if (sql.includes('RETURNING id')) return { rowCount: 1, rows: [{ id: 21 }] }
    return { rowCount: 1, rows: [] }
  }, release() { calls.push('release') } } as unknown as PoolClient
  const ports: AgentChatPreparationPorts = {
    async createSession() { return 7 },
    async registerStartup() { return failure !== "startup" },
    async enqueueDispatch(_client, identity, input) { assert.equal(input.v, 2); assert.equal(input.source, 'web'); dispatchInputs.push({ owner: identity.ownerId, session: identity.sessionId, run: identity.runId, accessVersion: input.accessVersion }); if (failure === "dispatch") throw new Error("调度失败") },
    async resolveAttachments(db) { assert.equal(db, client); return { cards: [{ attach_id: 'a' }], attachIds: ['a'] } },
    async resolveReferences(db) { assert.equal(db, client); return null },
    async claimAttachments(db, owner, message, ids) { assert.equal(db, client); assert.equal(owner, 'owner'); assert.equal(message, 21); assert.deepEqual(ids, ['a']); if (failure === 'attachments') throw new Error('附件失效') },
    async bindQueue(db) { assert.equal(db, client); if (failure === 'queue') throw new Error('队列冲突') },
  }
  return { calls, dispatchInputs, prepare: createPostgresAgentChatPreparation({ async connect() { return client } } as unknown as Pick<Pool, 'connect'>, ports) }
}
test('消息与附件和队列在同一事务提交并返回消息锚点', async () => {
  const value = fixture()
  assert.deepEqual(await value.prepare('owner', { session_id: 7, message: '你好' }, 'run-1', { mode: 'dispatch', origin: null, accessVersion: 'a'.repeat(64), ttlSeconds: 60 }), { sessionId: 7, userMessageId: 21, isNew: false, runId: 'run-1' })
  assert.equal(value.calls.includes('COMMIT'), true)
  assert.equal(value.calls.includes('ROLLBACK'), false)
})
test('调度访问版本在事务内绑定最终 owner/session/run 身份', async () => {
  const value = fixture()
  const resolvedIdentity: string[] = []
  const result = await value.prepare('owner', { session_id: 7, message: '你好' }, 'run-2', {
    mode: 'dispatch', origin: null, accessVersion: async identity => {
      resolvedIdentity.push(`${identity.ownerId}:${identity.sessionId}:${identity.runId}`)
      return 'b'.repeat(64)
    }, ttlSeconds: 60,
  })
  assert.equal(result.sessionId, 7)
  assert.deepEqual(resolvedIdentity, ['owner:7:run-2'])
  assert.deepEqual(value.dispatchInputs, [{ owner: 'owner', session: '7', run: 'run-2', accessVersion: 'b'.repeat(64) }])
  assert.equal(value.calls.includes('COMMIT'), true)
})
test('无效的动态访问版本阻止 dispatch 并回滚消息事务', async () => {
  const value = fixture()
  await assert.rejects(value.prepare('owner', { session_id: 7, message: '你好' }, 'run-3', {
    mode: 'dispatch', origin: null, accessVersion: async () => 'untrusted', ttlSeconds: 60,
  }), /访问范围版本无效/)
  assert.deepEqual(value.dispatchInputs, [])
  assert.equal(value.calls.includes('ROLLBACK'), true)
  assert.equal(value.calls.includes('COMMIT'), false)
})
for (const failure of ['startup', 'attachments', 'queue', 'dispatch']) test(`${failure} 失败回滚用户消息`, async () => {
  const value = fixture(failure)
  await assert.rejects(value.prepare('owner', { session_id: 7, message: '你好' }, 'run-1', { mode: 'dispatch', origin: null, accessVersion: 'a'.repeat(64), ttlSeconds: 60 }))
  assert.equal(value.calls.includes('ROLLBACK'), true)
  assert.equal(value.calls.includes('COMMIT'), false)
})
