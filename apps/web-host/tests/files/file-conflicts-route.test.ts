import assert from 'node:assert/strict'
import test from 'node:test'
import { createApp } from '../../src/app.js'
import { createUserToken } from '../../src/domains/auth/auth.js'

test('文件冲突探测路由认证用户、保持请求顺序并规范默认目标空间', async () => {
  const user = '00000000-0000-4000-8000-000000000071'
  const secret = 'synthetic-file-conflict-host-secret'
  const calls: unknown[][] = []
  const app = createApp({
    appName: '合成测试应用',
    isReady: async () => true,
    userAuth: {
      secret,
      async lookupUser(id) {
        return id === user ? {
          id, username: 'sample', displayName: '示例用户', email: 'sample@example.invalid', avatarUrl: null,
          createdAt: null, timezone: null, emailSubscribed: false, imChannels: [], isActive: true, securityVersion: 1,
        } : null
      },
    },
    fileConflicts: { async find(...args) { calls.push(args); return [{ filename: 'report.pdf', conflict: false, existing_file: null }] } },
  })
  try {
    const denied = await app.inject({ method: 'POST', url: '/api/v1/files/check-conflicts', payload: { items: [] } })
    assert.equal(denied.statusCode, 401)
    const response = await app.inject({
      method: 'POST', url: '/api/v1/files/check-conflicts',
      headers: { authorization: `Bearer ${createUserToken(user, 1, secret)}` },
      payload: { items: [{ filename: 'report.pdf' }, { filename: '.env.local', space: 'project', projectId: 4, folderId: 8 }] },
    })
    assert.equal(response.statusCode, 200)
    assert.equal(response.json()[0].filename, 'report.pdf')
    assert.equal(calls.length, 1)
    assert.equal(calls[0]![0], user)
    assert.deepEqual(calls[0]![1], [
      { filename: 'report.pdf', space: 'personal', projectId: null, folderId: null, workspaceDirectoryId: null },
      { filename: '.env.local', space: 'project', projectId: 4, folderId: 8, workspaceDirectoryId: null },
    ])
    const invalid = await app.inject({
      method: 'POST', url: '/api/v1/files/check-conflicts',
      headers: { authorization: `Bearer ${createUserToken(user, 1, secret)}` },
      payload: { items: [null] },
    })
    assert.equal(invalid.statusCode, 422)
  } finally {
    await app.close()
  }
})
