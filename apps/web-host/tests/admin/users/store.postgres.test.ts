import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import { Pool } from 'pg'
import { Kysely, PostgresDialect } from 'kysely'
import test from 'node:test'
import { createAdminUserListReader } from '../../../src/modules/admin/user-management.js'
import { registerAdminUsersRoute } from '../../../src/modules/admin/users.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
test('管理员用户列表按真实 PostgreSQL 聚合用量且不依赖旧文件表', {
  skip: !databaseUrl && '需要隔离 PostgreSQL',
}, async () => {
  const schema = `admin_users_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 3 })
  const db = new Kysely<any>({ dialect: new PostgresDialect({ pool }) })
  const app = Fastify()
  try {
    await pool.query(`CREATE TABLE users(id uuid PRIMARY KEY, username text, email text, display_name text,
      is_active boolean, account_status text, suspended_until timestamptz, is_developer boolean,
      created_at timestamptz, token_limit_6h bigint, token_limit_weekly bigint, search_limit_daily integer);
      CREATE TABLE agent_usage(user_id uuid, tokens_in bigint, tokens_out bigint, created_at timestamptz, is_byok boolean);
`)
    const owner = randomUUID()
    await pool.query(`INSERT INTO users(id,username,email,is_active,account_status,is_developer,created_at)
      VALUES($1,'synthetic','synthetic@example.test',true,'active',false,'2026-11-01Z')`, [owner])
    await pool.query(`INSERT INTO agent_usage VALUES ($1,3,4,'2026-11-13T12:00Z',false),($1,100,100,'2026-11-13T12:00Z',true)`, [owner])
    registerAdminUsersRoute(app, { requireAdmin: async () => {},
      read: createAdminUserListReader(db, () => new Date('2026-11-13T13:00:00Z')) })
    const response = await app.inject({ url: '/api/v1/admin/users?q=synthetic' })
    assert.equal(response.statusCode, 200)
    const body = response.json() as { total: number; items: Array<{ id: string; tokens_week: number; tokens_6h: number }> }
    assert.equal(body.total, 1)
    assert.deepEqual([body.items[0]!.id, body.items[0]!.tokens_week, body.items[0]!.tokens_6h], [owner, 7, 7])
  } finally {
    await app.close(); await db.destroy(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end()
  }
})
