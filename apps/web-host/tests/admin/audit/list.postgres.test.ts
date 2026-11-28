import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import Fastify from 'fastify'
import { createAdminAuditLogReader } from '../../../src/modules/admin/audit.js'
import { registerAdminAuditLogRoute } from '../../../src/modules/admin/audit.js'
import { installHttpErrorHandler } from '../../../src/http/errors.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('审计列表通过Host和Core读取隔离PG，排序、零上限、微秒与失败脱敏符合基线', {
  skip: !databaseUrl && '需要隔离测试PostgreSQL',
}, async () => {
  const schema = `audit_list_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  const pool = new Pool({ connectionString: databaseUrl, max: 1, options: `-c search_path=${schema}` })
  const app = Fastify()
  installHttpErrorHandler(app)
  registerAdminAuditLogRoute(app, { requireAdmin: async () => {}, read: createAdminAuditLogReader((sql, values) => pool.query(sql, values)) })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  try {
    // 与 Python AuditLog 相同的列类型；本测试不声称已验收生产迁移历史。
    await pool.query('CREATE TABLE audit_logs (id serial PRIMARY KEY, username varchar(100) NOT NULL, action varchar(50) NOT NULL, description text NOT NULL, ip varchar(60), created_at timestamptz NOT NULL)')
    await pool.query(`INSERT INTO audit_logs (username,action,description,ip,created_at) VALUES
      ('小月','logout','退出','192.0.2.1','2026-11-13T00:00:00Z'),
      ('小北','login','登录',NULL,'2026-11-14T01:02:03.123456Z')`)
    const response = await app.inject('/api/v1/admin/audit-log?limit=1')
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { items: [{ id: 2, username: '小北', action: 'login', description: '登录', ip: null, created_at: '2026-11-14T01:02:03.123456+00:00' }] })
    assert.deepEqual((await app.inject('/api/v1/admin/audit-log?limit=0')).json(), { items: [] })
    assert.equal((await app.inject('/api/v1/admin/audit-log')).json().items.length, 2)
    const negative = await app.inject('/api/v1/admin/audit-log?limit=-1')
    assert.equal(negative.statusCode, 500)
    assert.equal(negative.body.includes('LIMIT'), false)
  } finally {
    await app.close()
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    await admin.end()
  }
})
