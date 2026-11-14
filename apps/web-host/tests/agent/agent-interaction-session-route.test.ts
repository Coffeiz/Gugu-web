import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import {
  InteractionNotFoundError,
} from '../../src/domains/agent-sessions/persistence/agent-interaction-session.js'
import {
  registerAgentInteractionSessionRoute,
} from '../../src/domains/agent-sessions/agent-interaction-session-route.js'

test('敏感交互深链路由先认证，不读取身份或查询 prompt', async () => {
  const app = Fastify()
  registerAgentInteractionSessionRoute(app, {
    async requireUser(_request, reply) { return reply.code(401).send({ detail: '未认证' }) },
    userIdFromRequest() { throw new Error('未认证时不得读取身份') },
    async lookup() { throw new Error('未认证时不得读取 prompt') },
  })
  try {
    const response = await app.inject({ method: 'GET', url: '/api/v1/agent/interactions/7/session' })
    assert.equal(response.statusCode, 401)
    assert.deepEqual(response.json(), { detail: '未认证' })
  } finally { await app.close() }
})

test('深链只使用可信 owner 并只返回所属 session_id', async () => {
  const app = Fastify(), calls: Array<[string, number]> = []
  registerAgentInteractionSessionRoute(app, {
    async requireUser() {},
    userIdFromRequest() { return 'owner-from-auth-context' },
    async lookup(ownerId, promptId) {
      calls.push([ownerId, promptId])
      return { session_id: 42 }
    },
  })
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/agent/interactions/8/session?owner_id=attacker',
      headers: { 'x-user-id': 'attacker' },
    })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { session_id: 42 })
    assert.deepEqual(calls, [['owner-from-auth-context', 8]])
    assert.doesNotMatch(response.body, /secret|credential|owner-from-auth-context/)
  } finally { await app.close() }
})

test('错误路径 ID 返回 422，owner 不匹配或非凭据交互映射为 404', async () => {
  const app = Fastify()
  registerAgentInteractionSessionRoute(app, {
    async requireUser() {},
    userIdFromRequest() { return 'owner' },
    async lookup() { throw new InteractionNotFoundError() },
  })
  try {
    const invalid = await app.inject({ method: 'GET', url: '/api/v1/agent/interactions/not-a-number/session' })
    assert.equal(invalid.statusCode, 422)
    const hidden = await app.inject({ method: 'GET', url: '/api/v1/agent/interactions/999/session' })
    assert.equal(hidden.statusCode, 404)
    assert.deepEqual(hidden.json(), { detail: '交互不存在' })
  } finally { await app.close() }
})
