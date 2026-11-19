import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import { CoreError } from '@gugu/core'
import { installHttpErrorHandler } from '../../src/http/errors.js'
import { createWorkspaceFileReads } from '../../src/modules/workspaces/files.js'
import { installFileUploadSupport } from '../../src/modules/files/upload.js'
import {
  registerWorkspaceDirectoryRoutes,
  type WorkspaceDirectoryOperations,
} from '../../src/modules/workspaces/routes.js'

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
  installFileUploadSupport(app)
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

for (const [name, storagePath, url] of [
  ['默认工作区', 'workspace/default', '/api/v1/workspace-directories/7'],
  ['个人文件', '个人文件', '/api/v1/files/personal'],
  ['项目文件', '项目文件/2026/01/设计 #9', '/api/v1/files/projects/9'],
]) {
  test(`${name}直接读写磁盘，隔离其他用户、保留已有文件和拒绝越界`, {
    skip: process.platform !== 'linux',
  }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'gugu-workspace-files-'))
    const otherOwner = '9e51a4bf-07e1-4db8-9050-54a8c7356e8e'
    const workspace = join(root, ownerId, storagePath)
    const otherWorkspace = join(root, otherOwner, storagePath)
    const ctx = setup({ files: createWorkspaceFileReads({
      async query(sql: string, args: unknown[]) {
        if (sql.startsWith('SELECT 1 FROM files')) {
          assert.equal(args[0], ownerId)
          return { rows: Array.isArray(args[1]) && args[1].includes(`${ownerId}/${storagePath}/legacy.txt`) ? [{}] : [] }
        }
        assert.equal(args[1], ownerId)
        if (name === '项目文件') {
          assert.match(sql, /FROM projects/)
          return { rows: args[0] === 9 ? [{ name: '设计', start_date: '2026-01-04', created_at: '2026-01-04' }] : [] }
        }
        return { rows: args[0] === 7 ? [{ directory_name: 'default' }] : [] }
      },
    } as unknown as Parameters<typeof createWorkspaceFileReads>[0], root) })
    const request = (path: string, headers = {}) =>
      ctx.app.inject({ url: path, headers: { authorization: 'user', ...headers } })
    try {
      if (name !== '默认工作区') {
        assert.equal((await ctx.app.inject({ url: `${url}/entries` })).statusCode, 401)
        assert.deepEqual((await request(`${url}/entries`)).json(), [])
        const folder = await ctx.app.inject({ method: 'POST', url: `${url}/folders?path=docs`, headers: { authorization: 'user' } })
        assert.equal(folder.statusCode, 201)
      } else {
        await mkdir(join(workspace, 'docs'), { recursive: true })
      }
      await mkdir(otherWorkspace, { recursive: true })
      await writeFile(join(workspace, 'docs/t.txt'), 'line1\nline2\n')
      await writeFile(join(otherWorkspace, 'private.txt'), 'private')
      await symlink(otherWorkspace, join(workspace, 'other'))
      const listing = await request(`${url}/entries`)
      assert.equal(listing.statusCode, 200)
      assert.deepEqual(listing.json().map((entry: { name: string }) => entry.name), ['docs'])
      const file = await request(`${url}/content?path=docs%2Ft.txt&download=1`)
      assert.equal(file.statusCode, 200)
      assert.equal(file.body, 'line1\nline2\n')
      assert.match(String(file.headers['content-disposition']), /^attachment/)
      const range = await request(`${url}/content?path=docs%2Ft.txt`, { range: 'bytes=0-4' })
      assert.equal(range.statusCode, 206)
      assert.equal(range.body, 'line1')
      if (name === '默认工作区') assert.equal((await request('/api/v1/workspace-directories/8/entries')).statusCode, 404)
      if (name === '项目文件') {
        await mkdir(join(root, ownerId, '项目文件/2026/01/其他项目 #10'), { recursive: true })
        assert.equal((await request('/api/v1/files/projects/10/entries')).statusCode, 404)
        assert.equal((await request('/api/v1/files/projects/10/content?path=docs/t.txt')).statusCode, 404)
      }
      assert.equal((await request(`${url}/content?path=..%2Fprivate.txt`)).statusCode, 404)
      assert.equal((await request(`${url}/content?path=other%2Fprivate.txt`)).statusCode, 404)
      assert.equal((await request(`${url}/entries?path=other`)).statusCode, 404)

      const mutation = (method: 'POST' | 'PATCH', path: string, payload?: Record<string, unknown>) =>
        ctx.app.inject({ method, url: path, headers: { authorization: 'user' }, payload })
      if (name !== '默认工作区') {
        await writeFile(join(workspace, 'legacy.txt'), '旧文件')
        assert.equal((await mutation('PATCH', `${url}/entries?path=legacy.txt`, { destination: 'renamed.txt' })).statusCode, 409)
        assert.equal((await request(`${url}/content?path=legacy.txt`)).body, '旧文件')
      }
      assert.equal((await mutation('POST', `${url}/folders?path=target`)).statusCode, 201)
      assert.equal((await mutation('POST', `${url}/folders?path=target`)).statusCode, 409)
      const form = new FormData()
      form.append('file', new Blob(['uploaded bytes']), 'upload.txt')
      const body = new Request('http://localhost', { method: 'POST', body: form })
      const upload = await ctx.app.inject({ method: 'POST', url: `${url}/content?path=upload.txt`,
        headers: { authorization: 'user', 'content-type': body.headers.get('content-type')! },
        payload: Buffer.from(await body.arrayBuffer()),
      })
      assert.equal(upload.statusCode, 201)
      assert.equal((await mutation('PATCH', `${url}/entries?path=upload.txt`, { destination: 'renamed.txt' })).statusCode, 200)
      assert.equal((await mutation('PATCH', `${url}/entries?path=renamed.txt`, { destination: 'target/t.txt' })).statusCode, 200)
      assert.equal((await mutation('PATCH', `${url}/entries?path=docs/t.txt`, { destination: 'target/t.txt' })).statusCode, 409)
      assert.equal((await mutation('PATCH', `${url}/entries?path=docs/t.txt`, { destination: 'other/private.txt' })).statusCode, 404)
      assert.equal((await mutation('PATCH', `${url}/entries?path=docs/t.txt`, { destination: '../outside.txt' })).statusCode, 404)
      assert.equal((await mutation('PATCH', `${url}/entries?path=target`, { destination: 'target/subfolder' })).statusCode, 422)
      assert.equal((await request(`${url}/content?path=target/t.txt`)).body, 'uploaded bytes')
      assert.equal((await request(`${url}/content?path=docs/t.txt`)).body, 'line1\nline2\n')
      const copy = await mutation('POST', `${url}/copy?path=docs`, { destination: 'docs-copy' })
      assert.equal(copy.statusCode, 200)
      assert.equal((await request(`${url}/content?path=docs-copy/t.txt`)).body, 'line1\nline2\n')
      assert.equal((await mutation('POST', `${url}/copy?path=docs`, { destination: 'docs-copy' })).statusCode, 409)
      const remove = await ctx.app.inject({ method: 'DELETE', url: `${url}/entries?path=docs-copy`, headers: { authorization: 'user' } })
      assert.equal(remove.statusCode, 200)
      assert.equal((await request(`${url}/entries?path=docs-copy`)).statusCode, 404)
      const deleted = (await request('/api/v1/files/disk-trash')).json()
      assert.equal(deleted.length, 1)
      assert.deepEqual([deleted[0].name, deleted[0].kind], ['docs-copy', 'directory'])
      const restoreUrl = `/api/v1/files/disk-trash/${deleted[0].id}/restore`
      assert.equal((await mutation('POST', `${url}/folders?path=docs-copy`)).statusCode, 201)
      assert.equal((await mutation('POST', restoreUrl)).statusCode, 409)
      assert.equal((await request('/api/v1/files/disk-trash')).json().length, 1)
      assert.equal((await ctx.app.inject({ method: 'DELETE', url: `${url}/entries?path=docs-copy`, headers: { authorization: 'user' } })).statusCode, 200)
      assert.equal((await mutation('POST', restoreUrl)).statusCode, 200)
      assert.equal((await request(`${url}/content?path=docs-copy/t.txt`)).body, 'line1\nline2\n')
      assert.equal((await request('/api/v1/files/disk-trash')).json().length, 1)
      const remaining = (await request('/api/v1/files/disk-trash')).json()[0]
      assert.equal((await ctx.app.inject({ method: 'DELETE', url: `/api/v1/files/disk-trash/${remaining.id}`, headers: { authorization: 'user' } })).statusCode, 200)
      assert.equal((await request('/api/v1/files/disk-trash')).json().length, 0)

    } finally {
      await ctx.close()
      await rm(root, { recursive: true, force: true })
    }
  })
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
