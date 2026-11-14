import assert from 'node:assert/strict'
import test from 'node:test'
import type { Pool } from 'pg'
import { createApp } from '../../src/app.js'
import { createUserToken } from '../../src/domains/auth/auth.js'
import { createPostgresUserQuotaReader } from '../../src/domains/auth/persistence/quota.js'
import type { UserQuotaReader } from '../../src/domains/auth/quota.js'

interface QueryCall { sql: string; params: unknown[] }

function quotaPool(rows: {
  user?: Record<string, unknown>
  usage?: Record<string, unknown>
  byokUsage?: Record<string, unknown>
} = {}) {
  const calls: QueryCall[] = []
  const pool = {
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params })
      if (sql.includes('FROM users u')) return { rows: rows.user ? [rows.user] : [] }
      if (sql.includes('is_byok IS TRUE')) return { rows: [rows.byokUsage ?? {}] }
      return { rows: [rows.usage ?? {}] }
    },
  } as unknown as Pool
  return { pool, calls }
}

const baseUser = {
  id: '00000000-0000-4000-8000-000000000001',
  quota_window_started_at: '2026-11-16T00:00:00.000Z',
  token_limit_6h: null,
  token_limit_weekly: -1,
  timezone: null,
  has_active_byok: false,
}

test('platform quota applies stored overrides, current six-hour window and server-local week boundary', async () => {
  const { pool, calls } = quotaPool({
    user: baseUser,
    usage: { used_6h: '35', used_weekly: '210' },
  })
  const get = createPostgresUserQuotaReader(pool, {
    defaultLimit6h: 500,
    defaultLimitWeekly: 2000,
    byokEnabled: true,
    localDeployment: false,
    serverTimezone: 'Asia/Shanghai',
  }, () => new Date('2026-11-16T01:00:00.000Z'))

  const quota = await get(baseUser.id)

  assert.deepEqual(quota, {
    used_6h: 35,
    limit_6h: 500,
    reset_6h_at: '2026-11-16T06:00:00.000Z',
    used_weekly: 210,
    limit_weekly: null,
    usage_kind: 'platform',
    is_byok: false,
    byok_tokens_today: 0,
    byok_tokens_month: 0,
    byok_cache_rate: 0,
  })
  assert.equal(calls[1]?.params[1] instanceof Date, true)
  assert.equal((calls[1]?.params[2] as Date).toISOString(), '2026-11-15T16:00:00.000Z')
  assert.equal(calls[1]?.params[3], false)
})

test('BYOK quota uses the user local day and month and computes cache rate from full input', async () => {
  const { pool, calls } = quotaPool({
    user: { ...baseUser, timezone: 'America/Los_Angeles', has_active_byok: true },
    usage: { used_6h: '900', used_weekly: '2400' },
    byokUsage: {
      today_tokens: '120', month_tokens: '900', month_tokens_in: '400',
      month_cache_read: '300', month_cache_write: '100',
    },
  })
  const get = createPostgresUserQuotaReader(pool, {
    defaultLimit6h: 500,
    defaultLimitWeekly: 2000,
    byokEnabled: true,
    localDeployment: false,
    serverTimezone: 'Asia/Shanghai',
  }, () => new Date('2026-11-16T01:00:00.000Z'))

  const quota = await get(baseUser.id)

  assert.equal(quota.usage_kind, 'byok')
  assert.equal(quota.limit_6h, null)
  assert.equal(quota.limit_weekly, null)
  assert.equal(quota.used_6h, 900)
  assert.equal(new Date(calls[1]?.params[2] as Date).toISOString(), '2026-11-15T16:00:00.000Z')
  assert.equal(quota.byok_tokens_today, 120)
  assert.equal(quota.byok_tokens_month, 900)
  assert.equal(quota.byok_cache_rate, 0.375)
  assert.deepEqual(calls[2]?.params.slice(1), [
    new Date('2026-11-15T08:00:00.000Z'),
    new Date('2026-11-01T07:00:00.000Z'),
  ])
})

test('expired six-hour window does not show stale usage or a reset time', async () => {
  const { pool } = quotaPool({
    user: { ...baseUser, quota_window_started_at: '2026-11-15T18:00:00.000Z' },
    usage: { used_6h: '999', used_weekly: '40' },
  })
  const get = createPostgresUserQuotaReader(pool, {
    defaultLimit6h: null,
    defaultLimitWeekly: null,
    byokEnabled: false,
    localDeployment: false,
    serverTimezone: 'UTC',
  }, () => new Date('2026-11-16T01:00:00.000Z'))

  const quota = await get(baseUser.id)

  assert.equal(quota.used_6h, 0)
  assert.equal(quota.reset_6h_at, null)
  assert.equal(quota.used_weekly, 40)
})

