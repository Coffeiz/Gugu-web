import assert from 'node:assert/strict'
import Fastify from 'fastify'
import test from 'node:test'
import { registerFileRestoreRoutes } from '../../src/domains/files/file-restore.js'
import { installHttpErrorHandler } from '../../src/http/errors.js'

test('文件恢复路由传递 Host owner 与变化来源并保持 204 响应', async () => {
  const app = Fastify()
  installHttpErrorHandler(app)
  const calls: unknown[][] = []
  registerFileRestoreRoutes(app, {
    requireUser: async () => {},
    ownerIdFromRequest: () => '11111111-1111-4111-8111-111111111111',
    operations: { async restore(...args) { calls.push(args) } },
  })
  try {
    const response = await app.inject({ method: 'POST', url: '/api/v1/trash/7/restore', headers: { 'x-client-id': 'synthetic-client' } })
    assert.equal(response.statusCode, 204)
    assert.equal(response.body, '')
    assert.deepEqual(calls, [['11111111-1111-4111-8111-111111111111', 7, 'synthetic-client']])
  } finally { await app.close() }
})

test('文件恢复路由拒绝无效 ID 且不触发存储操作', async () => {
  const app = Fastify()
  installHttpErrorHandler(app)
  let calls = 0
  registerFileRestoreRoutes(app, {
    requireUser: async () => {},
    ownerIdFromRequest: () => '11111111-1111-4111-8111-111111111111',
    operations: { async restore() { calls++ } },
  })
  try {
    const response = await app.inject({ method: 'POST', url: '/api/v1/trash/0/restore' })
    assert.equal(response.statusCode, 422)
    assert.equal(calls, 0)
  } finally { await app.close() }
})
