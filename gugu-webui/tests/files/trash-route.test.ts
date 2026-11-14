import assert from 'node:assert/strict'
import Fastify from 'fastify'
import test from 'node:test'
import { registerTrashRoutes, TrashCooldownError, type TrashOperations, type TrashPurgeJob } from '../../src/domains/files/trash.js'
import { installHttpErrorHandler } from '../../src/http/errors.js'

const ownerId = '11111111-1111-4111-8111-111111111111'
const job: TrashPurgeJob = { id: 8, status: 'queued', progressCurrent: 0, progressTotal: 2, failedCount: 0, errorCode: null }

function setup(overrides: Partial<TrashOperations> = {}) {
  const calls: Array<{ operation: string; ownerId: string; args: unknown[] }> = []
  const record = (operation: string) => async (owner: string, ...args: unknown[]) => {
    calls.push({ operation, ownerId: owner, args })
    return undefined
  }
  const operations: TrashOperations = {
    listFiles: async (owner, query) => { calls.push({ operation: 'listFiles', ownerId: owner, args: [query] }); return { items: [], has_more: false, next_cursor: null } },
    listFolders: async (owner, query) => { calls.push({ operation: 'listFolders', ownerId: owner, args: [query] }); return { items: [], has_more: false, next_cursor: null } },
    listFolderContents: async (owner, id, query) => { calls.push({ operation: 'listFolderContents', ownerId: owner, args: [id, query] }); return { folders: { items: [], has_more: false, next_cursor: null }, files: { items: [], has_more: false, next_cursor: null } } },
    restoreFolder: async (owner, id, origin) => { calls.push({ operation: 'restoreFolder', ownerId: owner, args: [id, origin] }); return { id } },
    restoreFiles: async (owner, ids, origin) => { calls.push({ operation: 'restoreFiles', ownerId: owner, args: [ids, origin] }) },
    hardDeleteFile: record('hardDeleteFile'),
    hardDeleteFolder: record('hardDeleteFolder'),
    startEmpty: async (owner) => { calls.push({ operation: 'startEmpty', ownerId: owner, args: [] }); return job },
    activeEmpty: async (owner) => { calls.push({ operation: 'activeEmpty', ownerId: owner, args: [] }); return null },
    getEmpty: async (owner, id) => { calls.push({ operation: 'getEmpty', ownerId: owner, args: [id] }); return job },
    ...overrides,
  }
  const app = Fastify()
  installHttpErrorHandler(app)
  registerTrashRoutes(app, { requireUser: async () => {}, ownerIdFromRequest: () => ownerId, operations })
  return { app, calls }
}

test('回收站分页路由传递认证 owner、边界和独立游标', async () => {
  const { app, calls } = setup()
  try {
    const files = await app.inject({ method: 'GET', url: '/api/v1/trash/page?limit=12&cursor=file-cursor' })
    const folders = await app.inject({ method: 'GET', url: '/api/v1/trash/folders/page' })
    const contents = await app.inject({ method: 'GET', url: '/api/v1/trash/folders/7/contents/page?limit=5&folder_cursor=folder-cursor&file_cursor=file-cursor' })
    assert.equal(files.statusCode, 200)
    assert.equal(folders.statusCode, 200)
    assert.equal(contents.statusCode, 200)
    assert.deepEqual(calls, [
      { operation: 'listFiles', ownerId, args: [{ limit: 12, cursor: 'file-cursor' }] },
      { operation: 'listFolders', ownerId, args: [{ limit: 100, cursor: null }] },
      { operation: 'listFolderContents', ownerId, args: [7, { limit: 5, folderCursor: 'folder-cursor', fileCursor: 'file-cursor' }] },
    ])
  } finally { await app.close() }
})

