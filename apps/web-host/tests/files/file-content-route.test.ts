import assert from 'node:assert/strict'
import Fastify from 'fastify'
import test from 'node:test'
import { registerFileContentRoutes } from '../../src/domains/files/file-content.js'
import { installHttpErrorHandler } from '../../src/http/errors.js'

test('正文写入路由验证正文与版本、传递撤销上下文，并允许完整的 1 MiB 正文', async () => {
  const app = Fastify()
  installHttpErrorHandler(app)
  const calls: unknown[][] = []
  registerFileContentRoutes(app, {
    requireUser: async () => {},
    ownerIdFromRequest: () => '11111111-1111-4111-8111-111111111111',
    operations: {
      async update(...args) { calls.push(args); return { id: 9, version: 3 } },
    },
  })
  try {
    const invalid = await app.inject({ method: 'PUT', url: '/api/v1/files/9/content', payload: { content: 7, version: 2 } })
    assert.equal(invalid.statusCode, 422)
    const response = await app.inject({
      method: 'PUT', url: '/api/v1/files/9/content',
      headers: { 'x-undo-context-id': 'editor-tab', 'x-client-id': 'renderer' },
      payload: { content: '新正文', version: 2 },
    })
    assert.equal(response.statusCode, 200)
    assert.equal(response.json().version, 3)
    assert.equal(calls.length, 1)
    assert.equal(calls[0]![0], '11111111-1111-4111-8111-111111111111')
    assert.equal(calls[0]![1], 9)
    assert.equal(calls[0]![2], '新正文')
    assert.equal(calls[0]![3], 2)
    assert.equal((calls[0]![4] as { undoContextId: string }).undoContextId, 'editor-tab')

    const maxContent = 'x'.repeat(1024 * 1024)
    const maxSize = await app.inject({
      method: 'PUT', url: '/api/v1/files/9/content', payload: { content: maxContent, version: 3 },
    })
    assert.equal(maxSize.statusCode, 200)
    assert.equal(calls.length, 2)
    assert.equal(calls[1]![2], maxContent)
  } finally { await app.close() }
})
