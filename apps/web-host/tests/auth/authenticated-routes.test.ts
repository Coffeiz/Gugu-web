import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import { registerAuthenticatedDomain, authenticatedUser } from '../../src/http/authenticated-domain.js'

test('认证插件只认证一次，并向域路由提供同一个可信上下文', async () => {
  const app = Fastify()
  const user = { id: 'owner-1', context: { ownerId: 'owner-1' } }
  let authenticationCalls = 0

  await registerAuthenticatedDomain(app, async () => {
    authenticationCalls += 1
    return user
  }, (routes) => {
    routes.get('/private', async (request) => authenticatedUser<typeof user>(request))
  })

  const response = await app.inject({ method: 'GET', url: '/private' })
  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json(), user)
  assert.equal(authenticationCalls, 1)
  await app.close()
})

test('认证失败时停止域路由，并保留认证器写入的旧 API 错误响应', async () => {
  const app = Fastify()
  let routeCalls = 0

  await registerAuthenticatedDomain(app, async (_request, reply) => {
    reply.code(403).send({ detail: '账号已停用' })
    return null
  }, (routes) => {
    routes.get('/private', async () => {
      routeCalls += 1
      return { ok: true }
    })
  })

  const response = await app.inject({ method: 'GET', url: '/private' })
  assert.equal(response.statusCode, 403)
  assert.deepEqual(response.json(), { detail: '账号已停用' })
  assert.equal(routeCalls, 0)
  await app.close()
})

test('认证器拒绝请求但未发送响应时返回兼容的 401', async () => {
  const app = Fastify()

  await registerAuthenticatedDomain(app, async () => null, (routes) => {
    routes.get('/private', async () => ({ ok: true }))
  })

  const response = await app.inject({ method: 'GET', url: '/private' })
  assert.equal(response.statusCode, 401)
  assert.deepEqual(response.json(), { detail: '认证失败' })
  await app.close()
})
