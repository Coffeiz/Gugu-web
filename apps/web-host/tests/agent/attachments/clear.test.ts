import assert from 'node:assert/strict'
import test from 'node:test'
import { createApp } from '../../../src/app.js'
import { signedUserToken } from '../../helpers/auth.js'

test('DELETE 全部暂存附件只清当前 owner 并返回 Python deleted 数量', async () => {
  const secret = 'synthetic-attachment-clear-secret'
  const owner = 'cfa94a82-62d0-44a3-88bc-8c0cf37e5085'
  const owners: string[] = []
  const app = createApp({
    appName: '附件清理测试', isReady: async () => true,
    userAuth: { secret, async lookupUser(id) { return {
      id, username: 'moon_example', displayName: null, email: 'moon@example.test', avatarUrl: null,
      createdAt: null, timezone: null, emailSubscribed: false, imChannels: [], isActive: true,
    } } },
    attachmentClear: { clear: async userId => { owners.push(userId); return { deleted: 3 } } },
  })
  try {
    const anonymous = await app.inject({ method: 'DELETE', url: '/api/v1/agent/attachments' })
    const response = await app.inject({ method: 'DELETE', url: '/api/v1/agent/attachments', headers: {
      authorization: `Bearer ${signedUserToken(secret, owner)}`,
    } })
    assert.equal(anonymous.statusCode, 401)
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { deleted: 3 })
    assert.deepEqual(owners, [owner])
  } finally { await app.close() }
})
