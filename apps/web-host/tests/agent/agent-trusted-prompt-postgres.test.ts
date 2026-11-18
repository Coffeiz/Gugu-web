import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { Kysely, PostgresDialect } from 'kysely'
import type { Database } from '@gugu/core/data'
import { createPostgresTrustedIntentStore } from '../../src/domains/agent-sessions/persistence/agent-trusted-intent-postgres.js'
import { createTrustedPromptDescriptions } from '../../src/domains/agent-sessions/persistence/agent-trusted-prompt-descriptions.js'
import { targetConfirmationIdentity } from '../../src/domains/agent-sessions/tools/confirmation-identity.js'
const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('加密意图读取拒绝交互类型混用和异轮次恢复', async () => {
  const identity = { ownerId: 'owner-a', sessionId: '1', runId: 'run-a' }
  const request = { id: 'interaction', kind: 'confirmation' as const, toolCall: { id: 'call', name: 'delete_event', input: {} } }
  const expiresAt = Date.now() + 60000
  const binding = { ...identity, roundId: 'round', toolCallId: 'call', toolName: 'delete_event', normalizedInputDigest: 'input' }
  const operation = { intent: { schemaVersion: 2 as const, binding, intentId: 'intent', interactionId: request.id, operationId: 'operation', purpose: 'action' as const,
    action: 'delete_event', targetsDigest: 'targets', versionsDigest: 'versions', authorizationEpoch: 'epoch', expiresAt },
    snapshot: { targetsDigest: 'targets', versionsDigest: 'versions', targetIds: { eventIds: [1] } } }
  const value = { kind: 'confirmation' as const, summary: '合成事件', action: 'delete_event', targets: { eventIds: [1] }, ttlMinutes: 1, operation }
  let row: Record<string, unknown> | undefined
  const client = { async query(sql: string, args: unknown[]) {
    if (sql.includes('INSERT INTO agent_interaction_intents')) {
      row = { tool_call_id: args[4], ciphertext: args[5], nonce: args[6], encrypted_data_key: args[7], key_version: args[8], expires_at: args[9] }
      return { rowCount: 1, rows: [] }
    }
    return { rowCount: row ? 1 : 0, rows: row ? [row] : [] }
  } } as never
  const store = createPostgresTrustedIntentStore(() => 'synthetic-master', 1)
  await store.saveIntent(client, identity, request, value, new Date(expiresAt + 1000))
  assert.deepEqual(await store.loadOperation(client, binding, request.id), operation)
  assert.equal(await store.loadOperation(client, { ...binding, roundId: 'other' }, request.id), null)
  await assert.rejects(store.loadIntent(client, identity, { ...request, kind: 'credential' }), /可信交互类型不匹配/)
  assert.doesNotMatch(JSON.stringify(row), /合成事件/)
})

