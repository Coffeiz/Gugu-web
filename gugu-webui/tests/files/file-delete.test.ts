import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import { registerFileDeleteRoutes } from '../../src/domains/files/file-delete.js'
import { installHttpErrorHandler } from '../../src/http/errors.js'

test('文件删除使用 Host owner 和撤销上下文，并保留 204 响应', async () => {
  const app = Fastify({ logger: false })
  installHttpErrorHandler(app)
  const calls: unknown[][] = []
  registerFileDeleteRoutes(app, {
    requireUser: async () => undefined,
    ownerIdFromRequest: () => '11111111-1111-4111-8111-111111111111',
    operations: {
      async remove(...args) { calls.push(args) },
    },
  })
  try {
    const response = await app.inject({
      method: 'DELETE', url: '/api/v1/files/7',
      headers: { 'x-undo-context-id': 'undo-context', 'x-client-id': 'renderer' },
    })
    assert.equal(response.statusCode, 204)
    assert.equal(response.body, '')
    assert.deepEqual(calls, [[
      '11111111-1111-4111-8111-111111111111', 7, 'undo-context', 'renderer',
    ]])
  } finally { await app.close() }
})

test('文件删除拒绝无法解析的 ID，且不触发存储写入', async () => {
  const app = Fastify({ logger: false })
  installHttpErrorHandler(app)
  let calls = 0
  registerFileDeleteRoutes(app, {
    requireUser: async () => undefined,
    ownerIdFromRequest: () => '11111111-1111-4111-8111-111111111111',
    operations: { async remove() { calls++ } },
  })
  try {
    const response = await app.inject({ method: 'DELETE', url: '/api/v1/files/not-an-id' })
    assert.equal(response.statusCode, 422)
    assert.equal(calls, 0)
  } finally { await app.close() }
})

test('批量文件删除使用 Host owner 和请求元数据并返回 204', async () => {
  const app = Fastify({ logger: false })
  installHttpErrorHandler(app)
  const calls: unknown[][] = []
  registerFileDeleteRoutes(app, {
    requireUser: async () => undefined,
    ownerIdFromRequest: () => '11111111-1111-4111-8111-111111111111',
    operations: {
      async remove() {},
      async removeMany(...args) { calls.push(args) },
    },
  })
  try {
    const response = await app.inject({
      method: 'POST', url: '/api/v1/files/batch-delete',
      headers: { 'x-undo-context-id': 'batch-context', 'x-client-id': 'renderer' },
      payload: { ids: [7, 8] },
    })
    const empty = await app.inject({ method: 'POST', url: '/api/v1/files/batch-delete', payload: { ids: [] } })
    const invalid = await app.inject({ method: 'POST', url: '/api/v1/files/batch-delete', payload: { ids: [1, 'bad'] } })
    assert.equal(response.statusCode, 204)
    assert.equal(empty.statusCode, 204)
    assert.equal(invalid.statusCode, 422)
    assert.deepEqual(calls, [
      ['11111111-1111-4111-8111-111111111111', [7, 8], 'batch-context', 'renderer'],
      ['11111111-1111-4111-8111-111111111111', [], null, null],
    ])
  } finally { await app.close() }
})
