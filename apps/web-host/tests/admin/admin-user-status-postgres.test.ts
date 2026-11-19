import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { createPostgresAdminUserStatusStore } from '../../src/modules/admin/user-status.js'
import { withPostgresTransaction } from '../../src/adapters/database/postgres-transaction.js'

const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('共享用户状态适配在真实 PostgreSQL 中提交冻结和解冻，失败时回滚', {
  skip: !url && '需要显式隔离 PostgreSQL',
}, async () => {
  const schema = `admin_status_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: url, max: 1 })
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 2 })
  const owner = randomUUID(), other = randomUUID()
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`)
    await pool.query(`CREATE TABLE users (
      id uuid PRIMARY KEY, username text NOT NULL, account_status text NOT NULL,
      is_active boolean NOT NULL, suspended_until timestamptz, suspended_reason text,
      security_version integer NOT NULL DEFAULT 0,
      CONSTRAINT synthetic_reason CHECK (suspended_reason IS DISTINCT FROM 'synthetic-reject')
    )`)
    await pool.query("INSERT INTO users(id, username, account_status, is_active) VALUES ($1, '合成用户甲', 'active', true), ($2, '合成用户乙', 'active', true)", [owner, other])
    const store = createPostgresAdminUserStatusStore(work => withPostgresTransaction(pool, client => work((sql, values) => client.query(sql, values))))
    const at = new Date('2026-11-19T00:00:00.000Z')
    const frozen = await store.suspend(owner, 600, '合成原因', at)
    assert.equal(frozen?.account_status, 'suspended')
    assert.equal(frozen?.is_active, false)
    assert.equal(new Date(frozen!.suspended_until!).toISOString(), '2026-11-19T00:10:00.000Z')
    await assert.rejects(store.suspend(owner, 600, 'synthetic-reject', at))
    const afterFailure = await pool.query('SELECT account_status, suspended_reason, security_version FROM users WHERE id = $1', [owner])
    assert.deepEqual(afterFailure.rows[0], { account_status: 'suspended', suspended_reason: '合成原因', security_version: 1 })
    const restored = await store.unsuspend(owner, at)
    assert.equal(restored?.account_status, 'active')
    assert.equal(restored?.suspended_until, null)
    assert.equal(await store.unsuspend(randomUUID(), at), null)
    const final = await pool.query('SELECT id, account_status, security_version FROM users ORDER BY username')
    const byId = new Map(final.rows.map(row => [row.id, [row.account_status, row.security_version]]))
    assert.deepEqual(byId.get(owner), ['active', 2])
    assert.deepEqual(byId.get(other), ['active', 0])
  } finally {
    await pool.end()
    try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`) } finally { await admin.end() }
  }
})
