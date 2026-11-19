import assert from 'node:assert/strict'
import test from 'node:test'
import type { PoolClient } from 'pg'
import type { CanonicalRunContext } from '@gugu/core/agent'
import type { ProviderRuntime } from '@gugu/core/providers'
import { commitStagedResponsesReasoning, type ResponsesReasoningBinding } from '../../src/modules/agent/run/reasoning/bridge.js'

const identity = { ownerId: 'owner', sessionId: '1', runId: 'run' }
const binding: ResponsesReasoningBinding = { identity: { ownerId: 'owner', sessionId: '1', provider: 'openai', apiFormat: 'responses', model: 'model', configDigest: 'a'.repeat(64), reasoningConfigDigest: 'b'.repeat(64) }, runId: 'run', modelIdentity: 'selection', accessScopeHash: 'scope', expectedVersion: 0 }
const context = { identity, modelIdentity: 'selection', accessScopeHash: 'scope', continuationRef: 'provider:ref' } as CanonicalRunContext

test('Responses 私有值只经事务回调写入密文，拒绝跨运行身份及不支持的协议', async () => {
  const inserted: unknown[][] = []
  const client = { query: async (sql: string, args: unknown[]) => {
    if (sql.startsWith('SELECT 1')) return { rows: [{}] }
    if (sql.startsWith('SELECT *')) return { rows: [] }
    if (sql.startsWith('INSERT')) { inserted.push(args); return { rowCount: 1 } }
    throw new Error('意外查询')
  } } as unknown as PoolClient
  const provider = { withStagedContinuation: async (_context: unknown, cb: (x: unknown) => Promise<unknown>) => cb({
    round: 2, areaDigest: 'digest', value: { state_kind: 'openai_responses_reasoning', reasoning_items: [{ type: 'reasoning', id: 'synthetic-private' }] },
  }) } as unknown as Pick<ProviderRuntime, 'withStagedContinuation'>
  assert.equal(await commitStagedResponsesReasoning(client, provider, context, binding, 'key', 1), 1)
  assert.equal(JSON.stringify(inserted).includes('synthetic-private'), false)
  await assert.rejects(commitStagedResponsesReasoning(client, provider, { ...context, identity: { ...identity, ownerId: 'other' } }, binding, 'key', 1), /身份不匹配/)
  await assert.rejects(commitStagedResponsesReasoning(client, provider, context, { ...binding, identity: { ...binding.identity, apiFormat: 'anthropic' } }, 'key', 1), /身份不匹配/)
  assert.equal(inserted.length, 1)
})

test('隔离 PostgreSQL 上 Responses 桥接与历史事务回滚、版本冲突和重启恢复', {
  skip: !process.env.GUGU_WEBUI_TEST_DATABASE_URL && '需要隔离 PostgreSQL',
}, async () => {
  const { randomUUID, createHash } = await import('node:crypto')
  const { Pool } = await import('pg')
  const { ProviderRuntime } = await import('@gugu/core/providers')
  const { stableJson } = await import('@gugu/core/agent')
  const { stageLoadedResponsesReasoning } = await import('../../src/modules/agent/run/reasoning/bridge.js')
  const { invalidateReasoningState } = await import('../../src/modules/agent/run/reasoning/state.js')
  const schema = `gugu_bridge_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: process.env.GUGU_WEBUI_TEST_DATABASE_URL })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: process.env.GUGU_WEBUI_TEST_DATABASE_URL, options: `-c search_path=${schema}` })
  const ownerId = randomUUID(), run = { ownerId, sessionId: '1', runId: 'run' }
  const trusted = { ...binding, identity: { ...binding.identity, ownerId }, runId: 'run', expectedVersion: 0 }
  const runtime = () => new ProviderRuntime({ digest: v => createHash('sha256').update(stableJson(v)).digest('hex'), nextId: randomUUID,
    references: { dehydrate: async entry => entry.message, hydrate: async entry => entry.message },
    prepareRequest: async () => ({ prefix: [], dynamicTail: [] }), resolve: async () => { throw new Error('不发模型请求') },
    transport: { request: async () => { throw new Error('不发模型请求') } } })
  const first = runtime(), second = runtime()
  try {
    await pool.query(`CREATE TABLE conversation_sessions (id integer PRIMARY KEY,user_id uuid);
      CREATE TABLE provider_reasoning_states (user_id uuid,session_id integer UNIQUE,version integer,state_version integer,status text,
        provider text,api_format text,model_id text,reasoning_persistence text,config_digest text,reasoning_config_digest text,
        source_run_id text,source_round_id text,sequence integer,state_kind text,encrypted_payload text,payload_nonce text,
        encrypted_data_key text,key_version integer,payload_digest text,payload_size integer,state_summary jsonb,
        invalidated_reason text,invalidated_at timestamptz,created_at timestamptz,last_used_at timestamptz,expires_at timestamptz,updated_at timestamptz)`)
    await pool.query('INSERT INTO conversation_sessions VALUES (1,$1)', [ownerId])
    const ref = await first.stageContinuation({ identity: run, modelIdentity: 'selection', accessScopeHash: 'scope', areaDigest: 'digest', round: 1,
      value: { state_kind: 'openai_responses_reasoning', reasoning_items: [{ type: 'reasoning', id: 'synthetic-private' }] } })
    const active = { ...context, identity: run, continuationRef: ref }
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await commitStagedResponsesReasoning(client, first, active, trusted, 'key', 1)
      await client.query('ROLLBACK')
      assert.equal(Number((await pool.query('SELECT count(*) AS n FROM provider_reasoning_states')).rows[0].n), 0)
      await client.query('BEGIN')
      await commitStagedResponsesReasoning(client, first, active, trusted, 'key', 1)
      await client.query('COMMIT')
      const stored = (await pool.query('SELECT * FROM provider_reasoning_states')).rows[0]
      assert.equal(JSON.stringify(stored).includes('synthetic-private'), false)
      await client.query('BEGIN')
      await assert.rejects(commitStagedResponsesReasoning(client, first, active, trusted, 'key', 1), /版本已变化/)
      await client.query('ROLLBACK')
      first.finishRun(run)
      await client.query('BEGIN')
      const reloaded = await stageLoadedResponsesReasoning(client, second, run, { ...trusted, expectedVersion: 1 }, 'digest', () => 'key')
      await client.query('COMMIT')
      assert.ok(reloaded.continuationRef)
      assert.equal(JSON.stringify(reloaded).includes('synthetic-private'), false)
      const restored = await second.withStagedContinuation({ ...active, continuationRef: reloaded.continuationRef }, async value => value)
      assert.deepEqual(restored.value, { state_kind: 'openai_responses_reasoning', reasoning_items: [{ type: 'reasoning', id: 'synthetic-private' }] })
      second.finishRun(run)
      await client.query('BEGIN')
      await assert.rejects(invalidateReasoningState(client, trusted.identity, 0, 'manual'), /版本已变化/)
      assert.equal(await invalidateReasoningState(client, trusted.identity, 1, 'manual'), true)
      await client.query('COMMIT')
      const removed = (await pool.query('SELECT encrypted_payload,encrypted_data_key FROM provider_reasoning_states')).rows[0]
      assert.deepEqual(removed, { encrypted_payload: '', encrypted_data_key: '' })
      await assert.rejects(second.withStagedContinuation({ ...active, continuationRef: reloaded.continuationRef }, async () => null), /模型拒绝/)
    } finally { client.release() }
  } finally { await first.close(); await second.close(); await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
})
