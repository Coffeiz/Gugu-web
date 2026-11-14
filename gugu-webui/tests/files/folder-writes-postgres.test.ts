import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { Pool, PoolClient } from 'pg'
import { CoreError } from '@gugu/core'
import { createPostgresFolderWriteOperations } from '../../src/domains/files/folder-writes-postgres.js'
import { createLocalPathMirrorMutation } from '../../src/domains/files/local-path-mirror.js'

const owner = '00000000-0000-4000-8000-000000000013'
const insertedFolder = {
  id: 91, user_id: owner, project_id: null, workspace_directory_id: null,
  parent_id: null, name: '新目录', version: 1,
}

function fakePool(query: (sql: string, values?: unknown[]) => Promise<{ rows?: unknown[]; rowCount?: number }> | { rows?: unknown[]; rowCount?: number }): Pool {
  const client = {
    async query(sql: string, values?: unknown[]) {
      return await query(sql, values)
    },
    release() {},
  }
  return { connect: async () => client } as unknown as Pool
}

function metadata() {
  return { undoContextId: 'undo-1', origin: 'test-client' }
}

test('folder create commits search alias and undo before publishing, while cleanup failure remains a successful write', async () => {
  const order: string[] = []
  const diagnostics: string[] = []
  const pool = fakePool((sql) => {
    if (sql === 'BEGIN') return {}
    if (sql.includes('pg_advisory_xact_lock')) return {}
    if (sql.includes('INSERT INTO folders')) return { rows: [insertedFolder] }
    if (sql.includes('SELECT count(*)::int')) return { rows: [{ file_count: 0, folder_count: 0 }] }
    if (sql === 'COMMIT') { order.push('commit'); return {} }
    if (sql === 'ROLLBACK') return {}
    throw new Error(`未预期 SQL: ${sql}`)
  })
  const operations = createPostgresFolderWriteOperations(pool, {
    buildSearchRomaji(name) { order.push(`search:${name}`); return 'xin-mu-lu' },
    async capturePathMirrorDirectoryKeys() { return [] },
    async preparePathMirrorMutation() {
      return { async apply() { order.push('apply') }, async rollback() { order.push('rollback') }, async finalize() { throw new Error('private path') } }
    },
    async recordForwardUndo() { order.push('undo') },
    async publishChanged() { order.push('publish') },
    onPathCleanupFailure(errorType) { diagnostics.push(errorType) },
    onPathRollbackFailure() { throw new Error('unused') },
  })

  const response = await operations.create(owner, {
    name: '新目录', projectId: null, workspaceDirectoryId: null, parentId: null,
  }, metadata())
  assert.deepEqual(response, {
    id: 91, projectId: null, workspaceDirectoryId: null, parentId: null,
    name: '新目录', fileCount: 0, folderCount: 0, version: 1,
  })
  assert.deepEqual(order, ['search:新目录', 'apply', 'undo', 'commit', 'publish'])
  assert.deepEqual(diagnostics, ['Error'])
})

