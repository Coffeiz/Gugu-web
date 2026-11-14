import assert from 'node:assert/strict'
import test from 'node:test'
import { createApp } from '../../src/app.js'
import { createUserToken } from '../../src/domains/auth/auth.js'

test('批量下载通过认证 owner 读取文件与文件夹 ID 并返回 ZIP', async () => {
  const user = '00000000-0000-4000-8000-000000000081'
  const secret = 'synthetic-batch-download-secret'
  const calls: unknown[][] = []
  const app = createApp({
    appName: '合成测试应用', isReady: async () => true,
    userAuth: {
      secret,
      async lookupUser(id) {
        return id === user ? {
          id, username: 'sample', displayName: '示例用户', email: 'sample@example.invalid', avatarUrl: null,
          createdAt: null, timezone: null, emailSubscribed: false, imChannels: [], isActive: true, securityVersion: 1,
        } : null
      },
    },
    fileBatchDownloads: { async build(...args) { calls.push(args); return Buffer.from('synthetic-zip') } },
  })
  try {
    const denied = await app.inject({ method: 'POST', url: '/api/v1/files/batch-download', payload: { ids: [4] } })
    const response = await app.inject({
      method: 'POST', url: '/api/v1/files/batch-download',
      headers: { authorization: `Bearer ${createUserToken(user, 1, secret)}` },
      payload: { ids: [4], folderIds: [9] },
    })
    const invalid = await app.inject({
      method: 'POST', url: '/api/v1/files/batch-download',
      headers: { authorization: `Bearer ${createUserToken(user, 1, secret)}` },
      payload: { ids: ['bad'] },
    })
    assert.equal(denied.statusCode, 401)
    assert.equal(response.statusCode, 200)
    assert.equal(response.headers['content-type'], 'application/zip')
    assert.equal(response.headers['content-disposition'], "attachment; filename*=UTF-8''files.zip")
    assert.equal(response.body, 'synthetic-zip')
    assert.deepEqual(calls, [[user, [4], [9]]])
    assert.equal(invalid.statusCode, 422)
  } finally {
    await app.close()
  }
})
