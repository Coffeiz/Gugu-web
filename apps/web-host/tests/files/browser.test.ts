import assert from 'node:assert/strict'
import Fastify from 'fastify'
import test from 'node:test'
import { CoreError } from '@gugu/core'
import { installHttpErrorHandler } from '../../src/http/errors.js'
import { registerFileBrowserRoutes } from '../../src/domains/files/browser.js'

const ownerId = '9e51a4bf-07e1-4db8-9050-54a8c7356e8d'

test('文件库路由要求用户身份并将分页过滤传给领域操作', async () => {
  const received: unknown[] = []
  const app = Fastify()
  installHttpErrorHandler(app)
  registerFileBrowserRoutes(app, {
    requireUser: async (request) => {
      if (request.headers.authorization !== 'Bearer test') throw new CoreError('not_found', '用户不存在')
    },
    ownerIdFromRequest: () => ownerId,
    operations: {
      async listFiles(user, query) { received.push(['files', user, query]); return { items: [], has_more: false, next_cursor: null } },
      async listFolders(user, query) { received.push(['folders', user, query]); return { items: [], has_more: false, next_cursor: null } },
    },
  })
  try {
    const unauthorized = await app.inject({ method: 'GET', url: '/api/v1/files?space=personal' })
    assert.equal(unauthorized.statusCode, 404)
    const invalidLimit = await app.inject({ method: 'GET', url: '/api/v1/files?space=personal&limit=201', headers: { authorization: 'Bearer test' } })
    assert.equal(invalidLimit.statusCode, 422)
    const invalidSort = await app.inject({ method: 'GET', url: '/api/v1/folders?sort_order=sideways', headers: { authorization: 'Bearer test' } })
    assert.equal(invalidSort.statusCode, 422)
    const files = await app.inject({
      method: 'GET', url: '/api/v1/files?space=workspace&workspace_directory_id=4&folder_id=8&ext=pdf&q=计划&limit=1&sort_by=name&sort_order=asc',
      headers: { authorization: 'Bearer test' },
    })
    assert.equal(files.statusCode, 200)
    const folders = await app.inject({ method: 'GET', url: '/api/v1/folders?workspace_directory_id=4&parent_id=8&limit=2', headers: { authorization: 'Bearer test' } })
    assert.equal(folders.statusCode, 200)
    assert.equal(received.length, 2)
    assert.deepEqual(received[0], ['files', ownerId, {
      limit: 1, cursor: null, sortBy: 'name', sortOrder: 'asc', space: 'workspace', projectId: null,
      folderId: 8, workspaceDirectoryId: 4, mindMapId: null, ext: 'pdf', q: '计划',
    }])
    assert.deepEqual(received[1], ['folders', ownerId, {
      limit: 2, cursor: null, sortBy: 'createdAt', sortOrder: 'desc', projectId: null,
      workspaceDirectoryId: 4, parentId: 8,
    }])
  } finally {
    await app.close()
  }
})

test('文件分页整数参数接受 Python int 兼容的显式正号', async () => {
  let receivedProjectId: number | null = null
  const app = Fastify()
  installHttpErrorHandler(app)
  registerFileBrowserRoutes(app, {
    requireUser: async () => {},
    ownerIdFromRequest: () => ownerId,
    operations: {
      async listFiles(_user, query) {
        receivedProjectId = query.projectId
        return { items: [], has_more: false, next_cursor: null }
      },
      async listFolders() { return { items: [], has_more: false, next_cursor: null } },
    },
  })
  try {
    const response = await app.inject({ method: 'GET', url: '/api/v1/files?space=project&project_id=%2B17' })
    assert.equal(response.statusCode, 200)
    assert.equal(receivedProjectId, 17)
  } finally {
    await app.close()
  }
})
