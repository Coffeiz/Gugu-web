import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import { AgentFilesystemAuthorizationError } from '../../src/domains/agent-sessions/agent-filesystem-authorization.js'
import { registerAgentFilesystemAuthorizationRoutes } from '../../src/domains/agent-sessions/agent-filesystem-authorization-route.js'

test('会话授权三条路由认证后只使用可信 owner，并保持旧 API 请求响应形状', async () => {
  const app = Fastify()
  const calls: unknown[][] = []
  registerAgentFilesystemAuthorizationRoutes(app, {
    async requireUser() {},
    userIdFromRequest() { return 'owner-from-auth-context' },
    operations: {
      async request(...args) { calls.push(['request', ...args]); return { status: 'waiting_confirmation', confirm_code: 'abcdef123456' } },
      async confirm(...args) { calls.push(['confirm', ...args]); return { status: 'authorized', session_id: 42, grant_id: 9 } },
      async revoke(...args) { calls.push(['revoke', ...args]); return { status: 'revoked', session_id: 42, revoked: true } },
    },
  })
  try {
    const request = await app.inject({
      method: 'POST',
      url: '/api/v1/agent/sessions/42/filesystem-authorization/request?owner_id=attacker',
      headers: { 'x-user-id': 'attacker' },
    })
    const confirm = await app.inject({
      method: 'POST',
      url: '/api/v1/agent/sessions/42/filesystem-authorization',
      payload: { confirm_code: 'abcdef123456' },
    })
    const revoke = await app.inject({
      method: 'DELETE',
      url: '/api/v1/agent/sessions/42/filesystem-authorization',
    })
    assert.equal(request.statusCode, 200)
    assert.deepEqual(request.json(), { status: 'waiting_confirmation', confirm_code: 'abcdef123456' })
    assert.equal(confirm.statusCode, 200)
    assert.deepEqual(confirm.json(), { status: 'authorized', session_id: 42, grant_id: 9 })
    assert.equal(revoke.statusCode, 200)
    assert.deepEqual(revoke.json(), { status: 'revoked', session_id: 42, revoked: true })
    assert.deepEqual(calls, [
      ['request', 'owner-from-auth-context', 42],
      ['confirm', 'owner-from-auth-context', 42, 'abcdef123456'],
      ['revoke', 'owner-from-auth-context', 42],
    ])
  } finally { await app.close() }
})

test('未认证和无效请求不会触发授权操作', async () => {
  const app = Fastify()
  let calls = 0
  registerAgentFilesystemAuthorizationRoutes(app, {
    async requireUser(_request, reply) { return reply.code(401).send({ detail: '未认证' }) },
    userIdFromRequest() { throw new Error('未认证时不得读取身份') },
    operations: {
      async request() { calls += 1; return {} },
      async confirm() { calls += 1; return {} },
      async revoke() { calls += 1; return {} },
    },
  })
  try {
    const unauthenticated = await app.inject({ method: 'POST', url: '/api/v1/agent/sessions/42/filesystem-authorization/request' })
    assert.equal(unauthenticated.statusCode, 401)
  } finally { await app.close() }

  const validated = Fastify()
  registerAgentFilesystemAuthorizationRoutes(validated, {
    async requireUser() {},
    userIdFromRequest() { return 'owner' },
    operations: {
      async request() { calls += 1; return {} },
      async confirm() { calls += 1; return {} },
      async revoke() { calls += 1; return {} },
    },
  })
  try {
    for (const response of [
      await validated.inject({ method: 'POST', url: '/api/v1/agent/sessions/not-a-number/filesystem-authorization/request' }),
      await validated.inject({ method: 'POST', url: '/api/v1/agent/sessions/42/filesystem-authorization', payload: { confirm_code: '' } }),
      await validated.inject({ method: 'DELETE', url: '/api/v1/agent/sessions/999999999999999999/filesystem-authorization' }),
    ]) assert.equal(response.statusCode, 422)
    assert.equal(calls, 0)
  } finally { await validated.close() }
})

test('确认服务不可用保持 Python API 的 503 语义', async () => {
  const app = Fastify()
  registerAgentFilesystemAuthorizationRoutes(app, {
    async requireUser() {},
    userIdFromRequest() { return 'owner' },
    operations: {
      async request() { throw new AgentFilesystemAuthorizationError(503, '确认服务暂不可用，请稍后重试') },
      async confirm() { return {} },
      async revoke() { return {} },
    },
  })
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/agent/sessions/42/filesystem-authorization/request',
    })
    assert.equal(response.statusCode, 503)
    assert.deepEqual(response.json(), { detail: '确认服务暂不可用，请稍后重试' })
  } finally { await app.close() }
})