test('failed commit compensates files without overwriting a replacement source and reports compensation failure', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-folder-rollback-'))
  const oldKey = `${owner}/scope/old.txt`
  const newKey = `${owner}/scope/new.txt`
  const oldPath = path.join(root, ...oldKey.split('/'))
  const newPath = path.join(root, ...newKey.split('/'))
  await mkdir(path.dirname(oldPath), { recursive: true })
  await writeFile(oldPath, 'original bytes')
  const diagnostics: string[] = []
  const pool = fakePool(async (sql) => {
    if (sql === 'BEGIN') return {}
    if (sql.includes('pg_advisory_xact_lock')) return {}
    if (sql.includes('INSERT INTO folders')) return { rows: [insertedFolder] }
    if (sql.includes('SELECT count(*)::int')) return { rows: [{ file_count: 1, folder_count: 0 }] }
    if (sql === 'COMMIT') {
      await writeFile(oldPath, 'new concurrent file')
      throw new Error('database commit failed')
    }
    if (sql === 'ROLLBACK') return {}
    throw new Error(`未预期 SQL: ${sql}`)
  })
  const operations = createPostgresFolderWriteOperations(pool, {
    buildSearchRomaji: () => 'xin-mu-lu',
    async capturePathMirrorDirectoryKeys() { return [] },
    async preparePathMirrorMutation() {
      return createLocalPathMirrorMutation(root, owner, [{ fromKey: oldKey, toKey: newKey }], [`${owner}/scope`], [])
    },
    async recordForwardUndo() {},
    async publishChanged() {},
    onPathCleanupFailure() {},
    onPathRollbackFailure(errorType) { diagnostics.push(errorType) },
  })

  try {
    await assert.rejects(operations.create(owner, {
      name: '新目录', projectId: null, workspaceDirectoryId: null, parentId: null,
    }, metadata()), /database commit failed/)
    assert.equal(await readFile(oldPath, 'utf8'), 'new concurrent file')
    assert.equal(await readFile(newPath, 'utf8'), 'original bytes')
    assert.deepEqual(diagnostics, ['NodeError'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('folder rename uses version CAS and updates its search alias in the same SQL write', async () => {
  const sqlCalls: Array<{ sql: string; values?: unknown[] }> = []
  const before = { ...insertedFolder, name: '旧目录' }
  const after = { ...insertedFolder, name: '新名称', version: 2 }
  const pool = fakePool((sql, values) => {
    sqlCalls.push({ sql, values })
    if (sql === 'BEGIN') return {}
    if (sql.includes('pg_advisory_xact_lock')) return {}
    if (sql.includes('FROM folders WHERE id=$1 AND user_id=$2')) return { rows: [before] }
    if (sql.includes('UPDATE folders SET name=$1')) return { rows: [after] }
    if (sql.includes('SELECT count(*)::int')) return { rows: [{ file_count: 2, folder_count: 1 }] }
    if (sql === 'COMMIT') return {}
    if (sql === 'ROLLBACK') return {}
    throw new Error(`未预期 SQL: ${sql}`)
  })
  const operations = createPostgresFolderWriteOperations(pool, {
    buildSearchRomaji: (name) => `alias:${name}`,
    async capturePathMirrorDirectoryKeys() { return [] },
    async preparePathMirrorMutation() { return { async apply() {}, async rollback() {}, async finalize() {} } },
    async recordForwardUndo() {}, async publishChanged() {},
    onPathCleanupFailure() {}, onPathRollbackFailure() {},
  })
  const response = await operations.rename(owner, 91, { name: '新名称', version: 1 }, metadata())
  const update = sqlCalls.find(({ sql }) => sql.includes('UPDATE folders SET name=$1'))
  assert.deepEqual(update?.values, ['新名称', 'alias:新名称', 91, owner, 1])
  assert.equal((response as { version: number }).version, 2)
})

test('folder move validates the destination subtree, moves all descendants and publishes only after commit', async () => {
  const order: string[] = []
  const before = { ...insertedFolder, parent_id: null, version: 3 }
  const after = { ...insertedFolder, project_id: 44, parent_id: 40, version: 4 }
  const sqlCalls: Array<{ sql: string; values?: unknown[] }> = []
  const pool = fakePool((sql, values) => {
    sqlCalls.push({ sql, values })
    if (sql === 'BEGIN' || sql.includes('pg_advisory_xact_lock')) return {}
    if (sql.includes('FROM folders WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL FOR UPDATE')
      && Number(values?.[0]) === 91)
      return { rows: [before] }
    if (sql.includes('FROM projects WHERE id=$1 AND user_id=$2')) return { rows: [{ id: 44 }], rowCount: 1 }
    if (sql.includes('WITH RECURSIVE subtree')) return { rows: [{ id: 91 }, { id: 92 }] }
    if (sql.includes('FROM folders WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL')
      && Number(values?.[0]) === 40) {
      return { rows: [{ ...insertedFolder, id: 40, project_id: 44, name: '父级' }] }
    }
    if (sql.includes('SELECT 1 FROM folders WHERE user_id=$1 AND project_id IS NOT DISTINCT FROM $2'))
      return { rows: [], rowCount: 0 }
    if (sql.includes('UPDATE folders SET parent_id=$1')) return { rows: [after], rowCount: 1 }
    if (sql.includes('UPDATE folders SET project_id=$1')) return { rows: [], rowCount: 1 }
    if (sql.includes('SELECT count(*)::int')) return { rows: [{ file_count: 2, folder_count: 1 }] }
    if (sql === 'COMMIT') { order.push('commit'); return {} }
    if (sql === 'ROLLBACK') return {}
    throw new Error(`未预期 SQL: ${sql}`)
  })
  const operations = createPostgresFolderWriteOperations(pool, {
    buildSearchRomaji: (name) => `alias:${name}`,
    async capturePathMirrorDirectoryKeys(_client, ownerId, folderId) {
      order.push('capture-paths')
      assert.equal(ownerId, owner)
      assert.equal(folderId, 91)
      return [`${owner}/个人文件/新目录`, `${owner}/个人文件/新目录/子目录`]
    },
    async preparePathMirrorMutation(_client, _ownerId, _folderId, action, _beforeName, oldDirectories) {
      assert.equal(action, 'move')
      assert.deepEqual(oldDirectories, [`${owner}/个人文件/新目录`, `${owner}/个人文件/新目录/子目录`])
      return {
        async apply() { order.push('apply') },
        async rollback() { order.push('rollback') },
        async finalize() { order.push('finalize') },
        fileChanges: [],
      }
    },
    async recordForwardUndo(_client, record) {
      order.push(`undo:${record.action}`)
      assert.equal(record.before?.version, 3)
      assert.equal(record.folder.version, 4)
    },
    async publishChanged(event) { order.push(`publish:${event.operation}`) },
    onPathCleanupFailure() {},
    onPathRollbackFailure() {},
  })

  const result = await operations.move(owner, 91, {
    parentId: 40, version: 3, projectId: 44, projectSet: true,
    workspaceDirectoryId: null, workspaceDirectorySet: true,
  }, metadata()) as { projectId: number; parentId: number; version: number }
  assert.equal(result.projectId, 44)
  assert.equal(result.parentId, 40)
  assert.equal(result.version, 4)
  assert.deepEqual(order, ['capture-paths', 'apply', 'undo:move', 'commit', 'finalize', 'publish:update'])
  assert.deepEqual(sqlCalls.find(({ sql }) => sql.includes('UPDATE folders SET parent_id=$1'))?.values,
    [40, 44, null, 91, owner, 3])
  assert.ok(sqlCalls.some(({ sql }) => sql.includes('id=ANY($4::int[])') && sql.includes('id<>$5')))
})

test('folder move rejects a descendant as its destination before filesystem or SQL writes', async () => {
  const order: string[] = []
  const pool = fakePool((sql, values) => {
    if (sql === 'BEGIN' || sql.includes('pg_advisory_xact_lock')) return {}
    if (sql.includes('FROM folders WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL FOR UPDATE')
      && Number(values?.[0]) === 91) return { rows: [{ ...insertedFolder, version: 1 }] }
    if (sql.includes('WITH RECURSIVE subtree')) return { rows: [{ id: 91 }, { id: 92 }] }
    if (sql.includes('FROM folders WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL FOR UPDATE')
      && Number(values?.[0]) === 92) return { rows: [{ ...insertedFolder, id: 92, parent_id: 91 }] }
    if (sql === 'ROLLBACK') { order.push('rollback'); return {} }
    throw new Error(`不应执行 SQL: ${sql}`)
  })
  const operations = createPostgresFolderWriteOperations(pool, {
    buildSearchRomaji: () => '',
    async capturePathMirrorDirectoryKeys() { order.push('capture'); return [] },
    async preparePathMirrorMutation() { order.push('prepare'); throw new Error('不应准备路径变更') },
    async recordForwardUndo() { order.push('undo') },
    async publishChanged() { order.push('publish') },
    onPathCleanupFailure() {},
    onPathRollbackFailure() {},
  })
  await assert.rejects(operations.move(owner, 91, {
    parentId: 92, version: 1, projectId: null, projectSet: false,
    workspaceDirectoryId: null, workspaceDirectorySet: false,
  }, metadata()), (error: unknown) => error instanceof CoreError && error.code === 'invalid_request')
  assert.deepEqual(order, ['rollback'])
})

test('failed SQL rollback discards the pooled connection and preserves the original domain error', async () => {
  let releaseArgument: unknown = 'not released'
  const client = {
    async query(sql: string) {
      if (sql === 'BEGIN' || sql.includes('pg_advisory_xact_lock')) return { rows: [] }
      if (sql.includes('FROM projects')) return { rows: [], rowCount: 0 }
      if (sql === 'ROLLBACK') throw new Error('rollback transport failed')
      throw new Error(`未预期 SQL: ${sql}`)
    },
    release(error?: Error | boolean) { releaseArgument = error },
  }
  const pool = { connect: async () => client } as unknown as Pool
  const operations = createPostgresFolderWriteOperations(pool, {
    buildSearchRomaji: () => '',
    async capturePathMirrorDirectoryKeys() { return [] },
    async preparePathMirrorMutation() { throw new Error('unused') },
    async recordForwardUndo() {}, async publishChanged() {},
    onPathCleanupFailure() {}, onPathRollbackFailure() {},
  })
  await assert.rejects(operations.create(owner, {
    name: '项目内目录', projectId: 404, workspaceDirectoryId: null, parentId: null,
  }, metadata()), (error: unknown) => error instanceof Error && error.message === '项目不存在')
  assert.equal(releaseArgument, true)
})

test('partial PathMirror apply failure is compensated by the transaction caller and diagnosed if compensation fails', async () => {
  const order: string[] = []
  const diagnostics: string[] = []
  const pool = fakePool((sql) => {
    if (sql === 'BEGIN') return {}
    if (sql.includes('pg_advisory_xact_lock')) return {}
    if (sql.includes('INSERT INTO folders')) return { rows: [insertedFolder] }
    if (sql === 'ROLLBACK') { order.push('sql-rollback'); return {} }
    throw new Error(`未预期 SQL: ${sql}`)
  })
  const operations = createPostgresFolderWriteOperations(pool, {
    buildSearchRomaji: () => '',
    async capturePathMirrorDirectoryKeys() { return [] },
    async preparePathMirrorMutation() {
      return {
        async apply() { order.push('apply'); throw new Error('physical apply failed') },
        async rollback() { order.push('path-rollback'); throw new Error('physical rollback failed') },
        async finalize() {},
      }
    },
    async recordForwardUndo() {}, async publishChanged() {},
    onPathCleanupFailure() {}, onPathRollbackFailure(errorType) { diagnostics.push(errorType) },
  })
  await assert.rejects(operations.create(owner, {
    name: '新目录', projectId: null, workspaceDirectoryId: null, parentId: null,
  }, metadata()), /physical apply failed/)
  assert.deepEqual(order, ['apply', 'sql-rollback', 'path-rollback'])
  assert.deepEqual(diagnostics, ['Error'])
})
