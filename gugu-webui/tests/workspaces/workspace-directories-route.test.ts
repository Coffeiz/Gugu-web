import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import { CoreError } from '@gugu/core'
import { installHttpErrorHandler } from '../../src/http/errors.js'
import {
  registerWorkspaceDirectoryRoutes,
  type WorkspaceDirectoryOperations,
} from '../../src/domains/workspaces/workspace-directories.js'

const ownerId = '9e51a4bf-07e1-4db8-9050-54a8c7356e8d'
const row = {
  id: 7,
  name: '数据分析',
  directory_name: 'workspace-7',
  is_default: false,
  is_system: false,
  file_count: 2,
  folder_count: 1,
  bound_session_count: 3,
  bound_task_count: 1,
}
const rowResponse = {
  id: 7,
  name: '数据分析',
  directoryName: 'workspace-7',
  isDefault: false,
  isSystem: false,
  fileCount: 2,
  folderCount: 1,
  boundSessionCount: 3,
  boundTaskCount: 1,
}

function setup(overrides: Partial<WorkspaceDirectoryOperations> = {}) {
  const calls: unknown[][] = []
  const app = Fastify({ logger: false })
  installHttpErrorHandler(app)
  const operations: WorkspaceDirectoryOperations = {
    list: async (id) => { calls.push(['list', id]); return [row] },
    create: async (id, name) => { calls.push(['create', id, name]); return row },
    update: async (id, directoryId, name) => { calls.push(['update', id, directoryId, name]); return row },
    previewDelete: async (id, directoryId) => { calls.push(['previewDelete', id, directoryId]); return row },
    delete: async (id, directoryId) => { calls.push(['delete', id, directoryId]); return { ok: true, workspaceDirectoryId: directoryId } },
    ...overrides,
  }
  registerWorkspaceDirectoryRoutes(app, {
    requireUser: async (request, reply) => {
      if (request.headers.authorization !== 'user') return reply.code(401).send({ detail: '未提供认证凭据' })
    },
    ownerIdFromRequest: () => ownerId,
    operations,
  })
  return { app, calls, close: () => app.close() }
}

test('未认证的 Workspace Directory 请求在访问用户身份和数据前被拒绝', async () => {
  const ctx = setup()
  try {
    const response = await ctx.app.inject({ url: '/api/v1/workspace-directories' })
    assert.equal(response.statusCode, 401)
    assert.deepEqual(ctx.calls, [])
  } finally { await ctx.close() }
})

test('GET 返回当前用户可见目录卡片，并只用认证上下文确定 owner', async () => {
  const ctx = setup()
  try {
    const response = await ctx.app.inject({
      url: '/api/v1/workspace-directories',
      headers: { authorization: 'user' },
    })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), [rowResponse])
    assert.deepEqual(ctx.calls, [['list', ownerId]])
  } finally { await ctx.close() }
})

test('POST 校验名称、返回 201，并将有效名称交给归属化创建操作', async () => {
  const ctx = setup()
  try {
    const created = await ctx.app.inject({
      method: 'POST', url: '/api/v1/workspace-directories',
      headers: { authorization: 'user' }, payload: { name: '  数据分析  ' },
    })
    assert.equal(created.statusCode, 201)
    assert.deepEqual(created.json(), rowResponse)
    assert.deepEqual(ctx.calls, [['create', ownerId, '数据分析']])

    const invalid = await ctx.app.inject({
      method: 'POST', url: '/api/v1/workspace-directories',
      headers: { authorization: 'user' }, payload: { name: '   ' },
    })
    assert.equal(invalid.statusCode, 422)
    assert.equal(ctx.calls.length, 1)
  } finally { await ctx.close() }
})

test('PATCH 只接受合法正整数 id，将用户和名称传给更新操作并映射冲突', async () => {
  const updateCalls: unknown[][] = []
  const ctx = setup({
    update: async (id, directoryId, name) => {
      updateCalls.push([id, directoryId, name])
      throw new CoreError('conflict', '默认 Workspace 不可重命名')
    },
  })
  try {
    const invalidId = await ctx.app.inject({
      method: 'PATCH', url: '/api/v1/workspace-directories/not-an-id',
      headers: { authorization: 'user' }, payload: { name: '新名称' },
    })
    assert.equal(invalidId.statusCode, 422)
    assert.deepEqual(ctx.calls, [])

    const conflict = await ctx.app.inject({
      method: 'PATCH', url: '/api/v1/workspace-directories/7',
      headers: { authorization: 'user' }, payload: { name: '新名称' },
    })
    assert.equal(conflict.statusCode, 409)
    assert.deepEqual(updateCalls, [[ownerId, 7, '新名称']])
  } finally { await ctx.close() }
})

test('删除预览返回影响计数，默认目录删除返回 409', async () => {
  const ctx = setup({
    previewDelete: async (id, directoryId) => { ctxCalls.push(['previewDelete', id, directoryId]); return row },
    delete: async () => { throw new CoreError('conflict', '默认 Workspace 不可删除') },
  })
  const ctxCalls = ctx.calls
  try {
    const preview = await ctx.app.inject({
      url: '/api/v1/workspace-directories/7/delete-preview',
      headers: { authorization: 'user' },
    })
    assert.equal(preview.statusCode, 200)
    assert.equal(preview.json().bound_task_count, 1)

    const deleted = await ctx.app.inject({
      method: 'DELETE', url: '/api/v1/workspace-directories/7',
      headers: { authorization: 'user' },
    })
    assert.equal(deleted.statusCode, 409)
    assert.deepEqual(ctx.calls, [['previewDelete', ownerId, 7]])
  } finally { await ctx.close() }
})

test('越权或已删除的目录沿用不存在语义，不泄漏其他用户数据', async () => {
  const ctx = setup({
    previewDelete: async () => { throw new CoreError('not_found', 'Workspace 不存在') },
    update: async () => { throw new CoreError('not_found', 'Workspace 不存在') },
  })
  try {
    const preview = await ctx.app.inject({
      url: '/api/v1/workspace-directories/19/delete-preview',
      headers: { authorization: 'user' },
    })
    assert.equal(preview.statusCode, 404)
    assert.deepEqual(preview.json(), { detail: 'Workspace 不存在' })

    const update = await ctx.app.inject({
      method: 'PATCH', url: '/api/v1/workspace-directories/19',
      headers: { authorization: 'user' }, payload: { name: '尝试改名' },
    })
    assert.equal(update.statusCode, 404)
  } finally { await ctx.close() }
})
