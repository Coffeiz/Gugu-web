import assert from 'node:assert/strict'
import { createDecipheriv, createHash } from 'node:crypto'
import test from 'node:test'
import type { Pool } from 'pg'
import { createPostgresTrashReadOperations } from '../../src/domains/files/persistence/trash-postgres.js'

const ownerId = '11111111-1111-4111-8111-111111111111'
const secret = 'synthetic-trash-cursor-secret'

function fileRow(id: number, pageSort: string) {
  return {
    id, display_name: `恢复-${id}`, ext: 'TXT', space: 'personal', workspace_directory_id: null,
    project_id: null, project_name: null, project_color: null, stage_name: '', folder_id: null,
    folder_name: null, mind_map_id: null, size: '1 B', size_bytes: 1, mime_type: 'text/plain',
    created_at: '2026-10-01T00:00:00.000Z', deleted_at: '2026-10-02T00:00:00',
    img_width: null, img_height: null, version: 2, page_sort: pageSort,
  }
}

function decodeCursor(token: string) {
  const bytes = Buffer.from(token, 'base64url')
  const key = createHash('sha256').update(`file-page-cursor:${secret}`).digest()
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12))
  decipher.setAAD(Buffer.from('gugu-file-page-cursor-v1'))
  decipher.setAuthTag(bytes.subarray(-16))
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString())
}

function fakePool(rowsByCall: unknown[][] = []) {
  const calls: Array<{ sql: string; values: unknown[] }> = []
  const pool = {
    async query(sql: string, values: unknown[]) {
      calls.push({ sql, values })
      return { rows: rowsByCall[calls.length - 1] ?? [], rowCount: rowsByCall[calls.length - 1]?.length ?? 0 }
    },
  }
  return { pool: pool as unknown as Pool, calls }
}

test('回收站文件分页按 owner 查询、保留响应字段并生成 Python 兼容游标', async () => {
  const { pool, calls } = fakePool([[fileRow(12, '2026-10-03T00:00:00.000000'), fileRow(11, '2026-10-02T00:00:00.000000')]])
  const operations = createPostgresTrashReadOperations(pool, secret)
  const result = await operations.listFiles(ownerId, { limit: 1, cursor: null })
  const cursor = result.next_cursor
  assert.equal(calls.length, 1)
  assert.match(calls[0]!.sql, /file\.user_id=\$1/)
  assert.match(calls[0]!.sql, /file\.deleted_at IS NOT NULL/)
  assert.match(calls[0]!.sql, /project\.user_id=\$1/)
  assert.match(calls[0]!.sql, /folder\.user_id=\$1/)
  assert.deepEqual(calls[0]!.values, [ownerId, 2])
  assert.equal(result.has_more, true)
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0]!.display_name, '恢复-12')
  assert.equal(result.items[0]!.deleted_at, '2026-10-02T00:00:00')
  assert.deepEqual(decodeCursor(cursor!), {
    id: 12, scope: { resource: 'trash_files', sort: 'deletedAt_desc_id_desc' },
    user: ownerId, v: 1, value: '2026-10-03T00:00:00.000000',
  })
})

test('回收站游标绑定 owner 和资源类型，拒绝跨用户复用', async () => {
  const { pool, calls } = fakePool([[fileRow(12, '2026-10-03T00:00:00.000000'), fileRow(11, '2026-10-02T00:00:00.000000')]])
  const operations = createPostgresTrashReadOperations(pool, secret)
  const result = await operations.listFiles(ownerId, { limit: 1, cursor: null })
  await operations.listFiles(ownerId, { limit: 1, cursor: result.next_cursor })
  assert.deepEqual(calls[1]!.values, [ownerId, '2026-10-03T00:00:00.000000', 12, 2])

  await assert.rejects(
    () => operations.listFolders('22222222-2222-4222-8222-222222222222', { limit: 1, cursor: result.next_cursor }),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'invalid_request',
  )
  assert.equal(calls.length, 2)
})

test('回收站目录内容分别使用 owner-bound folder/file 游标并隐藏非顶层根目录', async () => {
  const { pool, calls } = fakePool([
    [{ id: 7 }],
    [],
    [{ ...fileRow(12, '2026-10-03T00:00:00.000000'), folder_id: 7, deleted_at: '2026-10-02T00:00:00' }],
  ])
  const operations = createPostgresTrashReadOperations(pool, secret)
  const result = await operations.listFolderContents(ownerId, 7, {
    limit: 1, folderCursor: null, fileCursor: null,
  })
  assert.deepEqual(result, {
    folders: { items: [], has_more: false, next_cursor: null },
    files: { items: [{
      id: 12, display_name: '恢复-12', ext: 'TXT', space: 'personal', workspace_directory_id: null,
      project_id: null, project_name: null, project_color: null, stage_name: '', folder_id: 7,
      folder_name: null, mind_map_id: null, size: '1 B', size_bytes: 1, mime_type: 'text/plain',
      created_at: '2026-10-01T00:00:00.000Z', deleted_at: '2026-10-02T00:00:00',
      img_width: null, img_height: null, version: 2,
    }], has_more: false, next_cursor: null },
  })
  assert.match(calls[0]!.sql, /parent\.deleted_at IS NULL/)
  assert.match(calls[0]!.sql, /parent\.user_id=\$2/)
  assert.match(calls[1]!.sql, /folder\.parent_id=\$2/)
  assert.match(calls[2]!.sql, /file\.folder_id=\$2/)
  assert.match(calls[2]!.sql, /project\.user_id=\$1/)
  assert.match(calls[2]!.sql, /folder\.user_id=\$1/)
  assert.deepEqual(calls.map((call) => call.values.slice(0, 2)), [[7, ownerId], [ownerId, 7], [ownerId, 7]])
})
