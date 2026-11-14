import assert from 'node:assert/strict'
import test from 'node:test'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { createApp } from '../../src/app.js'
import { createAdminAuthAdapter } from '../../src/domains/admin/admin-auth.js'
import { createAdminHostGuard } from '../../src/http/admin-host-guard.js'
import { signedUserToken } from '../helpers/auth.js'

const userId = 'cfa94a82-62d0-44a3-88bc-8c0cf37e5085'
const userSecret = 'synthetic-feedback-user-secret'
const userAuth = { authorization: `Bearer ${signedUserToken(userSecret, userId)}` }
const adminHost = { host: 'admin.example.test' }

function makeApp(submit: (...args: [string, string, string, string]) => Promise<void>) {
  let version = 0
  return createApp({
    appName: 'Gugu',
    isReady: async () => true,
    userAuth: {
      secret: userSecret,
      lookupUser: async (id) => ({
        id, username: 'moon_example', displayName: 'Moon Example', email: 'moon@example.test',
        isActive: true, avatarUrl: null, createdAt: '2026-01-02T03:04:05.000Z', timezone: null,
        emailSubscribed: false, imChannels: [],
      }),
    },
    feedback: { submit },
    adminAuth: createAdminAuthAdapter({
      username: 'admin-example',
      password: 'synthetic-admin-password',
      secret: 'synthetic-feedback-admin-secret',
      tokenExpiresMinutes: 60,
      getAuthVersion: async () => version,
      incrementAuthVersion: async () => ++version,
      rateLimit: async () => {},
      hostGuard: createAdminHostGuard('admin.example.test'),
    }),
    adminFeedback: {
      list: async (page, pageSize, category) => ({
        total: 1,
        items: [{ id: 12, username: 'Moon Example', category, content: 'works', createdAt: '2026-11-13T00:00:00.000Z', page, pageSize }],
      }),
    },
  })
}

test('feedback submission requires a user session and stores trimmed content with the display-name snapshot', async () => {
  const writes: unknown[][] = []
  const app = makeApp(async (...args) => { writes.push(args) })
  try {
    const unauthorized = await app.inject({ method: 'POST', url: '/api/v1/feedback', payload: { category: 'bug', content: 'issue' } })
    const response = await app.inject({
      method: 'POST', url: '/api/v1/feedback', headers: userAuth,
      payload: { category: 'bug', content: '  issue reproduced  ' },
    })
    assert.equal(unauthorized.statusCode, 401)
    assert.equal(response.statusCode, 201)
    assert.deepEqual(response.json(), { ok: true })
    assert.deepEqual(writes, [[userId, 'Moon Example', 'bug', 'issue reproduced']])
  } finally {
    await app.close()
  }
})

test('feedback submission rejects invalid categories, non-string bodies, and blank content without writing', async () => {
  let writes = 0
  const app = makeApp(async () => { writes += 1 })
  try {
    for (const [payload, status] of [
      [{ category: 'feature', content: 'x' }, 400],
      [{ category: 'other', content: '  ' }, 400],
      [{ category: 'bug', content: 9 }, 422],
    ] as const) {
      const response = await app.inject({ method: 'POST', url: '/api/v1/feedback', headers: userAuth, payload })
      assert.equal(response.statusCode, status)
    }
    assert.equal(writes, 0)
  } finally {
    await app.close()
  }
})

test('admin feedback list preserves pagination and category filtering behind the Admin guard', async () => {
  const app = makeApp(async () => {})
  try {
    const unauthorized = await app.inject({ url: '/api/v1/admin/feedback', headers: adminHost })
    assert.equal(unauthorized.statusCode, 401)
    const login = await app.inject({
      method: 'POST', url: '/api/v1/admin/auth/login', headers: adminHost,
      payload: { username: 'admin-example', password: 'synthetic-admin-password' },
    })
    assert.equal(login.statusCode, 200)
    const response = await app.inject({
      url: '/api/v1/admin/feedback?page=2&page_size=7&category=bug',
      headers: { ...adminHost, authorization: `Bearer ${login.json().access_token}` },
    })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), {
      total: 1,
      items: [{ id: 12, username: 'Moon Example', category: 'bug', content: 'works', createdAt: '2026-11-13T00:00:00.000Z', page: 2, pageSize: 7 }],
    })
  } finally {
    await app.close()
  }
})

test('admin feedback rejects malformed pagination before querying persistence', async () => {
  let reads = 0
  const app = createApp({
    appName: 'Gugu', isReady: async () => true,
    adminAuth: createAdminAuthAdapter({
      username: 'admin-example', password: 'synthetic-admin-password', secret: 'synthetic-feedback-admin-secret',
      tokenExpiresMinutes: 60, getAuthVersion: async () => 0, incrementAuthVersion: async () => 1,
      rateLimit: async () => {}, hostGuard: async (_request: FastifyRequest, _reply: FastifyReply) => {},
    }),
    adminFeedback: { list: async () => { reads += 1; return { total: 0, items: [] } } },
  })
  try {
    const login = await app.inject({
      method: 'POST', url: '/api/v1/admin/auth/login', payload: { username: 'admin-example', password: 'synthetic-admin-password' },
    })
    assert.equal(login.statusCode, 200)
    const response = await app.inject({
      url: `/api/v1/admin/feedback?page=${encodeURIComponent('1.5')}`,
      headers: { authorization: `Bearer ${login.json().access_token}` },
    })
    assert.equal(response.statusCode, 422)
    assert.equal(reads, 0)
  } finally {
    await app.close()
  }
})