test('回收站写入路由保留 owner、来源和状态码', async () => {
  const { app, calls } = setup()
  try {
    const headers = { 'x-client-id': 'synthetic-client' }
    const folder = await app.inject({ method: 'POST', url: '/api/v1/trash/folders/4/restore', headers })
    const fileDelete = await app.inject({ method: 'DELETE', url: '/api/v1/trash/2', headers })
    const folderDelete = await app.inject({ method: 'DELETE', url: '/api/v1/trash/folders/4', headers })
    const start = await app.inject({ method: 'POST', url: '/api/v1/trash/empty' })
    const legacyStart = await app.inject({ method: 'DELETE', url: '/api/v1/trash' })
    const invalidBatchRestore = await app.inject({
      method: 'POST', url: '/api/v1/trash/batch-restore', payload: { ids: [0] },
    })
    const batchRestore = await app.inject({
      method: 'POST', url: '/api/v1/trash/batch-restore', headers: { 'x-client-id': 'synthetic-client' },
      payload: { ids: [2, 3] },
    })
    assert.equal(folder.statusCode, 200)
    assert.equal(fileDelete.statusCode, 204)
    assert.equal(folderDelete.statusCode, 204)
    assert.equal(start.statusCode, 202)
    assert.equal(legacyStart.statusCode, 202)
    assert.equal(invalidBatchRestore.statusCode, 422)
    assert.equal(batchRestore.statusCode, 204)
    assert.deepEqual(calls, [
      { operation: 'restoreFolder', ownerId, args: [4, 'synthetic-client'] },
      { operation: 'hardDeleteFile', ownerId, args: [2, 'synthetic-client'] },
      { operation: 'hardDeleteFolder', ownerId, args: [4, 'synthetic-client'] },
      { operation: 'startEmpty', ownerId, args: [] },
      { operation: 'startEmpty', ownerId, args: [] },
      { operation: 'restoreFiles', ownerId, args: [[2, 3], 'synthetic-client'] },
    ])
  } finally { await app.close() }
})

test('清空回收站冷却返回 429 与 Retry-After', async () => {
  const { app } = setup({ startEmpty: async () => { throw new TrashCooldownError() } })
  try {
    const response = await app.inject({ method: 'POST', url: '/api/v1/trash/empty' })
    assert.equal(response.statusCode, 429)
    assert.equal(response.headers['retry-after'], '30')
    assert.deepEqual(response.json(), { detail: '刚完成清空，请稍后再试' })
  } finally { await app.close() }
})

test('回收站分页拒绝超限，未知归属与错误任务返回 404', async () => {
  const { app, calls } = setup({
    listFolderContents: async () => null,
    getEmpty: async () => null,
  })
  try {
    const tooMany = await app.inject({ method: 'GET', url: '/api/v1/trash/page?limit=201' })
    const missingFolder = await app.inject({ method: 'GET', url: '/api/v1/trash/folders/4/contents/page' })
    const missingJob = await app.inject({ method: 'GET', url: '/api/v1/trash/empty/99' })
    assert.equal(tooMany.statusCode, 422)
    assert.equal(missingFolder.statusCode, 404)
    assert.equal(missingJob.statusCode, 404)
    assert.equal(calls.length, 0)
  } finally { await app.close() }
})

test('清空任务查询从认证 owner 取数，非法 ID 不调用 store', async () => {
  const { app, calls } = setup()
  try {
    const active = await app.inject({ method: 'GET', url: '/api/v1/trash/empty/active' })
    const jobResponse = await app.inject({ method: 'GET', url: '/api/v1/trash/empty/8' })
    const badId = await app.inject({ method: 'GET', url: '/api/v1/trash/empty/0' })
    assert.equal(active.statusCode, 200)
    assert.equal(active.body, 'null')
    assert.equal(jobResponse.statusCode, 200)
    assert.equal(badId.statusCode, 422)
    assert.deepEqual(calls, [
      { operation: 'activeEmpty', ownerId, args: [] },
      { operation: 'getEmpty', ownerId, args: [8] },
    ])
  } finally { await app.close() }
})