test('确认 claim 在业务事务内一次性消费，并在回滚时恢复', { skip: !databaseUrl && '需要隔离 PostgreSQL' }, async () => {
  const schema = `gugu_claim_${randomUUID().replaceAll('-', '')}`, admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 3 })
  const database = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })
  try {
    await pool.query('CREATE TABLE agent_interaction_intents (user_id text,session_id integer,run_id text,interaction_id text,tool_call_id text,ciphertext text,nonce text,encrypted_data_key text,key_version integer,expires_at timestamptz,PRIMARY KEY(user_id,session_id,run_id,interaction_id))')
    await pool.query('CREATE TABLE agent_run_interaction_receipts (user_id text,session_id integer,run_id text,receipt text)')
    await pool.query('CREATE TABLE agent_interaction_bindings (user_id text,session_id integer,run_id text,prompt_id integer,interaction_id text,tool_call_id text)')
    await pool.query('CREATE TABLE agent_interaction_resumes (user_id text,session_id integer,run_id text,prompt_id integer,interaction_id text,receipt text)')
    await pool.query('CREATE TABLE interaction_prompts (id integer,user_id text,session_id integer,kind text,status text,expires_at timestamptz,schema_json jsonb)')
    await pool.query('CREATE TABLE interaction_actions (prompt_id integer,status text,option_id text,action_type text,context_json jsonb,expires_at timestamptz)')
    const identity = { ownerId: 'owner-a', sessionId: '1', runId: 'run-a' }
    const request = { id: 'interaction-a', kind: 'confirmation' as const, toolCall: { id: 'call-a', name: 'delete_event', input: {} } }
    const binding = { ...identity, roundId: 'round-a', toolCallId: 'call-a', toolName: 'delete_event', normalizedInputDigest: 'input-digest' }
    const expiry = Date.now() + 60_000
    const operation = { intent: { schemaVersion: 2 as const, binding, intentId: 'intent-a', interactionId: request.id, operationId: 'operation-a',
      purpose: 'action' as const, action: 'delete_event', targetsDigest: 'target-digest', versionsDigest: 'version-digest', authorizationEpoch: 'auth-epoch', expiresAt: expiry },
      snapshot: { targetsDigest: 'target-digest', versionsDigest: 'version-digest', targetIds: { eventIds: [4], reminderIds: [] } } }
    const trusted = { kind: 'confirmation' as const, summary: '删除合成事件', action: 'delete_event', targets: { eventIds: [4], reminderIds: [] }, ttlMinutes: 1, operation }
    const store = createPostgresTrustedIntentStore(() => 'synthetic-master', 1)
    const client = await pool.connect()
    try { await store.saveIntent(client, identity, request, trusted, new Date(expiry + 1000)) } finally { client.release() }
    await pool.query("INSERT INTO agent_interaction_bindings VALUES ('owner-a',1,'run-a',9,'interaction-a','call-a')")
    await pool.query("INSERT INTO agent_interaction_resumes VALUES ('owner-a',1,'run-a',9,'interaction-a','web-prompt:9')")
    await pool.query("INSERT INTO agent_run_interaction_receipts VALUES ('owner-a',1,'run-a','web-prompt:9')")
    await pool.query("INSERT INTO interaction_prompts VALUES (9,'owner-a',1,'confirm','resolved',$1,$2)", [new Date(expiry), JSON.stringify({ context: { confirm_code: 'synthetic-code' }, resolved_result: { status: 'confirmed', option_id: 'confirm', confirm: true } })])
    await pool.query("INSERT INTO interaction_actions VALUES (9,'consumed','confirm','confirm',$1,$2)", [JSON.stringify({ tool_call_id: 'call-a', tool_name: 'delete_event', confirm_code: 'synthetic-code' }), new Date(expiry)])
    const reference = { ...operation.intent, receiptId: 'web-prompt:9' }
    assert.equal(await database.transaction().execute(tx => store.claimApprovedOperation(tx, reference, new AbortController().signal, async () => false)), false)
    assert.equal(Number((await pool.query('SELECT count(*) AS n FROM agent_interaction_intents')).rows[0]!.n), 1)
    await assert.rejects(database.transaction().execute(async tx => {
      assert.equal(await store.claimApprovedOperation(tx, reference, new AbortController().signal, async () => true), true)
      throw new Error('synthetic rollback')
    }), /synthetic rollback/)
    assert.equal(Number((await pool.query('SELECT count(*) AS n FROM agent_interaction_intents')).rows[0]!.n), 1)
    assert.equal(await database.transaction().execute(tx => store.claimApprovedOperation(tx, reference, new AbortController().signal, async () => true)), true)
    assert.equal(await database.transaction().execute(tx => store.claimApprovedOperation(tx, reference, new AbortController().signal, async () => true)), false)
    assert.equal(Number((await pool.query('SELECT count(*) AS n FROM agent_interaction_intents')).rows[0]!.n), 0)
  } finally {
    try {
      await database.destroy()
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    } finally {
      await admin.end()
    }
  }
})

test('空提醒集合仍生成目标确认，且目标与版本摘要参与确认身份', async () => {
  const identity = { ownerId: 'owner-a', sessionId: '1', runId: 'run-a' }
  const request = { id: 'interaction', kind: 'confirmation' as const, toolCall: { id: 'call', name: 'delete_event', input: {} } }
  let captured = ''
  const intent = { kind: 'confirmation' as const, summary: '删除合成事件', action: 'delete_event', targets: { eventIds: [1], reminderIds: [] }, ttlMinutes: 5,
    operation: { intent: { schemaVersion: 2 as const, binding: { ...identity, roundId: 'round', toolCallId: 'call', toolName: 'delete_event', normalizedInputDigest: 'input' },
      intentId: 'intent', interactionId: 'interaction', operationId: 'operation', purpose: 'action' as const, action: 'delete_event', targetsDigest: 'targets', versionsDigest: 'versions', authorizationEpoch: 'epoch', expiresAt: Date.now() + 60000 },
      snapshot: { targetsDigest: 'targets', versionsDigest: 'versions', targetIds: { eventIds: [1], reminderIds: [] } } } }
  const descriptions = createTrustedPromptDescriptions({ async loadIntent() { return intent }, async createConfirmation(_owner, _summary, target) { captured = target; return 'synthetic-code' } })
  const result = await descriptions.confirmation({} as never, identity, request)
  assert.equal(result.kind, 'confirm')
  assert.equal(captured, targetConfirmationIdentity('delete_event', { eventIds: [1] }, { targets_digest: 'targets', versions_digest: 'versions' }))
})

