import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { createApp } from '../../../src/app.js'
import { createUserToken } from '../../../src/modules/auth/session/token.js'

const ownerId = '00000000-0000-4000-8000-000000000051'
const filePath = `${ownerId}/个人文件/示例.txt`
const pathQuery = new URLSearchParams({ path: filePath }).toString()
const secret = 'synthetic-file-read-host-secret'
const apps: Array<{ close(): Promise<void> }> = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

test('file detail, location, summary, counts and storage are mounted behind user auth and use Host owner identity', async () => {
  const calls: unknown[] = []
  const app = createApp({
    appName: '合成测试应用',
    isReady: async () => true,
    userAuth: {
      secret,
      async lookupUser(id) {
        return id === ownerId ? {
          id,
          username: 'sample',
          displayName: '示例用户',
          email: 'sample@example.invalid',
          avatarUrl: null,
          createdAt: null,
          timezone: null,
          emailSubscribed: false,
          imChannels: [],
          isActive: true,
          securityVersion: 1,
        } : null
      },
    },
    fileReads: {
      async getFile(owner, key) { calls.push(['file', owner, key]); return { id: key } },
      async getFileLocation(owner, key) { calls.push(['location', owner, key]); return { file: { id: key }, pathFile: { directoryId: 'personal', relativePath: '示例.txt' } } },
      async getSummary(owner, limit) { calls.push(['summary', owner, limit]); return { recentFiles: [] } },
      async getLibraryCounts(owner) { calls.push(['counts', owner]); return { personalFileCount: 0 } },
      async getStorage(owner) { calls.push(['storage', owner]); return { used_bytes: 0, limit_bytes: null } },
      async openContent(owner, key) { calls.push(['content', owner, key]); return null },
    },
  })
  apps.push(app)
  const token = createUserToken(ownerId, 1, secret)

  const denied = await app.inject({ url: `/api/v1/files/by-path?${pathQuery}` })
  const deniedStorage = await app.inject({ url: '/api/v1/files/storage' })
  const deniedStreamUrl = await app.inject({ url: `/api/v1/files/by-path/stream-url?${pathQuery}` })
  const deniedStream = await app.inject({ url: `/api/v1/files/by-path/stream?${pathQuery}` })
  const deniedDownload = await app.inject({ url: `/api/v1/files/by-path/download?${pathQuery}` })
  const detail = await app.inject({ url: `/api/v1/files/by-path?${pathQuery}`, headers: { authorization: `Bearer ${token}` } })
  const location = await app.inject({ url: `/api/v1/files/by-path/location?${pathQuery}`, headers: { authorization: `Bearer ${token}` } })
  const summary = await app.inject({ url: '/api/v1/files/summary?recent_limit=%20%2B4%20', headers: { authorization: `Bearer ${token}` } })
  const counts = await app.inject({ url: '/api/v1/files/library-counts', headers: { authorization: `Bearer ${token}` } })
  const storage = await app.inject({ url: '/api/v1/files/storage', headers: { authorization: `Bearer ${token}` } })
  const streamUrl = await app.inject({ url: `/api/v1/files/by-path/stream-url?${pathQuery}`, headers: { authorization: `Bearer ${token}` } })
  const missingDownload = await app.inject({ url: `/api/v1/files/by-path/download?${pathQuery}`, headers: { authorization: `Bearer ${token}` } })
  const invalidSummary = await app.inject({ url: '/api/v1/files/summary?recent_limit=1.5', headers: { authorization: `Bearer ${token}` } })

  assert.equal(denied.statusCode, 401)
  assert.equal(deniedStorage.statusCode, 401)
  assert.equal(deniedStreamUrl.statusCode, 401)
  assert.equal(deniedStream.statusCode, 401)
  assert.equal(deniedDownload.statusCode, 401)
  assert.equal(detail.statusCode, 200)
  assert.equal(location.statusCode, 200)
  assert.equal(summary.statusCode, 200)
  assert.equal(counts.statusCode, 200)
  assert.equal(storage.statusCode, 200)
  assert.equal(streamUrl.statusCode, 200)
  assert.deepEqual(streamUrl.json(), { file: { id: filePath }, url: `/api/v1/files/by-path/stream?${pathQuery}` })
  assert.equal(missingDownload.statusCode, 404)
  assert.equal(invalidSummary.statusCode, 422)
  assert.deepEqual(calls, [
    ['file', ownerId, filePath],
    ['location', ownerId, filePath],
    ['summary', ownerId, 4],
    ['counts', ownerId],
    ['storage', ownerId],
    ['file', ownerId, filePath],
    ['content', ownerId, filePath],
  ])
})
