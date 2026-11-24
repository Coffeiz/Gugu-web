import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { Kysely, SqliteDialect } from 'kysely'
import { test } from 'node:test'
import { createAdminUserListReader, createAdminUserRiskReader } from '../../../src/modules/admin/user-management.js'

async function fixture() {
  const native = new Database(':memory:')
  const db = new Kysely<any>({ dialect: new SqliteDialect({ database: native }) })
  await db.schema.createTable('users').addColumn('id', 'text', column => column.primaryKey())
    .addColumn('username', 'text').addColumn('email', 'text').addColumn('display_name', 'text')
    .addColumn('is_active', 'integer').addColumn('account_status', 'text').addColumn('suspended_until', 'text')
    .addColumn('suspended_reason', 'text').addColumn('security_version', 'integer')
    .addColumn('is_developer', 'integer').addColumn('created_at', 'text').addColumn('updated_at', 'text')
    .addColumn('token_limit_6h', 'integer').addColumn('token_limit_weekly', 'integer')
    .addColumn('search_limit_daily', 'integer').execute()
  await db.schema.createTable('agent_usage').addColumn('user_id', 'text').addColumn('tokens_in', 'integer')
    .addColumn('tokens_out', 'integer').addColumn('created_at', 'text').addColumn('is_byok', 'integer').execute()
  await db.schema.createTable('security_events').addColumn('id', 'integer', column => column.primaryKey())
    .addColumn('user_id', 'text').addColumn('occurred_at', 'text').execute()
  return { db, close: () => db.destroy() }
}

const ids = {
  alpha: '00000000-0000-4000-8000-000000000001',
  beta: '00000000-0000-4000-8000-000000000002',
  gamma: '00000000-0000-4000-8000-000000000003',
}

test('Core 管理员用户列表按 Python 窗口汇总非 BYOK 用量且不依赖旧文件表', async () => {
  const ctx = await fixture()
  try {
    await ctx.db.insertInto('users').values([
      { id: ids.alpha, username: 'Alpha', email: 'alpha@example.test', display_name: '甲', is_active: 1, account_status: null, is_developer: null, created_at: '2026-02-01T10:00:00Z', updated_at: '2026-02-01T10:00:00Z', token_limit_6h: 100, token_limit_weekly: 700, search_limit_daily: 20 },
      { id: ids.beta, username: 'Beta', email: 'beta@example.test', display_name: null, is_active: 0, account_status: 'suspended', suspended_until: '2026-11-13T15:00:00Z', is_developer: 1, created_at: '2026-01-01T10:00:00Z', updated_at: '2026-01-01T10:00:00Z', token_limit_6h: null, token_limit_weekly: null, search_limit_daily: null },
    ]).execute()
    await ctx.db.insertInto('agent_usage').values([
      { user_id: ids.alpha, tokens_in: 3, tokens_out: 4, created_at: '2026-11-13T13:00:00Z', is_byok: 0 },
      { user_id: ids.alpha, tokens_in: 100, tokens_out: 100, created_at: '2026-11-13T13:00:00Z', is_byok: 1 },
      { user_id: ids.beta, tokens_in: 10, tokens_out: 20, created_at: '2026-11-08T00:00:00Z', is_byok: 0 },
    ]).execute()

    const read = createAdminUserListReader(ctx.db, () => new Date('2026-11-13T14:23:45Z'))
    const result = await read('ALPHA')
    assert.deepEqual(result, { items: [{
      id: ids.alpha, username: 'Alpha', email: 'alpha@example.test', display_name: '甲', is_active: true,
      account_status: 'active', suspended_until: null, is_developer: false, created_at: '2026-02-01T10:00:00+00:00',
      tokens_week: 7, tokens_6h: 7, token_limit_6h: 100, token_limit_weekly: 700,
      search_limit_daily: 20,
    }], total: 1 })
    const unfiltered = await read()
    assert.deepEqual(unfiltered.items.map(item => item.id), [ids.alpha, ids.beta])
  } finally { await ctx.close() }
})

test('Core 风险列表使用五分钟动作阈值、展示窗口，并按 Python 的 updated_at 排序', async () => {
  const ctx = await fixture()
  try {
    await ctx.db.insertInto('users').values([
      { id: ids.alpha, username: 'Alpha', email: 'alpha@example.test', display_name: null, is_active: 1, account_status: 'active', security_version: 2, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-11-13T12:00:00Z' },
      { id: ids.beta, username: 'Beta', email: 'beta@example.test', display_name: null, is_active: 0, account_status: 'suspended', suspended_until: '2026-11-13T13:00:00Z', suspended_reason: 'manual', security_version: 4, created_at: '2026-02-01T00:00:00Z', updated_at: '2026-11-13T12:03:00Z' },
      { id: ids.gamma, username: 'Gamma', email: 'gamma@example.test', display_name: null, is_active: 1, account_status: 'active', security_version: 1, created_at: '2026-03-01T00:00:00Z', updated_at: '2026-11-13T12:02:00Z' },
    ]).execute()
    const events = [
      ...Array.from({ length: 10 }, (_, index) => ({ id: index + 1, user_id: ids.alpha, occurred_at: `2026-11-13T12:3${index % 6}:00Z` })),
      { id: 11, user_id: ids.alpha, occurred_at: '2026-11-13T12:00:00Z' },
      { id: 12, user_id: ids.alpha, occurred_at: '2026-11-13T11:50:00Z' },
      ...Array.from({ length: 5 }, (_, index) => ({ id: index + 20, user_id: ids.gamma, occurred_at: `2026-11-13T12:3${index}:00Z` })),
    ]
    await ctx.db.insertInto('security_events').values(events).execute()
    const read = createAdminUserRiskReader(ctx.db, () => new Date('2026-11-13T12:34:56Z'))
    const result = await read(60)
    assert.deepEqual(result.items.map(item => [item.id, item.recent_event_count, item.visible_event_count, item.risk_action]), [
      [ids.beta, 0, 0, 'logged'], [ids.gamma, 5, 5, 'throttled'], [ids.alpha, 10, 12, 'suspended'],
    ])
    assert.deepEqual(result.items.map(item => item.id), [ids.beta, ids.gamma, ids.alpha])
    assert.equal(result.items[2]?.last_event_at, '2026-11-13T12:35:00+00:00')
    assert.equal(result.total, 3)
    assert.equal(result.window_minutes, 60)
    assert.equal(result.policy_window_minutes, 5)
  } finally { await ctx.close() }
})