test('可信确认使用目标身份签发，MCP 凭据目标受 owner 限制', { skip: !databaseUrl && '需要隔离 PostgreSQL' }, async () => {
  const schema = `gugu_prompt_${randomUUID().replaceAll('-', '')}`, admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 2 })
  const server = '00000000-0000-4000-8000-000000000001', identity = { ownerId: 'owner-a', sessionId: '1', runId: 'run-a' }
  try {
    await pool.query('CREATE TABLE agent_interaction_intents (user_id text, session_id integer, run_id text, interaction_id text, tool_call_id text, ciphertext text, nonce text, encrypted_data_key text, key_version integer, expires_at timestamptz, PRIMARY KEY(user_id,session_id,run_id,interaction_id))')
    await pool.query('CREATE TABLE agent_interaction_bindings (user_id text, session_id integer, run_id text, prompt_id integer, interaction_id text, tool_call_id text)')
    await pool.query('CREATE TABLE agent_interaction_resumes (user_id text, session_id integer, run_id text, prompt_id integer, interaction_id text, receipt text)')
    await pool.query('CREATE TABLE interaction_prompts (id integer, user_id text, session_id integer, kind text, status text, expires_at timestamptz, schema_json jsonb)')
    await pool.query('CREATE TABLE interaction_actions (prompt_id integer, status text, option_id text, action_type text, context_json jsonb, expires_at timestamptz)')
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
      await assert.rejects(intentStore.loadIntent(client, identity, { ...request, kind: 'credential' }), /可信交互类型不匹配/)
      const request2 = { ...request, id: 'operation-interaction' }
      const expiry = Date.now() + 60000
      const operation = { intent: { schemaVersion: 2 as const, binding: { ...identity, roundId: 'round', toolCallId: 'call', toolName: 'delete', normalizedInputDigest: 'digest' },
        intentId: 'intent', interactionId: request2.id, operationId: 'operation', purpose: 'action' as const, action: 'delete', targetsDigest: 'targets', versionsDigest: 'versions', authorizationEpoch: 'epoch', expiresAt: expiry },
        snapshot: { targetsDigest: 'targets', versionsDigest: 'versions', targetIds: { project: [123] } } }
      const bound = { ...intent, operation }
      await intentStore.saveIntent(client, identity, request2, bound, new Date(expiry + 1000))
      assert.deepEqual(await intentStore.loadIntent(client, identity, request2), bound)
      assert.deepEqual(await intentStore.loadOperation(client, operation.intent.binding, request2.id), operation)
      assert.equal(await intentStore.loadOperation(client, { ...operation.intent.binding, roundId: 'other' }, request2.id), null)
      assert.equal(await intentStore.loadOperation(client, { ...operation.intent.binding, normalizedInputDigest: 'other' }, request2.id), null)
      assert.equal(await intentStore.loadOperation(client, { ...operation.intent.binding, ownerId: 'owner-b' }, request2.id), null)
      await client.query("INSERT INTO agent_interaction_bindings VALUES ('owner-a',1,'run-a',7,$1,'call')", [request2.id])
      await client.query("INSERT INTO agent_interaction_resumes VALUES ('owner-a',1,'run-a',7,$1,'web-prompt:7')", [request2.id])
      await client.query("INSERT INTO interaction_prompts VALUES (7,'owner-a',1,'confirm','resolved',$1,$2)", [new Date(expiry), JSON.stringify({ context: { confirm_code: 'synthetic-code' }, resolved_result: { status: 'confirmed', option_id: 'confirm', confirm: true } })])
      await client.query("INSERT INTO interaction_actions VALUES (7,'consumed','confirm','confirm',$1,$2)", [JSON.stringify({ tool_call_id: 'call', tool_name: 'delete', confirm_code: 'synthetic-code' }), new Date(expiry - 1000)])
      const approved = await intentStore.loadApprovedOperation(client, operation.intent.binding, request2.id, 'web-prompt:7')
      assert.equal(approved?.receipt.status, 'approved')
      assert.equal(approved?.receipt.expiresAt, expiry - 1000)
      assert.equal(await intentStore.loadApprovedOperation(client, operation.intent.binding, request2.id, 'forged'), null)
      await client.query("UPDATE interaction_actions SET expires_at=clock_timestamp()-interval '1 second' WHERE prompt_id=7")
      assert.equal(await intentStore.loadApprovedOperation(client, operation.intent.binding, request2.id, 'web-prompt:7'), null)
      await client.query('UPDATE interaction_actions SET expires_at=$1 WHERE prompt_id=7', [new Date(expiry - 1000)])
      await client.query("UPDATE interaction_actions SET context_json=$1 WHERE prompt_id=7", [JSON.stringify({ tool_call_id: 'call', tool_name: 'delete' })])
      assert.equal(await intentStore.loadApprovedOperation(client, operation.intent.binding, request2.id, 'web-prompt:7'), null)
      await client.query("UPDATE interaction_actions SET status='pending', context_json=$1 WHERE prompt_id=7", [JSON.stringify({ tool_call_id: 'call', tool_name: 'delete', confirm_code: 'synthetic-code' })])
      assert.equal(await intentStore.loadApprovedOperation(client, operation.intent.binding, request2.id, 'web-prompt:7'), null)
      await assert.rejects(intentStore.saveIntent(client, identity, { ...request2, id: 'forged' }, bound, new Date(expiry + 1000)))
      await assert.rejects(intentStore.saveIntent(client, identity, request2, { ...bound, targets: { project: [999] } }, new Date(expiry + 1000)))
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

test('MCP UUID 目标经过加密意图和 Web 确认标识保持不变，目标冲突时拒绝写入', async () => {
  const identity = { ownerId: 'owner-a', sessionId: '1', runId: 'run-a' }
  const server = '00000000-0000-4000-8000-000000000011'
  const name = 'manage_mcp_servers'
  const request = { id: 'interaction-mcp', kind: 'confirmation' as const, toolCall: { id: 'call', name, input: {} } }
  const expiresAt = Date.now() + 60_000
  const binding = { ...identity, roundId: 'round', toolCallId: 'call', toolName: name, normalizedInputDigest: 'input' }
  const snapshot = { targetsDigest: 'target', versionsDigest: 'version', targetRefs: { mcp_server: [server] } }
  const intent = { schemaVersion: 2 as const, binding, intentId: 'intent', interactionId: request.id, operationId: 'operation',
    purpose: 'action' as const, action: 'remove_mcp_server', targetsDigest: snapshot.targetsDigest,
    versionsDigest: snapshot.versionsDigest, authorizationEpoch: 'epoch', expiresAt }
  const value = { kind: 'confirmation' as const, summary: '删除合成 MCP', action: intent.action,
    targets: { mcp_server: [server] }, ttlMinutes: 1, operation: { intent, snapshot } }
  let row: Record<string, unknown> | undefined, targetIdentity = ''
  const client = { async query(sql: string, args: unknown[]) {
    if (sql.includes('INSERT INTO agent_interaction_intents')) {
      row = { tool_call_id: args[4], ciphertext: args[5], nonce: args[6], encrypted_data_key: args[7], key_version: args[8], expires_at: args[9] }
      return { rowCount: 1, rows: [] }
    }
    return { rowCount: row ? 1 : 0, rows: row ? [row] : [] }
  } } as never
  const store = createPostgresTrustedIntentStore(() => 'synthetic-master', 1)
  await assert.rejects(store.saveIntent(client, identity, request, {
    ...value, operation: { intent, snapshot: { ...snapshot, targetIds: { mcp_server: [1] } } },
  }, new Date(expiresAt)), /可信确认意图无效/)
  await assert.rejects(store.saveIntent(client, identity, request, {
    ...value, targets: { mcp_server: [server + '-other'] },
  }, new Date(expiresAt)), /可信确认意图绑定无效/)
  await store.saveIntent(client, identity, request, value, new Date(expiresAt))
  assert.deepEqual(await store.loadOperation(client, binding, request.id), value.operation)
  const descriptions = createTrustedPromptDescriptions({
    loadIntent: store.loadIntent,
    async createConfirmation(_owner, _title, reference) { targetIdentity = reference; return 'synthetic-code' },
  })
  await descriptions.confirmation(client, identity, request)
  assert.equal(targetIdentity, targetConfirmationIdentity(intent.action, value.targets, { targets_digest: 'target', versions_digest: 'version' }))
  assert.doesNotMatch(JSON.stringify(row), new RegExp(server))
})
