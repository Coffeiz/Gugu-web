import assert from 'node:assert/strict'
import test from 'node:test'
import type { PoolClient } from 'pg'
import { createPostgresAgentInteractionCommandEffects } from '../../src/domains/agent-sessions/persistence/agent-interaction-command-effects.js'

const ownerId = '00000000-0000-4000-8000-000000000001'

function clientFixture() {
  const calls: Array<{ text: string; values?: unknown[] }> = []
  const client = { async query(text: string, values?: unknown[]) {
    calls.push({ text, values })
    if (text.includes('FROM conversation_sessions') && text.includes('FOR UPDATE')) return values?.[1] === ownerId ? { rows: [{ id: 7, title: '测试会话' }], rowCount: 1 } : { rows: [], rowCount: 0 }
    if (text.includes('FROM filesystem_authorization_grants') && text.includes('FOR UPDATE')) return { rows: [], rowCount: 0 }
    if (text.includes('INSERT INTO filesystem_authorization_grants')) return { rows: [{ id: 21 }], rowCount: 1 }
    if (text.includes('SELECT id,name FROM workspaces')) return values?.[1] === ownerId ? { rows: [{ id: 31, name: '测试工作区' }], rowCount: 1 } : { rows: [], rowCount: 0 }
    if (text.includes('SELECT id FROM workspaces')) return values?.[1] === ownerId ? { rows: [{ id: 31 }], rowCount: 1 } : { rows: [], rowCount: 0 }
    return { rows: [], rowCount: 0 }
  } }
  return { client: client as unknown as PoolClient, calls }
}

test('授权命令在交互事务客户端内写 owner 会话授权和安全审计', async () => {
  const { client, calls } = clientFixture()
  const effects = createPostgresAgentInteractionCommandEffects({ filesystemAuthorizationEnabled: () => true, secretKey: 'synthetic-secret' })
  const result = await effects.applyCommandAction(client, {
    ownerId, sessionId: 7, commandAction: 'filesystem_authorization_grant', optionId: 'confirm',
    actionType: 'choice', context: {}, toolName: 'ask_user',
  })
  assert.deepEqual(result, { status: 'confirmed', text: '已授权当前会话完整读写用户沙箱（workspace、personal、project）。' })
  assert.equal(calls.some(call => call.text.includes('INSERT INTO filesystem_authorization_grants') && call.values?.includes(ownerId)), true)
  const event = calls.find(call => call.text.includes("'filesystem.authorization'"))
  assert.equal(event?.values?.includes(ownerId), true)
  assert.deepEqual(JSON.parse(String(event?.values?.[2])), {
    subject_type: 'session', subject_id: '7', scope: 'user_sandbox', operation: 'authorization',
    outcome: 'granted', source: 'askuser', grant_id: '21',
  })
})

test('授权命令拒绝跨 owner，并将关闭的功能返回为业务错误', async () => {
  const foreign = clientFixture()
  const enabled = createPostgresAgentInteractionCommandEffects({ filesystemAuthorizationEnabled: () => true, secretKey: 'synthetic-secret' })
  const missing = await enabled.applyCommandAction(foreign.client, {
    ownerId: '00000000-0000-4000-8000-000000000099', sessionId: 7, commandAction: 'filesystem_authorization_grant', optionId: 'confirm',
    actionType: 'choice', context: {}, toolName: 'ask_user',
  })
  assert.deepEqual(missing, { status: 'error', text: '会话不存在' })
  const disabled = createPostgresAgentInteractionCommandEffects({ filesystemAuthorizationEnabled: () => false, secretKey: 'synthetic-secret' })
  assert.deepEqual(await disabled.applyCommandAction(foreign.client, {
    ownerId, sessionId: 7, commandAction: 'filesystem_authorization_grant', optionId: 'confirm',
    actionType: 'choice', context: {}, toolName: 'ask_user',
  }), { status: 'error', text: '完整用户沙箱授权功能当前未开启' })
})

test('删除工作区复用同一事务并保留项目与文件', async () => {
  const { client, calls } = clientFixture()
  const effects = createPostgresAgentInteractionCommandEffects({ filesystemAuthorizationEnabled: () => true, secretKey: 'synthetic-secret' })
  assert.deepEqual(await effects.applyCommandAction(client, {
    ownerId, sessionId: 7, commandAction: 'workspace_delete', optionId: 'confirm',
    actionType: 'choice', context: { workspace_id: 31 }, toolName: 'ask_user',
  }), { status: 'confirmed', text: '已删除工作区「测试工作区」（ID 31），项目和文件未受影响。' })
  assert.equal(calls.some(call => call.text.includes('DELETE FROM workspaces') && call.values?.includes(ownerId)), true)
  assert.equal(calls.some(call => call.text.includes('UPDATE conversation_sessions SET workspace_id = NULL')), true)
})
