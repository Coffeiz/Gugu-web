import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { createPostgresTrustedIntentStore } from '../../src/domains/agent-sessions/persistence/agent-trusted-intent-postgres.js'
import { createTrustedPromptDescriptions } from '../../src/domains/agent-sessions/persistence/agent-trusted-prompt-descriptions.js'
import { targetConfirmationIdentity } from '../../src/domains/agent-sessions/tools/confirmation-identity.js'
const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('可信确认使用目标身份签发，MCP 凭据目标受 owner 限制', { skip: !databaseUrl && '需要隔离 PostgreSQL' }, async () => {
  const schema = `gugu_prompt_${randomUUID().replaceAll('-', '')}`, admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 2 })
  const server = '00000000-0000-4000-8000-000000000001', identity = { ownerId: 'owner-a', sessionId: '1', runId: 'run-a' }
  try {
    await pool.query('CREATE TABLE agent_interaction_intents (user_id text, session_id integer, run_id text, interaction_id text, tool_call_id text, ciphertext text, nonce text, encrypted_data_key text, key_version integer, expires_at timestamptz, PRIMARY KEY(user_id,session_id,run_id,interaction_id))')
    await pool.query('CREATE TABLE user_mcp_servers (id uuid, user_id text, scope text, name text, credential_slots jsonb)')
    await pool.query('INSERT INTO user_mcp_servers VALUES ($1,$2,$3,$4,$5)', [server, 'owner-a', 'user', '合成服务', JSON.stringify([{ id: 'key', label: '密钥', target: 'header' }])])
    const request = { id: 'trusted-interaction', kind: 'confirmation' as const, toolCall: { id: 'call', name: 'delete', input: { owner: 'owner-b', serverId: 'model-forged' } } }
    let createdIdentity = ''
    const trusted = createTrustedPromptDescriptions({
      async loadIntent(_client, id, pending) { if (id.ownerId !== 'owner-a' || pending.id !== 'trusted-interaction') return null; return pending.kind === 'confirmation' ? { kind: 'confirmation', summary: '删除合成项目', action: 'delete', targets: { project: [123] }, ttlMinutes: 5 } : { kind: 'credential', serverId: server, action: '配置' } },
      async createConfirmation(owner, summary, target) { assert.equal(owner, 'owner-a'); assert.equal(summary, '删除合成项目'); createdIdentity = target; return 'synthetic-code' },
    })
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const intentStore = createPostgresTrustedIntentStore(() => 'synthetic-master', 1)
      const intent = { kind: 'confirmation' as const, summary: '敏感合成操作', action: 'delete', targets: { project: [123] }, ttlMinutes: 5 }
      await intentStore.saveIntent(client, identity, request, intent, new Date(Date.now() + 60000))
      await intentStore.saveIntent(client, identity, request, intent, new Date(Date.now() + 60000))
      assert.deepEqual(await intentStore.loadIntent(client, identity, request), intent)
      assert.equal(await intentStore.loadIntent(client, { ...identity, ownerId: 'owner-b' }, request), null)
      const raw = await client.query('SELECT ciphertext FROM agent_interaction_intents')
      assert.doesNotMatch(JSON.stringify(raw.rows), /敏感合成操作/)
      const confirm = await trusted.confirmation(client, identity, request)
      assert.equal(createdIdentity, targetConfirmationIdentity('delete', { project: [123] }))
      assert.deepEqual(confirm.options.map(option => option.id), ['confirm', 'cancel'])
      const secret = await trusted.credential(client, identity, { ...request, kind: 'credential' })
      assert.deepEqual(secret.secretFields, [{ name: 'key', label: '密钥', type: 'secret' }]); assert.equal((secret.context.secret_target as { server_id: string }).server_id, server)
      await assert.rejects(trusted.credential(client, { ...identity, ownerId: 'owner-b' }, { ...request, kind: 'credential' }))
      await client.query('ROLLBACK')
    } finally { client.release() }
  } finally { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
})
