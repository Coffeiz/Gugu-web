import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { Kysely, SqliteDialect } from 'kysely'
import { test } from 'node:test'
import { createAdminSecurityEventReader, createAdminUserSecurityEventReader } from '../../src/modules/admin/audit.js'

const owner = '00000000-0000-4000-8000-000000000001'
const other = '00000000-0000-4000-8000-000000000002'

async function fixture() {
  const native = new Database(':memory:')
  const db = new Kysely<any>({ dialect: new SqliteDialect({ database: native }) })
  await db.schema.createTable('users').addColumn('id', 'text', column => column.primaryKey()).execute()
  await db.schema.createTable('security_events')
    .addColumn('id', 'integer', column => column.primaryKey())
    .addColumn('user_id', 'text', column => column.notNull())
    .addColumn('event_type', 'text', column => column.notNull())
    .addColumn('resource_type', 'text', column => column.notNull())
    .addColumn('resource_fingerprint', 'text', column => column.notNull())
    .addColumn('owner_fingerprint', 'text')
    .addColumn('client_fingerprint', 'text')
    .addColumn('ip_fingerprint', 'text')
    .addColumn('user_agent_fingerprint', 'text')
    .addColumn('action', 'text', column => column.notNull())
    .addColumn('reason_code', 'text', column => column.notNull())
    .addColumn('metadata_json', 'text', column => column.notNull())
    .addColumn('occurred_at', 'text', column => column.notNull())
    .addColumn('expires_at', 'text', column => column.notNull())
    .execute()
  await db.insertInto('users').values([{ id: owner }, { id: other }]).execute()
  for (const row of [
    { id: 1, user_id: owner, occurred_at: '2026-11-18T11:30:00.000+00:00' },
    { id: 2, user_id: other, occurred_at: '2026-11-18T11:20:00.000+00:00' },
    { id: 3, user_id: owner, occurred_at: '2026-11-18T09:00:00.000+00:00' },
  ]) {
    await db.insertInto('security_events').values({
      ...row, event_type: 'ownership.denied', resource_type: 'Project',
      resource_fingerprint: `resource-${row.id}`, owner_fingerprint: null,
      client_fingerprint: 'client-fingerprint', ip_fingerprint: 'ip-fingerprint',
      user_agent_fingerprint: 'ua-fingerprint', action: 'logged', reason_code: 'ownership_mismatch',
      metadata_json: JSON.stringify({ private: 'must-not-leak' }), expires_at: '2027-01-01T00:00:00.000+00:00',
    }).execute()
  }
  return { db, close: () => db.destroy() }
}

test('Core 全局安全事件按窗口、筛选和上限读取，只投影脱敏字段并用 HMAC 替代用户 ID', async () => {
  const ctx = await fixture()
  try {
    const read = createAdminSecurityEventReader(ctx.db, userId => userId === owner ? 'fingerprint:owner-a' : 'fingerprint:owner-b', () => new Date('2026-11-18T12:00:00.000Z'))
    const result = await read({ since_minutes: 60, limit: 10, user_id: owner })
    assert.deepEqual(result, {
      items: [{
        id: 1, user_id: 'fingerprint:owner-a', event_type: 'ownership.denied', resource_type: 'Project',
        resource_fingerprint: 'resource-1', owner_fingerprint: null, client_fingerprint: 'client-fingerprint',
        ip_fingerprint: 'ip-fingerprint', user_agent_fingerprint: 'ua-fingerprint', action: 'logged',
        reason_code: 'ownership_mismatch', occurred_at: '2026-11-18T11:30:00+00:00',
      }],
      total: 1, since_minutes: 60,
    })
    assert.equal(JSON.stringify(result).includes(owner), false)
    assert.equal(JSON.stringify(result).includes('must-not-leak'), false)
  } finally { await ctx.close() }
})

test('Core 用户安全事件先验证用户存在，再按时间倒序限制条数并省略非契约字段', async () => {
  const ctx = await fixture()
  try {
    const read = createAdminUserSecurityEventReader(ctx.db)
    const missing = await read('00000000-0000-4000-8000-000000000099', 100)
    assert.equal(missing, null)
    const result = await read(owner, 1)
    assert.deepEqual(result, { items: [{
      id: 1, event_type: 'ownership.denied', resource_type: 'Project', resource_fingerprint: 'resource-1',
      owner_fingerprint: null, client_fingerprint: 'client-fingerprint', ip_fingerprint: 'ip-fingerprint',
      action: 'logged', reason_code: 'ownership_mismatch', occurred_at: '2026-11-18T11:30:00+00:00',
    }] })
    assert.equal(JSON.stringify(result).includes('ua-fingerprint'), false)
    assert.equal(JSON.stringify(result).includes('must-not-leak'), false)
  } finally { await ctx.close() }
})
