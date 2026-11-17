import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import { registerAgentSessionStateRoute } from '../../src/modules/agent-sessions/state.js'

test('会话状态路由先认证，并仅用认证 owner 读取状态', async () => {
  const denied = Fastify()
  registerAgentSessionStateRoute(denied, {
    async requireUser(_request, reply) { return reply.code(401).send({ detail: '未认证' }) },
    ownerIdFromRequest() { throw new Error('未认证时不得解析 owner') },
    async readState() { throw new Error('未认证时不得读取状态') },
  })
  try {
    assert.equal((await denied.inject({ url: '/api/v1/agent/sessions/42/state' })).statusCode, 401)
  } finally { await denied.close() }

  const app = Fastify()
  const calls: unknown[][] = []
  registerAgentSessionStateRoute(app, {
    async requireUser() {},
    ownerIdFromRequest() { return 'trusted-owner' },
    async readState(...args) { calls.push(args); return { executionState: 'idle', pendingMessageCount: 2, active: false } },
  })
  try {
    const response = await app.inject({ url: '/api/v1/agent/sessions/42/state' })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { executionState: 'idle', pendingMessageCount: 2, active: false })
    assert.deepEqual(calls, [['trusted-owner', 42]])
  } finally { await app.close() }
})

test('会话状态路由区分非法 ID 与 owner 隔离的不存在会话', async () => {
  const app = Fastify()
  registerAgentSessionStateRoute(app, {
    async requireUser() {},
    ownerIdFromRequest() { return 'trusted-owner' },
    async readState() { return null },
  })
  try {
    const invalid = await app.inject({ url: '/api/v1/agent/sessions/0/state' })
    assert.equal(invalid.statusCode, 422)
    assert.deepEqual(invalid.json(), { detail: '会话 ID 无效' })
    const missing = await app.inject({ url: '/api/v1/agent/sessions/42/state' })
    assert.equal(missing.statusCode, 404)
    assert.deepEqual(missing.json(), { detail: '对话不存在' })
  } finally { await app.close() }
})
