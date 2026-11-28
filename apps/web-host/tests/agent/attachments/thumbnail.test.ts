import assert from 'node:assert/strict'
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import { createApp } from '../../../src/app.js'
import { createUserToken } from '../../../src/modules/auth/session/token.js'

const ownerId = '00000000-0000-4000-8000-000000000081'
const secret = 'synthetic-attachment-thumbnail-secret'
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=', 'base64')
const apps: Array<{ close(): Promise<void> }> = []
const directories: string[] = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function makeApp(metadata: { kind?: string; ext?: string; mimeType?: string; qqFace?: boolean } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gugu-attachment-thumbnail-'))
  directories.push(directory)
  const filePath = path.join(directory, 'sample.png')
  await writeFile(filePath, png)
  const app = createApp({
    appName: 'Synthetic attachment thumbnail app',
    isReady: async () => true,
    userAuth: {
      secret,
      async lookupUser(id) {
        return id === ownerId ? {
          id, username: 'sample', displayName: null, email: 'sample@example.invalid', avatarUrl: null,
          createdAt: null, timezone: null, emailSubscribed: false, imChannels: [], isActive: true, securityVersion: 1,
        } : null
      },
    },
    attachmentDownload: {
      async download(owner, attachId) {
        if (owner !== ownerId || attachId !== 'asset-1') throw Object.assign(new Error('附件不存在或已过期'), { statusCode: 404 })
        const handle = await open(filePath, 'r')
        return {
          handle, size: (await handle.stat()).size, fileName: 'sample.png', mimeType: metadata.mimeType ?? 'image/png',
          ext: metadata.ext ?? 'png', kind: metadata.kind ?? 'image', qqFace: metadata.qqFace ?? false,
        }
      },
    },
  })
  apps.push(app)
  return { app, token: createUserToken(ownerId, 1, secret) }
}

test('Attachment thumbnail requires authentication and returns JPEG with private cache', async () => {
  const { app, token } = await makeApp()
  const unauthorized = await app.inject({ url: '/api/v1/agent/attachment/asset-1/thumb' })
  const response = await app.inject({
    url: '/api/v1/agent/attachment/asset-1/thumb',
    headers: { authorization: `Bearer ${token}` },
  })

  assert.equal(unauthorized.statusCode, 401)
  assert.equal(response.statusCode, 200)
  assert.equal(response.headers['content-type'], 'image/jpeg')
  assert.equal(response.headers['cache-control'], 'private, max-age=3600')
  assert.deepEqual([...response.rawPayload.subarray(0, 2)], [0xff, 0xd8])
})

test('Attachment thumbnail hides foreign, expired and non-image attachments as 404', async () => {
  const { app, token } = await makeApp({ kind: 'file' })
  const foreign = await app.inject({
    url: '/api/v1/agent/attachment/other/thumb',
    headers: { authorization: `Bearer ${token}` },
  })
  const nonImage = await app.inject({
    url: '/api/v1/agent/attachment/asset-1/thumb',
    headers: { authorization: `Bearer ${token}` },
  })

  assert.equal(foreign.statusCode, 404)
  assert.equal(nonImage.statusCode, 404)
})

test('Attachment thumbnail preserves animated formats on full requests and serves SVG unchanged', async () => {
  const animated = await makeApp({ ext: 'gif', mimeType: 'image/gif', qqFace: true })
  const full = await animated.app.inject({
    url: '/api/v1/agent/attachment/asset-1/thumb?size=full',
    headers: { authorization: `Bearer ${animated.token}` },
  })
  const svg = await makeApp({ ext: 'svg', mimeType: 'image/svg+xml' })
  const svgResponse = await svg.app.inject({
    url: '/api/v1/agent/attachment/asset-1/thumb?size=card',
    headers: { authorization: `Bearer ${svg.token}` },
  })

  assert.equal(full.statusCode, 200)
  assert.equal(full.headers['content-type'], 'image/gif')
  assert.deepEqual(full.rawPayload, png)
  assert.equal(svgResponse.statusCode, 200)
  assert.equal(svgResponse.headers['content-type'], 'image/svg+xml')
  assert.deepEqual(svgResponse.rawPayload, png)
})
