import assert from 'node:assert/strict'
import test from 'node:test'
import { createApp } from '../../src/app.js'
import { createAdminAuthAdapter } from '../../src/domains/admin/admin-auth.js'
import { createAdminHostGuard } from '../../src/http/admin-host-guard.js'

const host = { host: 'admin.example.test' }
const userId = '00000000-0000-4000-8000-000000000021'

test('Host mounts risk-user query behind Admin authentication and injects its display window', async () => {
  const readCalls: number[] = []
  const read = async (windowMinutes = 1440) => {
    readCalls.push(windowMinutes)
    return { total: 1, window_minutes: windowMinutes, policy_window_minutes: 5, items: [{
      id: userId, username: '合成风险用户', email: 'synthetic@example.invalid',
      display_name: '风险用户', account_status: 'active', is_active: true,
      suspended_until: null, suspended_reason: null, security_version: 3,
      recent_event_count: 5, visible_event_count: 9, last_event_at: '2026-11-13T12:30:00.000+00:00', risk_action: 'throttled',
    }] }
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
      read,
    },
  })

  try {
    const denied = await app.inject({ url: '/api/v1/admin/users/risk', headers: host })
    assert.equal(denied.statusCode, 401)
    assert.equal(readCalls.length, 0)

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
    assert.deepEqual(readCalls, [30])
  } finally {
    await app.close()
  }
})
