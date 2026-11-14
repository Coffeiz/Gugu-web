import assert from 'node:assert/strict'
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import { createApp } from '../../src/app.js'
import { createUserToken } from '../../src/domains/auth/auth.js'

const ownerId = '00000000-0000-4000-8000-000000000061'
const secret = 'synthetic-file-content-host-secret'
const apps: Array<{ close(): Promise<void> }> = []
const directories: string[] = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function makeApp(content: Buffer) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gugu-file-content-'))
  directories.push(directory)
  const filePath = path.join(directory, '合成文件.txt')
  await writeFile(filePath, content)
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
      async getFileLocation() { return null },
      async getSummary() { return {} },
      async getLibraryCounts() { return {} },
      async getStorage() { return {} },
      async openContent(owner, fileId) {
        calls.push(['content', owner, fileId])
        if (owner !== ownerId || fileId !== 23) return null
        const handle = await open(filePath, 'r')
        return {
          file: { id: fileId },
          handle,
          size: (await handle.stat()).size,
          fileName: '合成 文件.txt',
          mimeType: 'text/plain',
        }
      },
    },
  })
  apps.push(app)
  return { app, token: createUserToken(ownerId, 1, secret), calls }
}

test('Local file download streams the exact bytes with a safe filename and physical length', async () => {
  const { app, token, calls } = await makeApp(Buffer.from('file-body'))

  const response = await app.inject({
    url: '/api/v1/files/23/download',
    headers: { authorization: `Bearer ${token}` },
  })

  assert.equal(response.statusCode, 200)
  assert.equal(response.payload, 'file-body')
  assert.equal(response.headers['content-length'], '9')
  assert.equal(response.headers['content-disposition'], "attachment; filename*=UTF-8''%E5%90%88%E6%88%90%20%E6%96%87%E4%BB%B6.txt")
  assert.deepEqual(calls, [['content', ownerId, 23]])
})

test('Local file preview supports byte ranges and rejects an unsatisfiable range', async () => {
  const { app, token } = await makeApp(Buffer.from('0123456789'))
  const headers = { authorization: `Bearer ${token}`, range: 'bytes=2-5' }

  const partial = await app.inject({ url: '/api/v1/files/23/stream', headers })
  const invalid = await app.inject({
    url: '/api/v1/files/23/stream',
    headers: { authorization: `Bearer ${token}`, range: 'bytes=20-' },
  })

  assert.equal(partial.statusCode, 206)
  assert.equal(partial.payload, '2345')
  assert.equal(partial.headers['content-range'], 'bytes 2-5/10')
  assert.equal(partial.headers['content-length'], '4')
  assert.equal(partial.headers['content-disposition'], 'inline')
  assert.equal(invalid.statusCode, 416)
  assert.equal(invalid.headers['content-range'], 'bytes */10')
})

test('empty Local file download returns an empty body without inventing a byte range', async () => {
  const { app, token } = await makeApp(Buffer.alloc(0))

  const response = await app.inject({
    url: '/api/v1/files/23/download',
    headers: { authorization: `Bearer ${token}` },
  })

  assert.equal(response.statusCode, 200)
  assert.equal(response.payload, '')
  assert.equal(response.headers['content-length'], '0')
})
