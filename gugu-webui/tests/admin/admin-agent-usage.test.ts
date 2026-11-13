import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import test from 'node:test'
import Fastify from 'fastify'
import { registerAdminAgentUsageRoute } from '../../src/domains/admin/admin-agent-usage.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('Agent用量按时区、BYOK/开发者过滤和旧token边界聚合真实PG数据', {
  skip: !databaseUrl && '需要 GUGU_WEBUI_TEST_DATABASE_URL 验收真实 SQL 行为',
}, async () => {
  const schema = `admin_usage_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 2 })
  const app = Fastify()
  registerAdminAgentUsageRoute(app, {
    requireAdmin: async (request, reply) => {
      if (request.headers.authorization !== 'admin') return reply.code(401).send({ error: 'unauthorized' })
    },
    query: (sql, params) => pool.query(sql, params),
    now: () => new Date('2026-09-04T06:00:00.000Z'),
  })
  try {
    await pool.query('CREATE TABLE users (id uuid PRIMARY KEY, is_developer boolean NOT NULL)')
    await pool.query(`CREATE TABLE agent_usage (
      id bigserial PRIMARY KEY, user_id uuid NOT NULL, provider text NOT NULL, model text NOT NULL,
      scenario text, tokens_in bigint NOT NULL DEFAULT 0, tokens_out bigint NOT NULL DEFAULT 0,
      cache_read bigint NOT NULL DEFAULT 0, cache_write bigint NOT NULL DEFAULT 0,
      is_byok boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL
    )`)
    await pool.query('CREATE TABLE user_mcp_servers (id bigserial PRIMARY KEY, user_id uuid NOT NULL, scope text NOT NULL, enabled boolean NOT NULL)')
    const owner = '00000000-0000-4000-8000-000000000001', developer = '00000000-0000-4000-8000-000000000002', byok = '00000000-0000-4000-8000-000000000003'
    await pool.query('INSERT INTO users VALUES ($1,false),($2,true),($3,false)', [owner, developer, byok])
    await pool.query(`INSERT INTO agent_usage (user_id,provider,model,scenario,tokens_in,tokens_out,cache_read,cache_write,is_byok,created_at) VALUES
      ($1,'deepseek','old-model','chat',800,100,700,20,false,'2026-09-02T12:00:00Z'),
      ($1,'deepseek','new-model','chat',800,100,700,20,false,'2026-09-04T04:00:00Z'),
      ($2,'deepseek','developer-model','chat',100,10,0,0,false,'2026-09-04T04:00:00Z'),
      ($3,'deepseek','byok-model','chat',100,10,0,0,true,'2026-09-04T04:00:00Z')`, [owner, developer, byok])
    const response = await app.inject({ url: '/api/v1/admin/agent/usage?date=2026-09-04&month=2026-09&timezone=Asia/Shanghai&exclude_dev=true&include_byok=false', headers: { authorization: 'admin' } })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.total.calls, 2)
    assert.equal(body.total.tokens_in, 2320)
    assert.equal(body.today.calls, 1)
    assert.equal(body.today.tokens_in, 1520)
    assert.equal(body.anchor_date, '2026-09-04')
    assert.deepEqual(body.months, ['2026-09'])
    assert.equal(body.daily.find((row: { date: string }) => row.date === '2026-09-02').tokens_in, 800)
    assert.equal(body.daily.find((row: { date: string }) => row.date === '2026-09-04').tokens_in, 1520)
    assert.equal(body.by_model.some((row: { model: string }) => row.model === 'developer-model' || row.model === 'byok-model'), false)
    assert.equal(JSON.stringify(body).includes('api_key'), false)
  } finally {
    await app.close()
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    await admin.end()
  }
})

test('Agent用量端点要求管理员身份', async () => {
  const app = Fastify()
  registerAdminAgentUsageRoute(app, {
    requireAdmin: async (request, reply) => {
      if (request.headers.authorization !== 'admin') return reply.code(401).send({ error: 'unauthorized' })
    },
    query: async () => { throw new Error('无权访问不得查询数据库') },
  })
  try { assert.equal((await app.inject({ url: '/api/v1/admin/agent/usage' })).statusCode, 401) }
  finally { await app.close() }
})

test('聚合应用层保留总计/日历响应结构并将时区及BYOK/开发者筛选下推到SQL', async () => {
  const app = Fastify(), statements: Array<{ sql: string; params?: unknown[] }> = []
  registerAdminAgentUsageRoute(app, {
    requireAdmin: async () => {},
    now: () => new Date('2026-09-04T06:00:00.000Z'),
    query: async (sql, params) => {
      statements.push({ sql, params })
      if (sql.includes('FROM user_mcp_servers')) return { rows: [{ servers: '2', users: '1' }] }
      if (sql.includes("WHERE scenario='mcp'")) return { rows: [{ calls: '3' }] }
      if (sql.includes('EXTRACT(HOUR')) return { rows: [{ hour: 12, calls: '1', tokens_in: '1520', tokens_out: '100', cache_read: '700', cache_write: '20' }] }
      if (sql.includes("COALESCE(scenario,'chat')")) return { rows: [{ scenario: 'chat', calls: '1', tokens_in: '1520', tokens_out: '100', cache_read: '700', cache_write: '20', cold_calls: '0', warm_tokens_in: '1520' }] }
      if (sql.includes("TO_CHAR(created_at AT TIME ZONE $1")) return { rows: [{ month: '2026-09' }] }
      if (sql.includes("TO_CHAR(created_at AT TIME ZONE $3")) {
        const from = params?.[0] instanceof Date ? params[0].toISOString().slice(0, 10) : String(params?.[0] ?? '')
        if (from === '2026-08-31' || from === '2026-09-01') return { rows: [
          { day: '2026-09-02', calls: '1', tokens_in: '800', tokens_out: '100', cache_read: '700', cache_write: '20' },
          { day: '2026-09-04', calls: '1', tokens_in: '1520', tokens_out: '100', cache_read: '700', cache_write: '20' },
        ] }
        return { rows: [] }
      }
      if (sql.includes('GROUP BY model,provider')) return { rows: [{ model: 'new-model', provider: 'deepseek', calls: '2', tokens_in: '2320', tokens_out: '200', cache_read: '1400', cache_write: '40' }] }
      if (sql.includes('created_at >= $1')) return { rows: [{ calls: '1', tokens_in: '1520', tokens_out: '100', cache_read: '700', cache_write: '20' }] }
      return { rows: [{ calls: '2', tokens_in: '2320', tokens_out: '200', cache_read: '1400', cache_write: '40' }] }
    },
  })
  try {
    const response = await app.inject({ url: '/api/v1/admin/agent/usage?date=2026-09-04&month=2026-09&timezone=Asia/Shanghai&exclude_dev=true&include_byok=false' })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.deepEqual(body.total, { calls: 2, tokens_in: 2320, tokens_out: 200, cache_read: 1400, cache_write: 40, cache_ratio: 0.603448 })
    assert.equal(body.today.tokens_in, 1520)
    assert.equal(body.anchor_date, '2026-09-04')
    assert.equal(body.timezone, 'Asia/Shanghai')
    assert.equal(body.daily.find((row: { date: string }) => row.date === '2026-09-02').tokens_in, 800)
    assert.equal(body.daily.find((row: { date: string }) => row.date === '2026-09-04').tokens_in, 1520)
    const filtered = statements.filter((entry) => entry.sql.includes('FROM agent_usage'))
    assert.ok(filtered.length > 0)
    assert.ok(filtered.every(({ sql }) => sql.includes('NOT is_byok') && sql.includes('user_id NOT IN (SELECT id FROM users WHERE is_developer)')))
    assert.ok(statements.some(({ params }) => params?.includes('Asia/Shanghai')))
    assert.ok(filtered.filter(({ sql }) => sql.includes('tokens_in')).every(({ sql }) => sql.includes("'2026-09-03 11:15:00+00'::timestamptz")))
  } finally { await app.close() }
})

test('无效时区回退当前Node服务本地时区而不是强制UTC', async () => {
  const app = Fastify()
  registerAdminAgentUsageRoute(app, { requireAdmin: async () => {}, now: () => new Date('2026-09-04T06:00:00Z'), query: async () => ({ rows: [] }) })
  try {
    const response = await app.inject({ url: '/api/v1/admin/agent/usage?timezone=not/a-real-zone&date=2026-09-04' })
    assert.equal(response.statusCode, 200)
    assert.equal(response.json().timezone, Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')
  } finally { await app.close() }
})
