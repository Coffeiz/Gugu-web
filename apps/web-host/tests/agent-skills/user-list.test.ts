import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { createApp } from '../../src/app.js'
import { createUserToken } from '../../src/domains/auth/auth.js'

const ownerId = '00000000-0000-4000-8000-000000000101'
const secret = 'synthetic-skill-list-secret'
const apps: Array<{ close(): Promise<void> }> = []

afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())) })

test('Skills first-load returns owner skill rows without triggering tool discovery', async () => {
  const calls: unknown[] = []
  const app = createApp({
    appName: 'Synthetic skill list app', isReady: async () => true,
    userAuth: {
      secret,
      async lookupUser(id) {
        return id === ownerId ? {
          id, username: 'sample', displayName: null, email: 'sample@example.invalid', avatarUrl: null,
          createdAt: null, timezone: null, emailSubscribed: false, imChannels: [], isActive: true, securityVersion: 1,
        } : null
      },
    },
    userSkillList: {
      async list(owner) { calls.push(['list', owner]); return [{ id: 'U1', name: '笔记整理', body: 'private skill body' }] },
    },
  })
  apps.push(app)

  const unauthorized = await app.inject({ url: '/api/v1/skills?include_tools=false' })
  const response = await app.inject({
    url: '/api/v1/skills?include_tools=false',
    headers: { authorization: `Bearer ${createUserToken(ownerId, 1, secret)}` },
  })

  assert.equal(unauthorized.statusCode, 401)
  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json(), { skills: [{ id: 'U1', name: '笔记整理', body: 'private skill body' }], tools: [] })
  assert.deepEqual(calls, [['list', ownerId]])
})
