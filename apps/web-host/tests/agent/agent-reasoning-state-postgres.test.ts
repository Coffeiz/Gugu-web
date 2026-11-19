import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { commitReasoningState, loadReasoningState } from '../../src/modules/agent/run/reasoning/state.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('推理状态仅密文入库，owner 和配置绑定、版本冲突及失效清空均在事务内执行', { skip: !databaseUrl && '需要隔离 PostgreSQL' }, async () => {
  const schema = `gugu_reasoning_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` })
  const identity = { ownerId: randomUUID(), sessionId: '1', provider: 'synthetic', apiFormat: 'openai', model: 'model', configDigest: 'a'.repeat(64), reasoningConfigDigest: 'b'.repeat(64) }
  try {
    await pool.query(`CREATE TABLE conversation_sessions (id integer PRIMARY KEY,user_id uuid);
      CREATE TABLE provider_reasoning_states (user_id uuid, session_id integer UNIQUE, version integer,state_version integer,status text,
        provider text,api_format text,model_id text,reasoning_persistence text,config_digest text,reasoning_config_digest text,
        source_run_id text,source_round_id text,sequence integer,state_kind text,encrypted_payload text,payload_nonce text,
        encrypted_data_key text,key_version integer,payload_digest text,payload_size integer,state_summary jsonb,
        invalidated_reason text,invalidated_at timestamptz,created_at timestamptz,last_used_at timestamptz,expires_at timestamptz,updated_at timestamptz)`)
    await pool.query('INSERT INTO conversation_sessions VALUES (1,$1)', [identity.ownerId])
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      assert.equal((await loadReasoningState(client, identity, 'continuation', () => 'key')).version, 0)
      await commitReasoningState(client, identity, { expectedVersion: 0, runId: 'run', roundId: 'round-1', sequence: 1, stateKind: 'synthetic', value: { secret: '私有合成内容' } }, 'key', 1)
      await client.query('COMMIT')
      const stored = (await pool.query('SELECT * FROM provider_reasoning_states')).rows[0]
      assert.equal(JSON.stringify(stored).includes('私有合成内容'), false)
      await client.query('BEGIN')
      const loaded = await loadReasoningState(client, identity, 'continuation', () => 'key')
      assert.deepEqual(loaded.value, { secret: '私有合成内容' })
      await assert.rejects(commitReasoningState(client, identity, { expectedVersion: 0, runId: 'other', roundId: null, sequence: 2, stateKind: 'synthetic', value: {} }, 'key', 1), /版本已变化/)
      await client.query('ROLLBACK')
      await client.query('BEGIN')
      await assert.rejects(loadReasoningState(client, { ...identity, ownerId: randomUUID() }, 'continuation', () => 'key'), /会话不存在/)
      await client.query('ROLLBACK')
      await client.query('BEGIN')
      const invalid = await loadReasoningState(client, { ...identity, configDigest: 'c'.repeat(64) }, 'continuation', () => 'key')
      assert.equal(invalid.unavailableReason, 'config_changed')
      assert.equal(invalid.version, 2)
      await client.query('COMMIT')
      const cleared = (await pool.query('SELECT encrypted_payload,encrypted_data_key FROM provider_reasoning_states')).rows[0]
      assert.deepEqual(cleared, { encrypted_payload: '', encrypted_data_key: '' })
    } finally { client.release() }
  } finally { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
})

test('不能保证跨运行时 JSON 指纹一致的数据在写密文前明确拒绝', async () => {
  const identity = { ownerId: 'owner', sessionId: '1', provider: 'synthetic', apiFormat: 'openai', model: 'model', configDigest: 'a'.repeat(64), reasoningConfigDigest: 'b'.repeat(64) }
  let writes = 0
  const client = { query: async (sql: string) => {
    if (sql.startsWith('SELECT 1')) return { rows: [{}] }
    if (sql.startsWith('SELECT *')) return { rows: [] }
    writes++; return { rows: [], rowCount: 1 }
  } } as unknown as import('pg').PoolClient
  for (const value of [{ score: 0.1 }, { '非ASCII键': '值' }])
    await assert.rejects(commitReasoningState(client, identity, { expectedVersion: 0, runId: 'run', roundId: null, sequence: 1, stateKind: 'synthetic', value }, 'key', 1), /推理状态/)
  assert.equal(writes, 0)
})
