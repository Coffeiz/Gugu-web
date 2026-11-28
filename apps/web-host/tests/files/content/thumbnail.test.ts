import assert from 'node:assert/strict'
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import { createApp } from '../../../src/app.js'
import { createUserToken } from '../../../src/modules/auth/session/token.js'

const ownerId = '00000000-0000-4000-8000-000000000071'
const otherOwnerId = '00000000-0000-4000-8000-000000000072'
const secret = 'synthetic-file-thumbnail-host-secret'
const filePath = `${ownerId}/个人文件/合成图片.png`
const thumbnailUrl = (size: string) => `/api/v1/files/by-path/thumb?${new URLSearchParams({ path: filePath, size })}`
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=',
  'base64',
)
const apps: Array<{ close(): Promise<void> }> = []
const directories: string[] = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function makeApp(mimeType: string | null = 'image/png', hasPhysicalFile = true) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gugu-file-thumbnail-'))
  directories.push(directory)
  const diskFilePath = path.join(directory, '合成图片.png')
  await writeFile(diskFilePath, png)
  const calls: unknown[] = []
  const app = createApp({
    appName: '合成测试应用',
    isReady: async () => true,
    userAuth: {
      secret,
      async lookupUser(id) {
        return id === ownerId || id === otherOwnerId ? {
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
      async getFile(owner, requestedPath) {
        calls.push(['file', owner, requestedPath])
        return owner === ownerId && requestedPath === `${ownerId}/个人文件/合成图片.png` ? { filePath: requestedPath, mimeType, version: 4 } : null
      },
      async getFileLocation() { return null },
      async getSummary() { return {} },
      async getLibraryCounts() { return {} },
      async getStorage() { return {} },
      async openContent(owner, requestedPath) {
        calls.push(['content', owner, requestedPath])
        if (owner !== ownerId || requestedPath !== `${ownerId}/个人文件/合成图片.png` || !hasPhysicalFile) return null
        const handle = await open(diskFilePath, 'r')
        return {
          file: { filePath: requestedPath, mimeType, version: 4 },
          handle,
          size: (await handle.stat()).size,
          fileName: '合成 图片.png',
          mimeType: mimeType || 'application/octet-stream',
        }
      },
    },
  })
  apps.push(app)
  return {
    app,
    token: createUserToken(ownerId, 1, secret),
    otherToken: createUserToken(otherOwnerId, 1, secret),
    calls,
  }
}

test('File thumbnail full size returns the owned image bytes and private cache policy', async () => {
  const { app, token, calls } = await makeApp()

  const unauthorized = await app.inject({ url: thumbnailUrl('full') })
  const response = await app.inject({
    url: thumbnailUrl('full'),
    headers: { authorization: `Bearer ${token}` },
  })

  assert.equal(unauthorized.statusCode, 401)
  assert.equal(response.statusCode, 200)
  assert.equal(response.headers['content-type'], 'image/png')
  assert.equal(response.headers['cache-control'], 'private, max-age=86400')
  assert.deepEqual(response.rawPayload, png)
  assert.deepEqual(calls, [['file', ownerId, filePath], ['content', ownerId, filePath]])
})

test('File thumbnail reports an owned record with a missing physical file as 404', async () => {
  const { app, token, calls } = await makeApp('image/png', false)

  const response = await app.inject({
    url: thumbnailUrl('full'),
    headers: { authorization: `Bearer ${token}` },
  })

  assert.equal(response.statusCode, 404)
  assert.equal(response.json<{ detail: string }>().detail, '物理文件丢失')
  assert.deepEqual(calls, [['file', ownerId, filePath], ['content', ownerId, filePath]])
})

test('File thumbnail hides another owner and returns unsupported-media for non-image content', async () => {
  const { app, token, otherToken, calls } = await makeApp('text/plain')

  const forbidden = await app.inject({
    url: thumbnailUrl('full'),
    headers: { authorization: `Bearer ${otherToken}` },
  })
  const unsupported = await app.inject({
    url: thumbnailUrl('full'),
    headers: { authorization: `Bearer ${token}` },
  })

  assert.equal(forbidden.statusCode, 404)
  assert.equal(unsupported.statusCode, 415)
  assert.deepEqual(calls, [
    ['file', otherOwnerId, filePath],
    ['file', ownerId, filePath],
  ])
})

test('File thumbnail tiny size is rendered as WebP', async () => {
  const { app, token } = await makeApp()

  const response = await app.inject({
    url: thumbnailUrl('tiny'),
    headers: { authorization: `Bearer ${token}` },
  })

  assert.equal(response.statusCode, 200)
  assert.equal(response.headers['content-type'], 'image/webp')
  assert.equal(response.rawPayload.toString('ascii', 0, 4), 'RIFF')
  assert.equal(response.rawPayload.toString('ascii', 8, 12), 'WEBP')
})
