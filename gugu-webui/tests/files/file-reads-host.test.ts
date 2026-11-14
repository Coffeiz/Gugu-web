import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { createApp } from '../../src/app.js'
import { createUserToken } from '../../src/domains/auth/auth.js'

const ownerId = '00000000-0000-4000-8000-000000000051'
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
      async getFile(owner, fileId) { calls.push(['file', owner, fileId]); return { id: fileId } },
      async getFileLocation(owner, fileId) { calls.push(['location', owner, fileId]); return { file: { id: fileId }, folderPath: [] } },
      async getSummary(owner, limit) { calls.push(['summary', owner, limit]); return { recentFiles: [] } },
      async getLibraryCounts(owner) { calls.push(['counts', owner]); return { personalFileCount: 0 } },
      async getStorage(owner) { calls.push(['storage', owner]); return { used_bytes: 0, limit_bytes: null } },
      async openContent(owner, fileId) { calls.push(['content', owner, fileId]); return null },
    },
  })
  apps.push(app)
  const token = createUserToken(ownerId, 1, secret)

  const denied = await app.inject({ url: '/api/v1/files/17' })
  const deniedStorage = await app.inject({ url: '/api/v1/files/storage' })
  const deniedStreamUrl = await app.inject({ url: '/api/v1/files/17/stream-url' })
  const deniedStream = await app.inject({ url: '/api/v1/files/17/stream' })
  const deniedDownload = await app.inject({ url: '/api/v1/files/17/download' })
  const detail = await app.inject({ url: '/api/v1/files/17', headers: { authorization: `Bearer ${token}` } })
  const location = await app.inject({ url: '/api/v1/files/17/location', headers: { authorization: `Bearer ${token}` } })
  const summary = await app.inject({ url: '/api/v1/files/summary?recent_limit=%20%2B4%20', headers: { authorization: `Bearer ${token}` } })
  const counts = await app.inject({ url: '/api/v1/files/library-counts', headers: { authorization: `Bearer ${token}` } })
  const storage = await app.inject({ url: '/api/v1/files/storage', headers: { authorization: `Bearer ${token}` } })
  const streamUrl = await app.inject({ url: '/api/v1/files/17/stream-url', headers: { authorization: `Bearer ${token}` } })
  const missingDownload = await app.inject({ url: '/api/v1/files/17/download', headers: { authorization: `Bearer ${token}` } })
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
  assert.deepEqual(streamUrl.json(), { file: { id: 17 }, url: '/api/v1/files/17/stream' })
  assert.equal(missingDownload.statusCode, 404)
  assert.equal(invalidSummary.statusCode, 422)
  assert.deepEqual(calls, [
    ['file', ownerId, 17],
    ['location', ownerId, 17],
    ['summary', ownerId, 4],
    ['counts', ownerId],
    ['storage', ownerId],
    ['file', ownerId, 17],
    ['content', ownerId, 17],
  ])
})

test('relative file path resolution requires authentication and validates bounded path batches', async () => {
  const calls: unknown[] = []
  const app = createApp({
    appName: '合成测试应用', isReady: async () => true,
    userAuth: {
      secret,
      async lookupUser(id) {
        return id === ownerId ? {
          id, username: 'sample', displayName: '示例用户', email: 'sample@example.invalid', avatarUrl: null,
          createdAt: null, timezone: null, emailSubscribed: false, imChannels: [], isActive: true, securityVersion: 1,
        } : null
      },
    },
    fileReads: {
      async getFile() { return null }, async getFileLocation() { return null },
      async getSummary() { return { recentFiles: [] } }, async getLibraryCounts() { return {} },
      async getStorage() { return {} }, async openContent() { return null },
      async resolveRelativePaths(owner, fileId, paths) {
        calls.push([owner, fileId, paths])
        return paths.map((path) => ({ path, file: null, folder: null }))
      },
    },
  })
  apps.push(app)
  const token = createUserToken(ownerId, 1, secret)
  const denied = await app.inject({ method: 'POST', url: '/api/v1/files/17/resolve-paths', payload: { paths: ['note.md'] } })
  const response = await app.inject({
    method: 'POST', url: '/api/v1/files/17/resolve-paths', headers: { authorization: `Bearer ${token}` },
    payload: { paths: ['../note.md', '%E5%9B%BE%E7%89%87%2Fdiagram.svg?size=large'] },
  })
  const invalid = await app.inject({
    method: 'POST', url: '/api/v1/files/17/resolve-paths', headers: { authorization: `Bearer ${token}` },
    payload: { paths: ['x'.repeat(1001)] },
  })
  assert.equal(denied.statusCode, 401)
  assert.equal(response.statusCode, 200)
  assert.equal(response.json().length, 2)
  assert.deepEqual(calls, [[ownerId, 17, ['../note.md', '%E5%9B%BE%E7%89%87%2Fdiagram.svg?size=large']]])
  assert.equal(invalid.statusCode, 422)
})
