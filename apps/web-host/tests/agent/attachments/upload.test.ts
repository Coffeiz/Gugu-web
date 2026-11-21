import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import Fastify from 'fastify'
import { createApp } from '../../../src/app.js'
import { installHttpErrorHandler } from '../../../src/http/errors.js'
import { installFileUploadSupport } from '../../../src/modules/files/upload.js'
import { registerAgentAttachmentUploadRoute } from '../../../src/modules/agent/attachments/upload.js'
import { signedUserToken } from '../../helpers/auth.js'

function multipart(filename: string, content: string, voice = false) {
  const boundary = 'gugu-attachment-upload-test'
  const payload = [
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/pdf\r\n\r\n${content}\r\n`,
    ...(voice ? [`--${boundary}\r\nContent-Disposition: form-data; name="voice"\r\n\r\ntrue\r\n`] : []),
    `--${boundary}--\r\n`,
  ].join('')
  return { boundary, payload }
}

test('聊天附件上传保留 Python 文件名、语音字段与响应形状，并把流式字节交给暂存服务', async () => {
  const app = Fastify({ logger: false })
  installHttpErrorHandler(app)
  installFileUploadSupport(app)
  let received: { owner: string; name: string; ext: string; mime: string | null; voice: boolean; content: string } | null = null
  registerAgentAttachmentUploadRoute(app, {
    requireUser: async () => undefined,
    ownerIdFromRequest: () => 'synthetic-owner',
    operations: {
      async capacity() { return 1024 },
      async stage(owner, input) {
        received = { owner, name: input.name, ext: input.ext, mime: input.mime, voice: input.voice, content: await readFile(input.path, 'utf8') }
        return { attach_id: 'attach-1', name: input.name, ext: input.ext.toLowerCase(), size: input.size, kind: 'voice', duration: 1.25, img_width: null, img_height: null, qq_face: null }
      },
    },
  })
  try {
    const form = multipart('录音.WEBM', 'voice-bytes', true)
    const response = await app.inject({ method: 'POST', url: '/api/v1/agent/upload', headers: { 'content-type': `multipart/form-data; boundary=${form.boundary}` }, payload: form.payload })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { attach_id: 'attach-1', name: '录音', ext: 'webm', size: 11, kind: 'voice', duration: 1.25, img_width: null, img_height: null, qq_face: null })
    assert.deepEqual(received, { owner: 'synthetic-owner', name: '录音', ext: 'WEBM', mime: 'application/pdf', voice: true, content: 'voice-bytes' })
  } finally { await app.close() }
})

test('聊天暂存空间剩余容量作为流式请求上限，超出返回 413 且不暂存', async () => {
  const app = Fastify({ logger: false })
  installHttpErrorHandler(app)
  installFileUploadSupport(app)
  let staged = false
  registerAgentAttachmentUploadRoute(app, {
    requireUser: async () => undefined,
    ownerIdFromRequest: () => 'synthetic-owner',
    operations: {
      async capacity() { return 2 },
      async stage() { staged = true; throw new Error('不应调用 stage') },
    },
  })
  try {
    const form = multipart('note.txt', 'three-bytes')
    const response = await app.inject({ method: 'POST', url: '/api/v1/agent/upload', headers: { 'content-type': `multipart/form-data; boundary=${form.boundary}` }, payload: form.payload })
    assert.equal(response.statusCode, 413)
    assert.equal(staged, false)
  } finally { await app.close() }
})

test('生产应用组合入口仅为已认证 owner 注册聊天附件上传路由', async () => {
  const secret = 'synthetic-attachment-secret'
  const owner = 'cfa94a82-62d0-44a3-88bc-8c0cf37e5085'
  const writes: string[] = []
  const app = createApp({
    appName: '附件测试', isReady: async () => true,
    userAuth: { secret, async lookupUser(id) { return {
      id, username: 'moon_example', displayName: null, email: 'moon@example.test', avatarUrl: null,
      createdAt: null, timezone: null, emailSubscribed: false, imChannels: [], isActive: true,
    } } },
    attachmentUpload: { operations: {
      async capacity() { return 1024 },
      async stage(userId, input) { writes.push(userId); return {
        attach_id: 'attach-2', name: input.name, ext: input.ext, size: input.size,
        kind: 'text', duration: null, img_width: null, img_height: null, qq_face: null,
      } },
  } },
  })
  try {
    const form = multipart('note.txt', 'draft')
    const headers = { 'content-type': `multipart/form-data; boundary=${form.boundary}` }
    const anonymous = await app.inject({ method: 'POST', url: '/api/v1/agent/upload', headers, payload: form.payload })
    const response = await app.inject({ method: 'POST', url: '/api/v1/agent/upload', headers: {
      ...headers, authorization: `Bearer ${signedUserToken(secret, owner)}`,
    }, payload: form.payload })
    assert.equal(anonymous.statusCode, 401)
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { attach_id: 'attach-2', name: 'note', ext: 'txt', size: 5, kind: 'text', duration: null, img_width: null, img_height: null, qq_face: null })
    assert.deepEqual(writes, [owner])
  } finally { await app.close() }
})
