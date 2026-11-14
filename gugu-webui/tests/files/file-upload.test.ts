import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import Fastify from 'fastify'
import { installHttpErrorHandler } from '../../src/http/errors.js'
import {
  installFileUploadSupport,
  registerFileUploadRoutes,
  type FileUploadInput,
  type StagedUpload,
} from '../../src/domains/files/file-upload.js'

function multipart(fields: Array<[string, string]>, filename = '资料.txt', content = '正文') {
  const boundary = 'gugu-upload-test-boundary'
  const parts = fields.map(([name, value]) =>
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/plain\r\n\r\n${content}\r\n`)
  parts.push(`--${boundary}--\r\n`)
  return { boundary, payload: parts.join('') }
}

function imageMultipart(content: Buffer, mimeType = 'image/png') {
  const boundary = 'gugu-upload-image-test-boundary'
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="space"\r\n\r\npersonal\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="图像.png"\r\nContent-Type: ${mimeType}\r\n\r\n`),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ])
  return { boundary, payload }
}

function fixture(capacity: number | null = null) {
  const app = Fastify({ logger: false })
  installHttpErrorHandler(app)
  installFileUploadSupport(app)
  type StoredUpload = { upload: StagedUpload; input: FileUploadInput; ownerId: string; content: string }
  const captured: { stored: StoredUpload | null } = {
    stored: null,
  }
  registerFileUploadRoutes(app, {
    requireUser: async () => undefined,
    ownerIdFromRequest: () => '11111111-1111-4111-8111-111111111111',
    operations: {
      async getUploadCapacity() { return capacity },
      async store(ownerId, upload) {
        captured.stored = { upload, input: upload.input, ownerId, content: await readFile(upload.path, 'utf8') }
        return { id: 12, displayName: upload.originalName }
      },
    },
  })
  return { app, getStored(): StoredUpload | null { return captured.stored } }
}

test('Local presign 返回代理模式，随后 multipart 上传把完整文件交给存储适配器', async () => {
  const context = fixture(64)
  const form = multipart([
    ['space', 'project'], ['project_id', '9'], ['folder_id', '4'], ['stage_name', '进行中'],
  ])
  try {
    const presign = await context.app.inject({
      method: 'POST', url: '/api/v1/files/presign',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        filename: '资料.txt', size_bytes: 6, mime_type: 'text/plain',
        space: 'project', project_id: 9, folder_id: 4, stage_name: '进行中',
      }),
    })
    assert.equal(presign.statusCode, 200)
    assert.deepEqual(presign.json(), { mode: 'proxy' })
    assert.equal(context.getStored(), null, '预签名只选择传输模式，不写入文件')

    const response = await context.app.inject({
      method: 'POST', url: '/api/v1/files',
      headers: { 'content-type': `multipart/form-data; boundary=${form.boundary}` },
      payload: form.payload,
    })
    assert.equal(response.statusCode, 201)
    assert.deepEqual(response.json(), { id: 12, displayName: '资料.txt' })
    const stored = context.getStored()
    assert.ok(stored)
    assert.equal(stored.ownerId, '11111111-1111-4111-8111-111111111111')
    assert.deepEqual(stored.input, {
      space: 'project', projectId: 9, folderId: 4, workspaceDirectoryId: null,
      stageName: '进行中', mindMapId: null, onConflict: 'keep_both', overwriteFileId: null,
    })
    assert.equal(stored.upload.sizeBytes, Buffer.byteLength('正文'))
    assert.equal(stored.upload.sha256, 'd661c3d96d53ebc0ca8a55aae24b5df4a4d1bf28d37337b982fe8ebf54846eeb')
    assert.equal(stored.content, '正文')
  } finally { await context.app.close() }
})

test('Local presign 在选择代理模式前拒绝不符合 Python 请求字段的内容', async () => {
  const context = fixture()
  try {
    const response = await context.app.inject({
      method: 'POST', url: '/api/v1/files/presign',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ filename: '资料.txt', size_bytes: 'large' }),
    })
    assert.equal(response.statusCode, 422)
    assert.equal(context.getStored(), null)
  } finally { await context.app.close() }
})

test('超过用户剩余配额的文件在提交前被拒绝', async () => {
  const context = fixture(2)
  const form = multipart([['space', 'personal']])
  try {
    const response = await context.app.inject({
      method: 'POST', url: '/api/v1/files',
      headers: { 'content-type': `multipart/form-data; boundary=${form.boundary}` },
      payload: form.payload,
    })
    assert.equal(response.statusCode, 413)
    assert.equal(context.getStored(), null)
  } finally { await context.app.close() }
})

test('上传有效 PNG 时暂存宽高，损坏图片仍以空宽高接受', async () => {
  const context = fixture(1024 * 1024)
  // 1x1 PNG：完整的最小图像，宽高从文件头读取。
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=',
    'base64',
  )
  try {
    const valid = imageMultipart(png)
    const validResponse = await context.app.inject({
      method: 'POST', url: '/api/v1/files',
      headers: { 'content-type': `multipart/form-data; boundary=${valid.boundary}` }, payload: valid.payload,
    })
    assert.equal(validResponse.statusCode, 201)
    assert.equal(context.getStored()?.upload.imgWidth, 1)
    assert.equal(context.getStored()?.upload.imgHeight, 1)

    const malformed = imageMultipart(Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'binary'), Buffer.alloc(128 * 1024)]))
    const malformedResponse = await context.app.inject({
      method: 'POST', url: '/api/v1/files',
      headers: { 'content-type': `multipart/form-data; boundary=${malformed.boundary}` }, payload: malformed.payload,
    })
    assert.equal(malformedResponse.statusCode, 201)
    assert.equal(context.getStored()?.upload.imgWidth, null)
    assert.equal(context.getStored()?.upload.imgHeight, null)

    const svg = imageMultipart(png, 'image/svg+xml')
    const svgResponse = await context.app.inject({
      method: 'POST', url: '/api/v1/files',
      headers: { 'content-type': `multipart/form-data; boundary=${svg.boundary}` }, payload: svg.payload,
    })
    assert.equal(svgResponse.statusCode, 201)
    assert.equal(context.getStored()?.upload.imgWidth, null)
    assert.equal(context.getStored()?.upload.imgHeight, null)
  } finally { await context.app.close() }
})

test('文件后出现字段时拒绝请求，避免表单目标与暂存文件不一致', async () => {
  const context = fixture(64)
  const boundary = 'gugu-upload-test-boundary'
  const payload = [
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="x.txt"\r\nContent-Type: text/plain\r\n\r\nx\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="space"\r\n\r\npersonal\r\n`,
    `--${boundary}--\r\n`,
  ].join('')
  try {
    const response = await context.app.inject({
      method: 'POST', url: '/api/v1/files',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload,
    })
    assert.equal(response.statusCode, 422)
    assert.equal(context.getStored(), null)
  } finally { await context.app.close() }
})
