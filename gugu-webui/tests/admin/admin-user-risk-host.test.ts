import assert from 'node:assert/strict'
import test from 'node:test'
import { createApp } from '../../src/app.js'
import { createAdminAuthAdapter } from '../../src/domains/admin/admin-auth.js'
import type { AdminUserRiskQuery } from '../../src/domains/admin/admin-user-risk.js'
import { createAdminHostGuard } from '../../src/http/admin-host-guard.js'

const host = { host: 'admin.example.test' }
const userId = '00000000-0000-4000-8000-000000000021'

test('Host mounts risk-user query behind Admin authentication and injects its display window', async () => {
  const queryCalls: Array<{ sql: string; values: unknown[] }> = []
  const query: AdminUserRiskQuery = async (sql, values) => {
    queryCalls.push({ sql, values })
    return [{
      id: userId, username: '合成风险用户', email: 'synthetic@example.invalid',
      display_name: '风险用户', account_status: 'active', is_active: true,
      suspended_until: null, suspended_reason: null, security_version: 3,
      recent_event_count: 5, visible_event_count: 9,
      last_event_at: '2026-11-13T12:30:00.000Z', created_at: '2026-11-01T00:00:00.000Z',
    }]
  }
  let version = 0
  const app = createApp({
    appName: 'Gugu',
    isReady: async () => true,
    adminAuth: createAdminAuthAdapter({
      username: 'admin-example',
      password: 'synthetic-admin-password',
      secret: 'synthetic-admin-risk-host-secret',
      tokenExpiresMinutes: 60,
      getAuthVersion: async () => version,
      incrementAuthVersion: async () => ++version,
      rateLimit: async () => {},
      hostGuard: createAdminHostGuard('admin.example.test'),
    }),
    adminUserRisk: {
      now: () => new Date('2026-11-13T12:34:56.000Z'),
      query,
    },
  })

  try {
    const denied = await app.inject({ url: '/api/v1/admin/users/risk', headers: host })
    assert.equal(denied.statusCode, 401)
    assert.equal(queryCalls.length, 0)

    const login = await app.inject({
      method: 'POST', url: '/api/v1/admin/auth/login', headers: host,
      payload: { username: 'admin-example', password: 'synthetic-admin-password' },
    })
    assert.equal(login.statusCode, 200)
    const token = login.json().access_token as string
    const response = await app.inject({
      url: '/api/v1/admin/users/risk?window_minutes=30',
      headers: { ...host, authorization: `Bearer ${token}` },
    })

    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json().items[0], {
      id: userId, username: '合成风险用户', email: 'synthetic@example.invalid',
      display_name: '风险用户', account_status: 'active', is_active: true,
      suspended_until: null, suspended_reason: null, security_version: 3,
      recent_event_count: 5, visible_event_count: 9,
      last_event_at: '2026-11-13T12:30:00.000+00:00', risk_action: 'throttled',
    })
    assert.deepEqual(queryCalls[0]?.values, [
      new Date('2026-11-13T12:04:56.000Z').toISOString(),
      new Date('2026-11-13T12:29:56.000Z').toISOString(),
    ])
  } finally {
    await app.close()
  }
})
