import assert from 'node:assert/strict'
import test from 'node:test'
import { createApp } from '../../src/app.js'
import { createUserToken, type PublicUserRecord } from '../../src/domains/auth/auth.js'
import type { UserAvatarOperations } from '../../src/domains/auth/avatar.js'

const ownerId = '00000000-0000-4000-8000-000000000011'
const secret = 'synthetic-test-secret-for-user-avatar'
const owner: PublicUserRecord = {
  id: ownerId,
  username: 'avatar-user',
  displayName: '头像用户',
  email: 'avatar-user@example.test',
  isActive: true,
  accountStatus: 'active',
  securityVersion: 1,
  avatarUrl: `/api/v1/auth/avatar/${ownerId}?v=first-upload`,
  createdAt: '2026-11-01T00:00:00.000Z',
  timezone: 'Asia/Shanghai',
  emailSubscribed: false,
  imChannels: [],
}

function multipartPayload(mediaType: string, data: Buffer, filename = 'clipboard') {
  const boundary = 'gugu-avatar-regression-boundary'
  return {
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mediaType}\r\n\r\n`),
      data,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  }
}

function appWithAvatar(operations: UserAvatarOperations) {
  return createApp({
    appName: 'avatar-test',
    async isReady() { return true },
    userAuth: {
      secret,
      async lookupUser(userId) { return userId === ownerId ? owner : null },
    },
    userAvatar: operations,
  })
}

test('public avatar reads return stored bytes and not-found results without requiring user authentication', async () => {
  const operations: UserAvatarOperations = {
    async upload() { return owner },
    async read(userId) {
      return userId === ownerId ? { data: Buffer.from('avatar-bytes'), mediaType: 'image/png' } : null
    },
  }
  const app = appWithAvatar(operations)

  const image = await app.inject({ method: 'GET', url: `/api/v1/auth/avatar/${ownerId}?v=123` })
  const missing = await app.inject({ method: 'GET', url: '/api/v1/auth/avatar/00000000-0000-4000-8000-000000000099' })
  const malformed = await app.inject({ method: 'GET', url: '/api/v1/auth/avatar/not-a-user-id' })
  await app.close()

  assert.equal(image.statusCode, 200)
  assert.equal(image.headers['content-type'], 'image/png')
  assert.equal(image.headers['cache-control'], 'no-cache')
  assert.equal(image.body, 'avatar-bytes')
  assert.equal(missing.statusCode, 404)
  assert.equal(malformed.statusCode, 422)
})

test('avatar upload is authenticated, derives owner from Host identity, and returns a cache-busted public user record', async () => {
  const calls: Array<{ ownerId: string; mediaType: string; data: Buffer }> = []
  const app = appWithAvatar({
    async upload(userId, mediaType, data) {
      calls.push({ ownerId: userId, mediaType, data })
      return owner
    },
    async read() { return null },
  })

  const denied = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/avatar',
    ...multipartPayload('image/png', Buffer.from('private avatar')),
  })
  const uploaded = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/avatar',
    headers: {
      ...multipartPayload('image/png', Buffer.from('private avatar')).headers,
      authorization: `Bearer ${createUserToken(ownerId, 1, secret)}`,
    },
    payload: multipartPayload('image/png', Buffer.from('private avatar')).payload,
  })
  await app.close()

  assert.equal(denied.statusCode, 401)
  assert.equal(uploaded.statusCode, 200)
  assert.equal(uploaded.json().avatar_url, owner.avatarUrl)
  assert.deepEqual(calls, [{ ownerId, mediaType: 'image/png', data: Buffer.from('private avatar') }])
})

test('avatar upload rejects unsupported media types and payloads larger than five megabytes', async () => {
  const app = appWithAvatar({ async upload() { return owner }, async read() { return null } })
  const authorization = `Bearer ${createUserToken(ownerId, 1, secret)}`
  const unsupportedPayload = multipartPayload('image/svg+xml', Buffer.from('<svg/>'))
  const unsupported = await app.inject({
    method: 'POST', url: '/api/v1/auth/avatar', headers: { ...unsupportedPayload.headers, authorization },
    payload: unsupportedPayload.payload,
  })
  const oversizedPayload = multipartPayload('image/jpeg', Buffer.alloc(5 * 1024 * 1024 + 1))
  const oversized = await app.inject({
    method: 'POST', url: '/api/v1/auth/avatar', headers: { ...oversizedPayload.headers, authorization },
    payload: oversizedPayload.payload,
  })
  await app.close()

  assert.equal(unsupported.statusCode, 400)
  assert.equal(oversized.statusCode, 400)
})
