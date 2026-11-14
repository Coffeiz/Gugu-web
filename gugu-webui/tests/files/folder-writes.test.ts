import assert from 'node:assert/strict'
import { CoreError } from '@gugu/core'
import Fastify from 'fastify'
import test from 'node:test'
import { installHttpErrorHandler } from '../../src/http/errors.js'
import { registerFolderWriteRoutes } from '../../src/domains/files/folder-writes.js'

const ownerId = '00000000-0000-4000-8000-000000000012'

test('folder create and rename parse the Python camelCase contract and pass trusted owner/metadata', async () => {
  const calls: unknown[] = []
  const app = Fastify()
  installHttpErrorHandler(app)
  registerFolderWriteRoutes(app, {
    requireUser: async () => {},
    ownerIdFromRequest: () => ownerId,
    operations: {
      async create(owner, input, metadata) {
        calls.push(['create', owner, input, metadata])
        return { id: 5, projectId: 7, workspaceDirectoryId: null, parentId: 2, name: '新目录', fileCount: 0, folderCount: 0, version: 1 }
      },
      async rename(owner, id, input, metadata) {
        calls.push(['rename', owner, id, input, metadata])
        return { id, projectId: 7, workspaceDirectoryId: null, parentId: 2, name: input.name, fileCount: 3, folderCount: 1, version: 2 }
      },
      async move(owner, id, input, metadata) {
        calls.push(['move', owner, id, input, metadata])
        return { id, projectId: input.projectId, workspaceDirectoryId: input.workspaceDirectoryId,
          parentId: input.parentId, name: '新目录', fileCount: 0, folderCount: 0, version: input.version + 1 }
      },
    },
  })
  try {
    const created = await app.inject({
      method: 'POST', url: '/api/v1/folders',
      headers: { 'x-undo-context-id': 'ctx-1', 'x-client-id': 'web' },
      payload: { name: ' 新目录 ', projectId: 7, parentId: 2 },
    })
    assert.equal(created.statusCode, 201)
    assert.deepEqual(created.json(), {
      id: 5, projectId: 7, workspaceDirectoryId: null, parentId: 2,
      name: '新目录', fileCount: 0, folderCount: 0, version: 1,
    })
    const renamed = await app.inject({
      method: 'PATCH', url: '/api/v1/folders/5',
      headers: { 'x-undo-context-id': 'ctx-2', 'x-client-id': 'desktop' },
      payload: { name: '重命名', version: 1 },
    })
    assert.equal(renamed.statusCode, 200)
    const moved = await app.inject({
      method: 'PATCH', url: '/api/v1/folders/5/parent',
      headers: { 'x-undo-context-id': 'ctx-3', 'x-client-id': 'web' },
      payload: { parentId: null, projectId: null, version: 2 },
    })
    assert.equal(moved.statusCode, 200)
    assert.deepEqual(moved.json(), {
      id: 5, projectId: null, workspaceDirectoryId: null, parentId: null,
      name: '新目录', fileCount: 0, folderCount: 0, version: 3,
    })
    assert.deepEqual(calls, [
      ['create', ownerId, { name: '新目录', projectId: 7, workspaceDirectoryId: null, parentId: 2 }, { undoContextId: 'ctx-1', origin: 'web' }],
      ['rename', ownerId, 5, { name: '重命名', version: 1 }, { undoContextId: 'ctx-2', origin: 'desktop' }],
      ['move', ownerId, 5, {
        parentId: null, version: 2, projectId: null, projectSet: true,
        workspaceDirectoryId: null, workspaceDirectorySet: false,
      }, { undoContextId: 'ctx-3', origin: 'web' }],
    ])
  } finally {
    await app.close()
  }
})

test('folder writes reject unsafe names, missing CAS versions, and malformed IDs before calling persistence', async () => {
  let calls = 0
  const app = Fastify()
  installHttpErrorHandler(app)
  registerFolderWriteRoutes(app, {
    requireUser: async () => {}, ownerIdFromRequest: () => ownerId,
    operations: {
      async create() { calls += 1; return {} },
      async rename() { calls += 1; return {} },
      async move() { calls += 1; return {} },
    },
  })
  try {
    const unsafe = await app.inject({ method: 'POST', url: '/api/v1/folders', payload: { name: '../escape' } })
    const nulName = await app.inject({ method: 'POST', url: '/api/v1/folders', payload: { name: 'bad\0name' } })
    const missingVersion = await app.inject({ method: 'PATCH', url: '/api/v1/folders/5', payload: { name: 'ok' } })
    const malformedId = await app.inject({ method: 'PATCH', url: '/api/v1/folders/NaN', payload: { name: 'ok', version: 1 } })
    const malformedMoveVersion = await app.inject({ method: 'PATCH', url: '/api/v1/folders/5/parent', payload: { parentId: null } })
    assert.equal(unsafe.statusCode, 422)
    assert.equal(nulName.statusCode, 422)
    assert.equal(missingVersion.statusCode, 422)
    assert.equal(malformedId.statusCode, 422)
    assert.equal(malformedMoveVersion.statusCode, 422)
    assert.equal(calls, 0)
  } finally {
    await app.close()
  }
})

