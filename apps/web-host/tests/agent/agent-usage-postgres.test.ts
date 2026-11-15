import assert from 'node:assert/strict'
import test from 'node:test'
import type { PoolClient } from 'pg'
import { recordAgentUsage, type AgentUsageConfig } from '../../src/domains/agent-sessions/persistence/agent-usage-postgres.js'

const identity = { ownerId: 'synthetic', sessionId: '7', runId: 'run' }
const usage = { input: 8, output: 4, cacheRead: 0, cacheWrite: 0, contextInput: null }
const config: AgentUsageConfig = { defaultLimit6h: 10, byokEnabled: false, localDeployment: false, model: 'model', provider: 'provider', isByok: false }
function fixture(options: { used?: number; limit?: number | null; credential?: boolean; missing?: boolean } = {}) {
  const inserted: unknown[][] = []
  const client = { query: async (sql: string, args: unknown[]) => {
    if (sql.includes('FROM users u')) return { rows: options.missing ? [] : [{ token_limit_6h: options.limit ?? null, quota_window_started_at: null }] }
    if (sql.includes('FROM user_provider_credentials')) return { rows: options.credential ? [{}] : [] }
    if (sql.includes('UPDATE users')) return { rows: [{ started: new Date(0) }] }
    if (sql.includes('FROM agent_usage')) return { rows: [{ total: String(options.used ?? 0) }] }
    if (sql.includes('INSERT INTO agent_usage')) { inserted.push(args); return { rows: [], rowCount: 1 } }
    throw new Error('意外查询')
  } } as unknown as PoolClient
  return { client, inserted }
}

test('6 小时剩余额度优先记输入，满额冻结并保留缓存统计', async () => {
  const a = fixture({ used: 5 })
  assert.deepEqual(await recordAgentUsage(a.client, identity, usage, config, [], []), { input: 5, output: 0 })
  assert.deepEqual(a.inserted[0]!.slice(2, 6), [5, 0, 0, 0])
  const b = fixture({ used: 10 })
  assert.deepEqual(await recordAgentUsage(b.client, identity, usage, config, [], []), { input: 0, output: 0 })
  assert.equal(b.inserted.length, 0)
  await recordAgentUsage(b.client, identity, { ...usage, cacheRead: 3 }, config, [], [])
  assert.deepEqual(b.inserted[0]!.slice(2, 6), [0, 0, 3, 0])
})

test('只有启用 BYOK 且存在启用的 LLM 凭据时免封顶，账本使用可信模型标记', async () => {
  const a = fixture({ used: 10, credential: true })
  assert.deepEqual(await recordAgentUsage(a.client, identity, usage, { ...config, byokEnabled: true, isByok: true }, [], []), { input: 8, output: 4 })
  assert.equal(a.inserted[0]![9], true)
  const b = fixture({ used: 10, credential: false })
  assert.deepEqual(await recordAgentUsage(b.client, identity, usage, { ...config, byokEnabled: true }, [], []), { input: 0, output: 0 })
  await assert.rejects(recordAgentUsage(fixture({ missing: true }).client, identity, usage, config, [], []), /会话不存在/)
})

test('用户不限额覆盖默认限制，完整轮次匹配才写缓存统计', async () => {
  const a = fixture({ used: 100, limit: -1 })
  const rounds = [{ input: 8, cache_read: 2, cache_write: 1 }]
  assert.deepEqual(await recordAgentUsage(a.client, identity, { ...usage, cacheRead: 2, cacheWrite: 1 }, config, rounds, ['工具']), { input: 8, output: 4 })
  assert.deepEqual(JSON.parse(String(a.inserted[0]![6])), { cold_calls: 0, warm_input: 11, warm_read: 2 })
  assert.deepEqual(JSON.parse(String(a.inserted[0]![10])), ['工具'])
})

test('隔离 PostgreSQL 中账本与额度窗口随调用方事务回滚，并按 owner 隔离', {
  skip: !process.env.GUGU_WEBUI_TEST_DATABASE_URL && '需要隔离 PostgreSQL',
}, async () => {
  const { Pool } = await import('pg')
  const { randomUUID } = await import('node:crypto')
  const schema = `gugu_usage_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: process.env.GUGU_WEBUI_TEST_DATABASE_URL })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: process.env.GUGU_WEBUI_TEST_DATABASE_URL, options: `-c search_path=${schema}` })
  const ownerId = randomUUID(), foreign = randomUUID()
  try {
    await pool.query(`CREATE TABLE users (id uuid PRIMARY KEY, token_limit_6h integer, quota_window_started_at timestamptz);
      CREATE TABLE conversation_sessions (id integer PRIMARY KEY, user_id uuid NOT NULL);
      CREATE TABLE user_provider_credentials (user_id uuid, capability text, enabled boolean);
      CREATE TABLE agent_usage (user_id uuid, session_id integer, tokens_in integer, tokens_out integer, cache_read integer,
        cache_write integer, cache_round_stats jsonb, model text, provider text, is_byok boolean, tools_used jsonb,
        scenario text, input_source text, created_at timestamptz)`)
    await pool.query('INSERT INTO users (id) VALUES ($1),($2)', [ownerId, foreign])
    await pool.query('INSERT INTO conversation_sessions VALUES (7,$1)', [ownerId])
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await recordAgentUsage(client, { ...identity, ownerId }, usage, config, [], [])
      await client.query('ROLLBACK')
      assert.equal(Number((await pool.query('SELECT count(*) AS n FROM agent_usage')).rows[0].n), 0)
      assert.equal((await pool.query('SELECT quota_window_started_at FROM users WHERE id=$1', [ownerId])).rows[0].quota_window_started_at, null)
      await client.query('BEGIN')
      assert.deepEqual(await recordAgentUsage(client, { ...identity, ownerId }, usage, config, [], []), { input: 8, output: 2 })
      await client.query('COMMIT')
      await client.query('BEGIN')
      assert.deepEqual(await recordAgentUsage(client, { ...identity, ownerId }, usage, config, [], []), { input: 0, output: 0 })
      await client.query('COMMIT')
      await assert.rejects(recordAgentUsage(client, { ...identity, ownerId: foreign }, usage, config, [], []), /会话不存在/)
    } finally { client.release() }
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    await admin.end()
  }
})
