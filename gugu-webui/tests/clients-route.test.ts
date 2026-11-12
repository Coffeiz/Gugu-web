import assert from 'node:assert/strict'
import test from 'node:test'
import { CoreError } from '@gugu/core'
import { createApp } from '../src/app.js'
import { signedUserToken } from './helpers/auth.js'

const secret = 'synthetic-clients-route-secret'
const userId = '9e51a4bf-07e1-4db8-9050-54a8c7356e8d'

function makeApp() {
  const calls: unknown[][] = []
  const app = createApp({
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
    clients: {
      async list(ownerId) {
        calls.push(['list', ownerId])
        return [{ id: 12, name: 'Example', contact: null, email: null, phone: null, notes: '' }]
      },
      async create(ownerId, input) {
        calls.push(['create', ownerId, input])
        return { id: 13, name: input.name, contact: input.contact ?? null, email: null, phone: null, notes: input.notes ?? '' }
      },
      async delete(ownerId, id) {
        calls.push(['delete', ownerId, id])
        if (id !== 13) throw new CoreError('not_found', '联系人不存在')
      },
    },
  })
  return { app, calls }
}

const auth = { authorization: `Bearer ${signedUserToken(secret, userId)}` }

test('clients list and create use the authenticated owner and existing response fields', async () => {
  const { app, calls } = makeApp()
  try {
    const list = await app.inject({ method: 'GET', url: '/api/v1/clients', headers: auth })
    const create = await app.inject({
      method: 'POST', url: '/api/v1/clients', headers: auth,
      payload: { name: 'New client', contact: 'Alex', notes: 'Synthetic' },
    })
    assert.equal(list.statusCode, 200)
    assert.deepEqual(list.json(), [{ id: 12, name: 'Example', contact: null, email: null, phone: null, notes: '' }])
    assert.equal(create.statusCode, 201)
    assert.deepEqual(create.json(), {
      id: 13, name: 'New client', contact: 'Alex', email: null, phone: null, notes: 'Synthetic',
    })
    assert.deepEqual(calls, [
      ['list', userId],
      ['create', userId, { name: 'New client', contact: 'Alex', notes: 'Synthetic' }],
    ])
  } finally {
    await app.close()
  }
})

test('clients reject unauthenticated and invalid create requests', async () => {
  const { app } = makeApp()
  try {
    const missing = await app.inject({ method: 'GET', url: '/api/v1/clients' })
    const invalid = await app.inject({
      method: 'POST', url: '/api/v1/clients', headers: auth,
      payload: { name: 3 },
    })
    assert.equal(missing.statusCode, 401)
    assert.equal(invalid.statusCode, 422)
  } finally {
    await app.close()
  }
})

test('client delete is owner scoped and preserves the 204 and 404 responses', async () => {
  const { app, calls } = makeApp()
  try {
    const deleted = await app.inject({ method: 'DELETE', url: '/api/v1/clients/13', headers: auth })
    const missing = await app.inject({ method: 'DELETE', url: '/api/v1/clients/99', headers: auth })
    assert.equal(deleted.statusCode, 204)
    assert.equal(missing.statusCode, 404)
    assert.deepEqual(calls, [['delete', userId, 13], ['delete', userId, 99]])
  } finally {
    await app.close()
  }
})
