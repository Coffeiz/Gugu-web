import assert from 'node:assert/strict'
import test from 'node:test'
import { createApp } from '../../src/app.js'
import { createUserToken } from '../../src/modules/auth/auth.js'

test('生产 App 将 MCP 创建限制在认证 owner 并保留 Python 创建响应', async () => {
  const owner = '00000000-0000-4000-8000-000000000311'
  const secret = 'synthetic-mcp-host-secret'
  const calls: unknown[][] = []
  const app = createApp({
    appName: '合成 MCP 测试应用', isReady: async () => true,
    userAuth: { secret, async lookupUser(id) { return id === owner ? {
      id, username: 'sample', displayName: '小北', email: 'sample@example.invalid', avatarUrl: null,
      createdAt: null, timezone: null, emailSubscribed: false, imChannels: [], isActive: true, securityVersion: 1,
    } : null } },
    mcpServerCreate: { async create(ownerId, input) {
      calls.push([ownerId, input])
      return { id: 'synthetic-server-id', name: input.name, scope: 'user', has_credentials: false }
    } },
  })
  try {
    const url = '/api/v1/mcp/servers'
    const payload = { name: 'weather', endpoint: 'https://mcp.example/rpc' }
    assert.equal((await app.inject({ method: 'POST', url, payload })).statusCode, 401)
    const response = await app.inject({ method: 'POST', url, headers: {
      authorization: `Bearer ${createUserToken(owner, 1, secret)}`,
      'x-user-id': '00000000-0000-4000-8000-000000000399',
    }, payload })
    assert.equal(response.statusCode, 201)
    assert.equal(response.json().has_credentials, false)
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.[0], owner)
  } finally { await app.close() }
})
