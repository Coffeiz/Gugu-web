import assert from 'node:assert/strict'
import test from 'node:test'
import { CoreError } from '@gugu/core'
import { createApp } from '../../../src/app.js'
import { signedUserToken } from '../../helpers/auth.js'

test('DELETE 草稿附件只把已认证 owner 传给 Core 并保留 Python 回执', async () => {
  const secret = 'synthetic-attachment-delete-secret'
  const owner = 'cfa94a82-62d0-44a3-88bc-8c0cf37e5085'
  const calls: string[][] = []
  const app = createApp({
    appName: '附件删除测试', isReady: async () => true,
    userAuth: { secret, async lookupUser(id) { return {
      id, username: 'moon_example', displayName: null, email: 'moon@example.test', avatarUrl: null,
      createdAt: null, timezone: null, emailSubscribed: false, imChannels: [], isActive: true,
    } } },
    attachmentDelete: { remove: async (userId, attachmentId) => {
      calls.push([userId, attachmentId])
      if (attachmentId === 'missing') throw new CoreError('not_found', '附件不存在')
      if (attachmentId === 'attached') throw new CoreError('conflict', '附件已被使用，无法删除')
      return { deleted: true }
    } },
  })
  try {
    const anonymous = await app.inject({ method: 'DELETE', url: '/api/v1/agent/attachment/draft-1' })
    const response = await app.inject({ method: 'DELETE', url: '/api/v1/agent/attachment/draft-1', headers: {
      authorization: `Bearer ${signedUserToken(secret, owner)}`,
    } })
    const missing = await app.inject({ method: 'DELETE', url: '/api/v1/agent/attachment/missing', headers: {
      authorization: `Bearer ${signedUserToken(secret, owner)}`,
    } })
    const attached = await app.inject({ method: 'DELETE', url: '/api/v1/agent/attachment/attached', headers: {
      authorization: `Bearer ${signedUserToken(secret, owner)}`,
    } })
    assert.equal(anonymous.statusCode, 401)
    assert.equal(response.statusCode, 200)
    assert.equal(missing.statusCode, 404)
    assert.deepEqual(missing.json(), { detail: '附件不存在' })
    assert.equal(attached.statusCode, 409)
    assert.deepEqual(attached.json(), { detail: '附件已被使用，无法删除' })
    assert.deepEqual(response.json(), { deleted: true })
    assert.deepEqual(calls, [[owner, 'draft-1'], [owner, 'missing'], [owner, 'attached']])
  } finally { await app.close() }
})
