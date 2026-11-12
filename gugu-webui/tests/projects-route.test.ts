import assert from 'node:assert/strict'
import test from 'node:test'
import { createApp } from '../src/app.js'
import { signedUserToken } from './helpers/auth.js'

const secret = 'synthetic-project-route-secret'
const userId = '9e51a4bf-07e1-4db8-9050-54a8c7356e8d'

function makeApp(projects: (ownerId: string, archived: boolean) => Promise<unknown[]>) {
  return createApp({
    appName: 'Gugu',
    isReady: async () => true,
    userAuth: {
      secret,
      lookupUser: async (id) => ({
        id,
        username: 'synthetic-user',
        displayName: null,
        email: 'synthetic@example.test',
        isActive: true,
        accountStatus: 'active',
        securityVersion: 1,
        avatarUrl: null,
        createdAt: null,
        timezone: null,
        emailSubscribed: false,
        imChannels: [],
      }),
    },
    listProjects: projects,
  })
}

test('GET /api/v1/projects binds the authenticated owner and archived filter', async () => {
  const calls: Array<[string, boolean]> = []
  const app = makeApp(async (ownerId, archived) => {
    calls.push([ownerId, archived])
    return [{ id: 10, archived }]
  })
  try {
    const active = await app.inject({
      method: 'GET', url: '/api/v1/projects', headers: { authorization: `Bearer ${signedUserToken(secret, userId)}` },
    })
    const archived = await app.inject({
      method: 'GET', url: '/api/v1/projects?archived=true', headers: { authorization: `Bearer ${signedUserToken(secret, userId)}` },
    })
    assert.equal(active.statusCode, 200)
    assert.deepEqual(active.json(), [{ id: 10, archived: false }])
    assert.equal(archived.statusCode, 200)
    assert.deepEqual(calls, [[userId, false], [userId, true]])
  } finally {
    await app.close()
  }
})

test('GET /api/v1/projects rejects unauthenticated access and unsupported deleted views', async () => {
  const app = makeApp(async () => [])
  try {
    const missing = await app.inject({ method: 'GET', url: '/api/v1/projects' })
    const deleted = await app.inject({
      method: 'GET', url: '/api/v1/projects?deleted=true', headers: { authorization: `Bearer ${signedUserToken(secret, userId)}` },
    })
    const conflicting = await app.inject({
      method: 'GET', url: '/api/v1/projects?archived=true&deleted=true',
      headers: { authorization: `Bearer ${signedUserToken(secret, userId)}` },
    })
    assert.equal(missing.statusCode, 401)
    assert.equal(deleted.statusCode, 501)
    assert.equal(conflicting.statusCode, 400)
  } finally {
    await app.close()
  }
})

test('GET /api/v1/projects rejects malformed boolean query values', async () => {
  const app = makeApp(async () => [])
  try {
    const response = await app.inject({
      method: 'GET', url: '/api/v1/projects?archived=sometimes',
      headers: { authorization: `Bearer ${signedUserToken(secret, userId)}` },
    })
    assert.equal(response.statusCode, 422)
  } finally {
    await app.close()
  }
})
