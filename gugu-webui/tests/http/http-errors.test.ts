import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import { CoreError } from '@gugu/core'
import { installHttpErrorHandler } from '../../src/http/errors.js'

test('未捕获 CoreError 保持 Python API 的 detail 形状和领域状态码', async () => {
  const app = Fastify()
  installHttpErrorHandler(app)
  app.get('/missing', async () => {
    throw new CoreError('not_found', '项目不存在')
  })
  app.post('/invalid', async () => {
    throw new CoreError('invalid_request', '名称不能为空')
  })
  app.post('/conflict', async () => {
    throw new CoreError('conflict', '版本冲突')
  })

  try {
    for (const [url, statusCode, detail] of [
      ['/missing', 404, '项目不存在'],
      ['/invalid', 422, '名称不能为空'],
      ['/conflict', 409, '版本冲突'],
    ] as const) {
      const response = await app.inject({ method: url === '/missing' ? 'GET' : 'POST', url })
      assert.equal(response.statusCode, statusCode)
      assert.deepEqual(response.json(), { detail })
    }
  } finally {
    await app.close()
  }
})

test('内部 CoreError 不泄露异常消息，并返回 Python 风格的 500 detail', async () => {
  const app = Fastify()
  installHttpErrorHandler(app)
  app.get('/internal', async () => {
    throw new CoreError('storage_error', 'postgres://secret-host/private-db')
  })

  try {
    const response = await app.inject({ method: 'GET', url: '/internal' })
    assert.equal(response.statusCode, 500)
    assert.deepEqual(response.json(), { detail: '服务器内部错误，请稍后重试' })
    assert.doesNotMatch(response.body, /secret-host|private-db/)
  } finally {
    await app.close()
  }
})

test('schema 校验错误统一成 422 detail，其他可见 HTTP 错误保留状态与 detail', async () => {
  const app = Fastify()
  installHttpErrorHandler(app)
  app.post('/schema', {
    schema: { body: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } },
  }, async () => ({ ok: true }))
  app.get('/legacy', async () => {
    const error = new Error('业务拒绝') as Error & { statusCode: number }
    error.statusCode = 403
    throw error
  })

  try {
    const invalid = await app.inject({ method: 'POST', url: '/schema', payload: {} })
    assert.equal(invalid.statusCode, 422)
    assert.equal(typeof invalid.json().detail, 'string')

    const legacy = await app.inject({ method: 'GET', url: '/legacy' })
    assert.equal(legacy.statusCode, 403)
    assert.deepEqual(legacy.json(), { detail: '业务拒绝' })
  } finally {
    await app.close()
  }
})
