import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import { registerTelegramConnectRoutes } from '../../../src/modules/im/connect/platforms/telegram/index.js'

test('Telegram connect routes require auth, bind trusted owner, validate DTOs and map safe errors', async () => {
  const app = Fastify()
  const calls: unknown[][] = []
  const secret = '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123456789'
  const ownerId = '00000000-0000-4000-8000-000000000001'
  registerTelegramConnectRoutes(app, {
    requireUser: async (request, reply) => {
      if (request.headers.authorization !== 'user') await reply.code(401).send({ detail: '需要认证' })
    },
    ownerIdFromRequest: () => ownerId,
    connect: {
      connect: async (...args: unknown[]) => { calls.push(['connect', ...args]); return { id: 3, platform: 'telegram', name: '@sample_bot', app_id: '9001', enabled: true } },
      replace: async (...args: unknown[]) => {
        calls.push(['replace', ...args])
        throw Object.assign(new Error('Telegram Bot Token 无效'), { name: 'TelegramConnectionError', statusCode: 400 })
      },
    } as never,
  })
  try {
    const unauthorized = await app.inject({ method: 'POST', url: '/api/v1/me/telegram/connect', payload: { token: secret } })
    assert.equal(unauthorized.statusCode, 401)
    assert.equal(calls.length, 0)

    const invalid = await app.inject({ method: 'POST', url: '/api/v1/me/telegram/connect', headers: { authorization: 'user' }, payload: { token: 123 } })
    assert.equal(invalid.statusCode, 422)
    const created = await app.inject({ method: 'POST', url: '/api/v1/me/telegram/connect', headers: { authorization: 'user' }, payload: { token: secret, owner_id: 'attacker' } })
    assert.equal(created.statusCode, 200)
    assert.deepEqual(created.json(), { id: 3, platform: 'telegram', name: '@sample_bot', app_id: '9001', enabled: true })
    assert.equal(created.body.includes(secret), false)
    assert.deepEqual(calls, [['connect', ownerId, secret]])

    const replaced = await app.inject({ method: 'PUT', url: '/api/v1/me/telegram/connect/3', headers: { authorization: 'user' }, payload: { token: secret } })
    assert.equal(replaced.statusCode, 400)
    assert.equal(replaced.body.includes(secret), false)
    assert.deepEqual(calls.at(-1), ['replace', ownerId, 3, secret])
  } finally { await app.close() }
})