test('folder routes parse signed integer strings and defer nonpositive IDs to persistence', async () => {
  const calls: unknown[] = []
  const app = Fastify()
  installHttpErrorHandler(app)
  registerFolderWriteRoutes(app, {
    requireUser: async () => {},
    ownerIdFromRequest: () => ownerId,
    operations: {
      async create(owner, input) {
        calls.push(['create', owner, input])
        return { id: 8, projectId: 12, workspaceDirectoryId: null, parentId: -3, name: 'signed', fileCount: 0, folderCount: 0, version: 1 }
      },
      async rename(owner, id, input) {
        calls.push(['rename', owner, id, input])
        if (id <= 0) throw new CoreError('not_found', '文件夹不存在')
        return { id, projectId: null, workspaceDirectoryId: null, parentId: null, name: input.name, fileCount: 0, folderCount: 0, version: 2 }
      },
      async move(owner, id, input) {
        calls.push(['move', owner, id, input])
        if (id <= 0) throw new CoreError('not_found', '文件夹不存在')
        return { id, projectId: null, workspaceDirectoryId: null, parentId: input.parentId, name: 'signed', fileCount: 0, folderCount: 0, version: 2 }
      },
    },
  })
  try {
    const created = await app.inject({
      method: 'POST', url: '/api/v1/folders',
      payload: { name: 'signed', projectId: ' +12 ', parentId: '-3', workspaceDirectoryId: null },
    })
    assert.equal(created.statusCode, 201)
    const decimalIntegerCreate = await app.inject({
      method: 'POST', url: '/api/v1/folders',
      payload: { name: 'decimal integer', workspaceDirectoryId: '2.0' },
    })
    assert.equal(decimalIntegerCreate.statusCode, 201)
    const moved = await app.inject({ method: 'PATCH', url: '/api/v1/folders/8/parent',
      payload: { parent_id: ' -3 ', project_id: null, version: '1' } })
    assert.equal(moved.statusCode, 200)
    assert.deepEqual(calls.at(-1), ['move', ownerId, 8, {
      parentId: -3, version: 1, projectId: null, projectSet: true,
      workspaceDirectoryId: null, workspaceDirectorySet: false,
    }])

    const plusId = await app.inject({ method: 'PATCH', url: '/api/v1/folders/+7', payload: { name: 'ok', version: '+2' } })
    assert.equal(plusId.statusCode, 200)
    const decimalIntegerVersion = await app.inject({ method: 'PATCH', url: '/api/v1/folders/8', payload: { name: 'ok', version: '2.0' } })
    assert.equal(decimalIntegerVersion.statusCode, 200)
    const negativeId = await app.inject({ method: 'PATCH', url: '/api/v1/folders/-2', payload: { name: 'ok', version: '-1' } })
    const zeroId = await app.inject({ method: 'PATCH', url: '/api/v1/folders/0', payload: { name: 'ok', version: '1' } })
    assert.equal(negativeId.statusCode, 404)
    assert.equal(zeroId.statusCode, 404)

    const decimalField = await app.inject({ method: 'POST', url: '/api/v1/folders', payload: { name: 'bad', projectId: '1.5' } })
    const decimalVersion = await app.inject({ method: 'PATCH', url: '/api/v1/folders/7', payload: { name: 'bad', version: '1.5' } })
    const decimalId = await app.inject({ method: 'PATCH', url: '/api/v1/folders/7.5', payload: { name: 'bad', version: 1 } })
    assert.equal(decimalField.statusCode, 422)
    assert.equal(decimalVersion.statusCode, 422)
    assert.equal(decimalId.statusCode, 422)
    assert.deepEqual(calls, [
      ['create', ownerId, { name: 'signed', projectId: 12, workspaceDirectoryId: null, parentId: -3 }],
      ['create', ownerId, { name: 'decimal integer', projectId: null, workspaceDirectoryId: 2, parentId: null }],
      ['move', ownerId, 8, {
        parentId: -3, version: 1, projectId: null, projectSet: true,
        workspaceDirectoryId: null, workspaceDirectorySet: false,
      }],
      ['rename', ownerId, 7, { name: 'ok', version: 2 }],
      ['rename', ownerId, 8, { name: 'ok', version: 2 }],
      ['rename', ownerId, -2, { name: 'ok', version: -1 }],
      ['rename', ownerId, 0, { name: 'ok', version: 1 }],
    ])
  } finally {
    await app.close()
  }
})
