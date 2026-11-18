import assert from 'node:assert/strict'
import Fastify from 'fastify'
import test from 'node:test'
import { CoreError } from '@gugu/core'
import { registerTerminalCreateRoute } from '../../src/modules/terminals/create-route.js'

test('认证终端创建将 Python DTO 与客户端 origin 交给 Core 并返回 201', async () => {
  const app = Fastify()
  const calls: unknown[][] = []
  registerTerminalCreateRoute(app, {
    async requireUser() {},
    ownerIdFromRequest: () => 'owner-a',
    async create(owner, input) {
      calls.push([owner, input])
      return { id: 'term-1', name: input.name, mode: input.mode } as never
    },
  })
  try {
    const response = await app.inject({ method: 'POST', url: '/api/v1/terminals', headers: { 'x-client-id': 'client-a' },
      payload: { name: '新终端', sessionId: 71, workspaceId: 41, mode: 'agent-events' } })
    assert.equal(response.statusCode, 201)
    assert.deepEqual(response.json(), { id: 'term-1', name: '新终端', mode: 'agent-events' })
    assert.deepEqual(calls, [['owner-a', { name: '新终端', sessionId: 71, workspaceId: 41, mode: 'agent-events', origin: 'client-a' }]])
  } finally { await app.close() }
})

test('终端创建保留 422 DTO 错误和 Core owner-scoped 404', async () => {
  const app = Fastify()
  registerTerminalCreateRoute(app, {
    async requireUser() {}, ownerIdFromRequest: () => 'owner-a',
    async create() { throw new CoreError('not_found', '会话不存在') },
  })
  try {
    const invalid = await app.inject({ method: 'POST', url: '/api/v1/terminals', payload: { name: '', mode: 'unknown' } })
    assert.equal(invalid.statusCode, 422)
    const missing = await app.inject({ method: 'POST', url: '/api/v1/terminals', payload: { sessionId: 999 } })
    assert.equal(missing.statusCode, 404)
    assert.deepEqual(missing.json(), { detail: '会话不存在' })
  } finally { await app.close() }
})