test('BYOK usage trends group the requested window by user timezone and include cache writes', async () => {
  const ownerId = '00000000-0000-4000-8000-000000000099'
  const calls: QueryCall[] = []
  const pool = {
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params })
      if (sql.includes('SELECT timezone FROM users')) return { rows: [{ timezone: 'Asia/Tokyo' }] }
      return { rows: [
        { created_at: new Date('2026-09-01T15:30:00.000Z'), tokens_in: 100, cache_read: 40, cache_write: 3, tokens_out: 5 },
        { created_at: new Date('2026-09-03T03:00:00.000Z'), tokens_in: 10, cache_read: 0, cache_write: 0, tokens_out: 2 },
      ] }
    },
  } as unknown as Pool
  const reader = createPostgresUserQuotaReader(pool, {
    defaultLimit6h: 100,
    defaultLimitWeekly: 500,
    byokEnabled: true,
    localDeployment: false,
    serverTimezone: 'Asia/Shanghai',
  }, () => new Date('2026-09-03T12:00:00.000Z'))

  const trends = await reader.getUsageTrends!(ownerId, 3)

  assert.deepEqual(trends, {
    labels: ['09/01', '09/02', '09/03'],
    tokens_in: [0, 100, 10],
    cache_read: [0, 40, 0],
    cache_write: [0, 3, 0],
    tokens_out: [0, 5, 2],
    total: 160,
    daily_avg: 53,
    today: 12,
    cache_rate: 40 / 153,
  })
  assert.equal(calls[1]?.params[0], ownerId)
  assert.equal(calls[1]?.params[1] instanceof Date, true)
  assert.equal((calls[1]?.params[1] as Date).toISOString(), '2026-08-31T15:00:00.000Z')
  assert.match(calls[1]?.sql ?? '', /is_byok IS TRUE/)
})

test('Node Host protects quota and trend reads and derives the queried owner from the signed user identity', async () => {
  const secret = 'synthetic-test-secret-for-auth-quota'
  const calls: string[] = []
  const trendCalls: Array<{ ownerId: string; days: number }> = []
  const getQuota: UserQuotaReader = async (ownerId) => {
    calls.push(ownerId)
    return {
      used_6h: 0, limit_6h: null, reset_6h_at: null, used_weekly: 0,
      limit_weekly: null, usage_kind: 'platform', is_byok: false,
      byok_tokens_today: 0, byok_tokens_month: 0, byok_cache_rate: 0,
    }
  }
  getQuota.getUsageTrends = async (ownerId, days) => {
    trendCalls.push({ ownerId, days })
    return {
      labels: [], tokens_in: [], cache_read: [], cache_write: [], tokens_out: [],
      total: 0, daily_avg: 0, today: 0, cache_rate: 0,
    }
  }
  const app = createApp({
    appName: 'quota-test',
    async isReady() { return true },
    userAuth: {
      secret,
      async lookupUser(userId) {
        if (userId !== baseUser.id) return null
        return {
          id: baseUser.id,
          username: 'quota-user',
          displayName: '配额测试用户',
          email: 'quota-user@example.test',
          isActive: true,
          avatarUrl: null,
          createdAt: '2026-11-01T00:00:00.000Z',
          timezone: null,
          emailSubscribed: false,
          imChannels: [],
        }
      },
      getQuota,
    },
  })
  const denied = await app.inject({ method: 'GET', url: '/api/v1/auth/quota' })
  const response = await app.inject({
    method: 'GET',
    url: '/api/v1/auth/quota',
    headers: { authorization: `Bearer ${createUserToken(baseUser.id, 1, secret)}` },
  })
  const trends = await app.inject({
    method: 'GET',
    url: '/api/v1/auth/usage/trends?days=3',
    headers: { authorization: `Bearer ${createUserToken(baseUser.id, 1, secret)}` },
  })
  const invalidTrends = await app.inject({
    method: 'GET',
    url: '/api/v1/auth/usage/trends?days=3.5',
    headers: { authorization: `Bearer ${createUserToken(baseUser.id, 1, secret)}` },
  })
  await app.close()

  assert.equal(denied.statusCode, 401)
  assert.equal(response.statusCode, 200)
  assert.deepEqual(calls, [baseUser.id])
  assert.equal(response.json().usage_kind, 'platform')
  assert.equal(trends.statusCode, 200)
  assert.deepEqual(trendCalls, [{ ownerId: baseUser.id, days: 3 }])
  assert.equal(invalidTrends.statusCode, 422)
})
