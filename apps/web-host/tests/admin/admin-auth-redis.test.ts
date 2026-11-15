import assert from 'node:assert/strict'
import Fastify from 'fastify'
import test from 'node:test'
import { createRedisAdminAuthVersionStore } from '../../src/adapters/redis-events.js'
import { createAdminAuthAdapter } from '../../src/domains/admin/admin-auth.js'

const redisUrl = process.env.GUGU_WEBUI_TEST_REDIS_URL
const secret = 'synthetic-admin-shared-secret'

function createHost(url: string) {
  const app = Fastify({ logger: false })
  const store = createRedisAdminAuthVersionStore(url)
  const auth = createAdminAuthAdapter({
    username: 'synthetic-admin', password: 'synthetic-password', secret, tokenExpiresMinutes: 60,
    ...store, rateLimit: async () => {}, hostGuard: async () => {},
  })
  auth.registerRoutes(app)
  return { app, store }
}

test('隔离 Redis 使不同 Host 共享管理员版本和撤销状态', {
  skip: !redisUrl && '需要显式隔离 Redis',
}, async () => {
  const first = createHost(redisUrl!)
  const second = createHost(redisUrl!)
  try {
    assert.equal(await first.store.getAuthVersion(), 0)
    const login = await first.app.inject({ method: 'POST', url: '/api/v1/admin/auth/login',
      payload: { username: 'synthetic-admin', password: 'synthetic-password' } })
    assert.equal(login.statusCode, 200)
    const headers = { authorization: `Bearer ${login.json().access_token}` }
    assert.equal((await second.app.inject({ url: '/api/v1/admin/auth/me', headers })).statusCode, 200)
    assert.equal((await second.app.inject({ method: 'POST', url: '/api/v1/admin/auth/logout', headers })).statusCode, 200)
    assert.equal(await first.store.getAuthVersion(), 1)
    assert.equal((await first.app.inject({ url: '/api/v1/admin/auth/me', headers })).statusCode, 401)
  } finally { await first.app.close(); await second.app.close() }
})

test('Redis 不可用时管理员认证返回 503', async () => {
  const host = createHost('redis://127.0.0.1:1')
  try {
    const login = await host.app.inject({ method: 'POST', url: '/api/v1/admin/auth/login',
      payload: { username: 'synthetic-admin', password: 'synthetic-password' } })
    assert.equal(login.statusCode, 503)
  } finally { await host.app.close() }
})
