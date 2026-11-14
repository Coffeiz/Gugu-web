import assert from 'node:assert/strict'
import test from 'node:test'
import type { Pool } from 'pg'
import { createPostgresFolderReadOperations } from '../../src/domains/files/folder-reads-postgres.js'

const owner = '00000000-0000-4000-8000-000000000061'

function fakePool(query: (sql: string, values?: unknown[]) => Promise<{ rows?: unknown[] }> | { rows?: unknown[] }): Pool {
  return { async query(sql: string, values?: unknown[]) { return await query(sql, values) } } as unknown as Pool
}

function folderRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 4, project_id: null, workspace_directory_id: null, parent_id: null,
    name: '资料', version: '3', file_count: '2', ...overrides,
  }
}

test('folder detail is owner scoped and returns the Python response shape with direct file count', async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = []
  const operations = createPostgresFolderReadOperations(fakePool((sql, values) => {
    calls.push({ sql, values })
    return { rows: [folderRow({ project_id: '8', workspace_directory_id: '11', parent_id: '2' })] }
  }))

  assert.deepEqual(await operations.getFolder(owner, 4), {
    id: 4, projectId: 8, workspaceDirectoryId: 11, parentId: 2,
    name: '资料', fileCount: 2, folderCount: 0, version: 3,
  })
  assert.match(calls[0]!.sql, /folder\.user_id=\$2 AND folder\.deleted_at IS NULL/)
  assert.match(calls[0]!.sql, /file\.user_id=folder\.user_id AND file\.deleted_at IS NULL/)
  assert.deepEqual(calls[0]!.values, [4, owner])
})

test('folder location returns only owned same-scope ancestors from root to parent', async () => {
  const operations = createPostgresFolderReadOperations(fakePool((sql, values) => {
    const id = Number(values?.[0])
    if (sql.includes('COUNT(file.id)')) return { rows: [folderRow({
      id: 4, parent_id: 2, file_count: '5',
    })] }
    return { rows: [id === 2
      ? folderRow({ id: 2, parent_id: null, name: '根目录', file_count: undefined })
      : folderRow()] }
  }))

  assert.deepEqual(await operations.getFolderLocation(owner, 4), {
    folder: { id: 4, projectId: null, workspaceDirectoryId: null, parentId: 2,
      name: '资料', fileCount: 5, folderCount: 0, version: 3 },
    ancestors: [{ id: 2, projectId: null, workspaceDirectoryId: null, parentId: null,
      name: '根目录', fileCount: 0, folderCount: 0, version: 3 }],
  })
})

test('folder location hides a missing or cross-scope ancestor and detects cycles', async () => {
  const missing = createPostgresFolderReadOperations(fakePool((sql) =>
    sql.includes('COUNT(file.id)')
      ? { rows: [folderRow({ parent_id: 2 })] }
      : { rows: [] }))
  await assert.rejects(missing.getFolderLocation(owner, 4), (error: unknown) =>
    typeof error === 'object' && error !== null && 'code' in error
      && (error as { code: unknown }).code === 'not_found')

  const crossScope = createPostgresFolderReadOperations(fakePool((sql) =>
    sql.includes('COUNT(file.id)')
      ? { rows: [folderRow({ parent_id: 2 })] }
      : { rows: [folderRow({ id: 2, project_id: 9 })] }))
  await assert.rejects(crossScope.getFolderLocation(owner, 4), (error: unknown) =>
    typeof error === 'object' && error !== null && 'code' in error
      && (error as { code: unknown }).code === 'not_found')

  const cyclic = createPostgresFolderReadOperations(fakePool((sql) =>
    sql.includes('COUNT(file.id)')
      ? { rows: [folderRow({ parent_id: 2 })] }
      : { rows: [folderRow({ id: 2, parent_id: 4 })] }))
  await assert.rejects(cyclic.getFolderLocation(owner, 4), (error: unknown) =>
    typeof error === 'object' && error !== null && 'code' in error
      && (error as { code: unknown }).code === 'not_found')
})
