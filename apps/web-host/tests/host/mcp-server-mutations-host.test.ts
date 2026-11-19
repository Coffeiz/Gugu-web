import assert from 'node:assert/strict'
import test from 'node:test'
import { createApp } from '../../src/app.js'
import { createUserToken } from '../../src/modules/auth/session/token.js'
import { CoreError } from '@gugu/core'

test('生产 App 将 MCP 配置 PATCH/DELETE 限定到认证 owner 并保留更新回执', async () => {
  const owner = '00000000-0000-4000-8000-000000000321'
  const secret = 'synthetic-mcp-mutation-host-secret'
  const calls: string[] = []
  const app = createApp({
    appName: '合成 MCP 配置测试应用', isReady: async () => true,
    userAuth: { secret, async lookupUser(id) { return id === owner ? {
      id, username: 'sample', displayName: '小北', email: 'sample@example.invalid', avatarUrl: null,
      createdAt: null, timezone: null, emailSubscribed: false, imChannels: [], isActive: true, securityVersion: 1,
    } : null } },
    mcpServerConfig: { operations: {
      async list() { return { enabled: true, max_servers: 4, items: [] } },
      async create() { return { id: 'server-id' } },
      async update(ownerId, id, patch) { if (id === 'missing') throw new CoreError('not_found', 'MCP server 不存在'); calls.push(`update:${ownerId}:${id}:${String(patch.enabled)}`); return { id, enabled: patch.enabled } },
      async remove(ownerId, id) { calls.push(`delete:${ownerId}:${id}`); return { deleted: true, id } },
    } },
  })
  try {
    const headers = { authorization: `Bearer ${createUserToken(owner, 1, secret)}` }
    const denied = await app.inject({ method: 'PATCH', url: '/api/v1/mcp/servers/server-id', payload: { enabled: false } })
    assert.equal(denied.statusCode, 401)
    const changed = await app.inject({ method: 'PATCH', url: '/api/v1/mcp/servers/server-id', headers, payload: { enabled: false } })
    assert.equal(changed.statusCode, 200)
    assert.deepEqual(changed.json(), { id: 'server-id', enabled: false })
    const missing = await app.inject({ method: 'PATCH', url: '/api/v1/mcp/servers/missing', headers, payload: { enabled: false } })
    assert.equal(missing.statusCode, 404)
    assert.deepEqual(missing.json(), { detail: 'MCP server 不存在' })
    const removed = await app.inject({ method: 'DELETE', url: '/api/v1/mcp/servers/server-id', headers })
    assert.equal(removed.statusCode, 200)
    assert.deepEqual(calls, [
      `update:${owner}:server-id:false`,
      `delete:${owner}:server-id`,
    ])
  } finally { await app.close() }
})
