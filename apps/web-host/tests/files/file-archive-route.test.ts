import assert from 'node:assert/strict'
import Fastify from 'fastify'
import test from 'node:test'
import { installHttpErrorHandler } from '../../src/http/errors.js'
import { registerFileArchiveRoutes } from '../../src/domains/files/file-archive.js'

const ownerId = '00000000-0000-4000-8000-000000000091'

function setup(operations: Parameters<typeof registerFileArchiveRoutes>[1]['operations']) {
  const app = Fastify({ logger: false })
  installHttpErrorHandler(app)
  registerFileArchiveRoutes(app, {
    requireUser: async (request, reply) => {
      if (request.headers.authorization !== 'Bearer synthetic-user')
        return reply.code(401).send({ detail: 'Not authenticated' })
    },
    ownerIdFromRequest: () => ownerId,
    operations,
  })
  return app
}

test('归档路由要求认证并保留省略目标与显式个人根的区别', async () => {
  const calls: unknown[][] = []
  const app = setup({
    async archive(...args) { calls.push(args); return { id: 12, displayName: '归档' } },
    async unarchive(...args) { calls.push(args); return { created_count: 0 } },
  })
  try {
    const denied = await app.inject({ method: 'POST', url: '/api/v1/files/archive', payload: { fileIds: [4] } })
    const sourceDefault = await app.inject({
      method: 'POST', url: '/api/v1/files/archive',
      headers: { authorization: 'Bearer synthetic-user', 'x-client-id': ' renderer ' },
      payload: { fileIds: [4], folderIds: [9], name: '材料' },
    })
    const personalRoot = await app.inject({
      method: 'POST', url: '/api/v1/files/archive',
      headers: { authorization: 'Bearer synthetic-user' },
      payload: { fileIds: [], folderIds: [9], folderId: null },
    })

    assert.equal(denied.statusCode, 401)
    assert.equal(sourceDefault.statusCode, 201)
    assert.deepEqual(sourceDefault.json(), { id: 12, displayName: '归档' })
    assert.equal(personalRoot.statusCode, 201)
    assert.deepEqual(calls, [
      [ownerId, { fileIds: [4], folderIds: [9], folderId: undefined, name: '材料' },
        { idempotencyKey: null, undoContextId: null, clientId: 'renderer' }],
      [ownerId, { fileIds: [], folderIds: [9], folderId: null, name: undefined },
        { idempotencyKey: null, undoContextId: null, clientId: null }],
    ])
  } finally {
    await app.close()
  }
})

test('解压路由接受 Python camelCase 契约并拒绝无效文件 ID', async () => {
  const calls: unknown[][] = []
  const app = setup({
    async archive() { return {} },
    async unarchive(...args) { calls.push(args); return { created_count: 1, file_ids: [20], folder_ids: [] } },
  })
  try {
    const response = await app.inject({
      method: 'POST', url: '/api/v1/files/unarchive',
      headers: { authorization: 'Bearer synthetic-user' },
      payload: { fileId: 3, folderId: null, folderName: '展开结果', format: 'zip' },
    })
    const invalid = await app.inject({
      method: 'POST', url: '/api/v1/files/unarchive',
      headers: { authorization: 'Bearer synthetic-user' }, payload: { fileId: 0 },
    })

    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { created_count: 1, file_ids: [20], folder_ids: [] })
    assert.deepEqual(calls, [[ownerId, { fileId: 3, folderId: null, folderName: '展开结果', format: 'zip' },
      { idempotencyKey: null, undoContextId: null, clientId: null }]])
    assert.equal(invalid.statusCode, 422)
  } finally {
    await app.close()
  }
})
