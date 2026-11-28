import assert from 'node:assert/strict'
import { readFile, rm } from 'node:fs/promises'
import { CoreError } from '@gugu/core'
import test from 'node:test'
import Fastify from 'fastify'
import { installHttpErrorHandler } from '../../../src/http/errors.js'
import {
  installFileUploadSupport,
  registerFileUploadRoutes,
  type FileUploadInput,
  type StagedUpload,
} from '../../../src/modules/files/upload.js'

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

function fixture() {
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
      async validateUploadTarget() {},
      async store(ownerId, upload) {
        captured.stored = { upload, input: upload.input, ownerId, content: await readFile(upload.path, 'utf8') }
        return { filePath: '11111111-1111-4111-8111-111111111111/个人文件/资料.txt', displayName: upload.originalName }
      },
    },
  })
  return { app, getStored(): StoredUpload | null { return captured.stored } }
}

test('multipart 上传把完整文件交给存储适配器', async () => {
  const context = fixture()
  const form = multipart([
    ['space', 'project'], ['project_id', '9'], ['stage_name', '进行中'],
  ])
  try {
    const response = await context.app.inject({
      method: 'POST', url: '/api/v1/files',
      headers: { 'content-type': `multipart/form-data; boundary=${form.boundary}` },
      payload: form.payload,
    })
    assert.equal(response.statusCode, 201)
    assert.deepEqual(response.json(), { filePath: '11111111-1111-4111-8111-111111111111/个人文件/资料.txt', displayName: '资料.txt' })
    const stored = context.getStored()
    assert.ok(stored)
    assert.equal(stored.ownerId, '11111111-1111-4111-8111-111111111111')
    assert.deepEqual(stored.input, {
      space: 'project', projectId: 9, workspaceDirectoryId: null,
      stageName: '进行中', mindMapId: null, onConflict: 'keep_both', overwriteFilePath: null,
    })
    assert.equal(stored.upload.sizeBytes, Buffer.byteLength('正文'))
    assert.equal(stored.upload.sha256, 'd661c3d96d53ebc0ca8a55aae24b5df4a4d1bf28d37337b982fe8ebf54846eeb')
    assert.equal(stored.content, '正文')
  } finally { await context.app.close() }
})

test('旧的上传预签名入口已退役', async () => {
  const context = fixture()
  try {
    const response = await context.app.inject({
      method: 'POST', url: '/api/v1/files/presign',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ filename: '资料.txt', size_bytes: 'large' }),
    })
    assert.equal(response.statusCode, 404)
    assert.equal(context.getStored(), null)
  } finally { await context.app.close() }
})

test('上传有效 PNG 时暂存宽高，损坏图片仍以空宽高接受', async () => {
  const context = fixture()
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
  const context = fixture()
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

test('上传临时目录清理失败不覆盖提交成功响应或业务错误', async () => {
  const app=Fastify({logger:false});installHttpErrorHandler(app);installFileUploadSupport(app)
  let shouldFail=false,cleanupCalls=0
  registerFileUploadRoutes(app,{
    requireUser:async()=>undefined,ownerIdFromRequest:()=> 'synthetic',
    operations:{async validateUploadTarget(){},async store(){if(shouldFail)throw new CoreError('conflict','合成版本冲突');return {id:7}}},
    async cleanupTemp(directory){cleanupCalls++;await rm(directory,{recursive:true,force:true});throw new Error('合成含敏感路径的原始错误')},
  })
  try {
    const form=multipart([['space','personal']])
    const send=()=>app.inject({method:'POST',url:'/api/v1/files',headers:{'content-type':`multipart/form-data; boundary=${form.boundary}`},payload:form.payload})
    const success=await send();assert.equal(success.statusCode,201);assert.deepEqual(success.json(),{id:7})
    shouldFail=true;const failure=await send();assert.equal(failure.statusCode,409);assert.equal(failure.json().detail,'合成版本冲突')
    assert.equal(cleanupCalls,2)
  } finally {await app.close()}
})
