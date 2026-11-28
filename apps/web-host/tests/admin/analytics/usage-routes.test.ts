import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { createApp } from '../../../src/app.js'
import { createAdminAuthAdapter } from '../../../src/modules/admin/auth.js'
import { createAdminHostGuard } from '../../../src/http/admin-host-guard.js'

const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('生产 Host 管理员鉴权后查询隔离 PG 用量，失败响应不泄露异常', { skip: !url && '需要隔离 PostgreSQL' }, async () => {
  const schema = `admin_agent_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: url })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` })
  const host = { host: 'admin.example.test' }
  let queries = 0, fail = false, version = 0
  const app = createApp({
    appName: 'Gugu', isReady: async () => true,
    adminAuth: createAdminAuthAdapter({
      username: 'admin-example', password: 'synthetic-admin-password', secret: 'synthetic-admin-secret',
      tokenExpiresMinutes: 60, getAuthVersion: async () => version, incrementAuthVersion: async () => ++version,
      rateLimit: async () => {}, hostGuard: createAdminHostGuard('admin.example.test'),
    }),
    adminAgentUsage: {
      now: () => new Date('2026-09-04T06:00:00Z'),
      async query(sql, params) { queries++; if (fail) throw new Error('synthetic-private-database-detail'); return pool.query(sql, params) },
    },
  })
  try {
    await pool.query('CREATE TABLE users (id uuid PRIMARY KEY, is_developer boolean NOT NULL)')
    await pool.query(`CREATE TABLE agent_usage (user_id uuid NOT NULL, provider text NOT NULL, model text NOT NULL,
      scenario text, tokens_in bigint NOT NULL, tokens_out bigint NOT NULL, cache_read bigint NOT NULL,
      cache_write bigint NOT NULL, is_byok boolean NOT NULL, created_at timestamptz NOT NULL, cache_round_stats json)`)
    await pool.query('CREATE TABLE user_mcp_servers (user_id uuid NOT NULL, scope text NOT NULL, enabled boolean NOT NULL)')
    const owner = '00000000-0000-4000-8000-000000000001'
    await pool.query('INSERT INTO users VALUES ($1, false)', [owner])
    await pool.query("INSERT INTO agent_usage (user_id,provider,model,scenario,tokens_in,tokens_out,cache_read,cache_write,is_byok,created_at) VALUES ($1,'openai','synthetic-model','chat',100,20,10,5,false,'2026-09-04T04:00:00Z')", [owner])
    const denied = await app.inject({ url: '/api/v1/admin/agent/usage', headers: host })
    assert.equal(denied.statusCode, 401)
    assert.equal(queries, 0)
    const login = await app.inject({ method: 'POST', url: '/api/v1/admin/auth/login', headers: host,
      payload: { username: 'admin-example', password: 'synthetic-admin-password' } })
    assert.equal(login.statusCode, 200)
    const headers = { ...host, authorization: `Bearer ${login.json().access_token}` }
    const response = await app.inject({ url: '/api/v1/admin/agent/usage?timezone=UTC', headers })
    assert.equal(response.statusCode, 200)
    assert.equal(response.json().total.calls, 1)
    assert.equal(response.json().total.tokens_in, 115)
    fail = true
    const failure = await app.inject({ url: '/api/v1/admin/agent/usage', headers })
    assert.equal(failure.statusCode, 500)
    assert.equal(failure.body.includes('synthetic-private-database-detail'), false)
  } finally {
    await app.close()
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    await admin.end()
  }
})
