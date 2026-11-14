import assert from 'node:assert/strict'
import test from 'node:test'
import { createApp } from '../../src/app.js'
import { createUserToken } from '../../src/domains/auth/auth.js'

test('文件夹下载使用认证 owner 并生成安全附件名和 ZIP 响应', async () => {
  const user = '00000000-0000-4000-8000-000000000082'
  const secret = 'synthetic-folder-download-secret'
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
    folderDownloads: { async buildFolder(...args) { calls.push(args); return { bytes: Buffer.from('synthetic-zip'), folderName: '项目 文档' } } },
  })
  try {
    const denied = await app.inject({ url: '/api/v1/folders/9/download' })
    const response = await app.inject({
      url: '/api/v1/folders/9/download',
      headers: { authorization: `Bearer ${createUserToken(user, 1, secret)}` },
    })
    assert.equal(denied.statusCode, 401)
    assert.equal(response.statusCode, 200)
    assert.equal(response.headers['content-type'], 'application/zip')
    assert.equal(response.headers['content-disposition'], "attachment; filename*=UTF-8''%E9%A1%B9%E7%9B%AE%20%E6%96%87%E6%A1%A3.zip")
    assert.equal(response.body, 'synthetic-zip')
    assert.deepEqual(calls, [[user, 9]])
  } finally {
    await app.close()
  }
})
