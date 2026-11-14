import assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { PoolClient } from 'pg'
import {
  capturePostgresFolderPathMirrorDirectoryKeys,
  createPostgresFolderPathMirrorPlanner,
} from '../../src/domains/files/folder-path-planner.js'

const owner = '00000000-0000-4000-8000-000000000014'

function clientFor(query: (sql: string, values?: unknown[]) => Promise<{ rows?: unknown[]; rowCount?: number }> | { rows?: unknown[]; rowCount?: number }): PoolClient {
  return { query: async (sql: string, values?: unknown[]) => await query(sql, values) } as unknown as PoolClient
}

function folder(id: number, parentId: number | null, name: string, projectId: number | null = null, workspaceId: number | null = null) {
  return { id, parent_id: parentId, name, project_id: projectId, workspace_directory_id: workspaceId }
}

test('Postgres path planner renames descendant storage keys, carries undo facts, and prunes old skeleton after finalize', async () => {
  const rootPath = await mkdtemp(path.join(tmpdir(), 'gugu-folder-planner-'))
  const oldKey = `${owner}/个人文件/父/旧/子/记录.md`
  const newKey = `${owner}/个人文件/父/新/子/记录.md`
  const source = path.join(rootPath, ...oldKey.split('/'))
  const target = path.join(rootPath, ...newKey.split('/'))
  await mkdir(path.dirname(source), { recursive: true })
  await writeFile(source, 'file bytes')
  const sqlCalls: Array<{ sql: string; values?: unknown[] }> = []
  const client = clientFor((sql, values) => {
    if (sql.includes('WITH RECURSIVE subtree')) return { rows: [folder(30, 10, '新'), folder(31, 30, '子')] }
    sqlCalls.push({ sql, values })
    if (sql.includes('FROM folders WHERE id=$1') && Number(values?.[0]) === 30) return { rows: [folder(30, 10, '新')] }
    if (sql.includes('FROM workspace_directories')) return { rows: [] }
    if (sql.includes('FROM projects')) return { rows: [] }
    if (sql.includes('FROM folders WHERE id=$1') && Number(values?.[0]) === 10) return { rows: [folder(10, null, '父')] }
    if (sql.includes('FROM files WHERE user_id=$1 AND folder_id=ANY')) {
      return { rows: [{ id: 201, folder_id: 31, storage_key: oldKey, display_name: '记录', ext: 'md', storage_backend: 'local' }] }
    }
    if (sql.includes('SELECT id FROM files WHERE user_id=$1 AND storage_key=$2')) return { rowCount: 0, rows: [] }
    if (sql.includes('UPDATE files SET storage_key=$1')) return { rowCount: 1, rows: [] }
    throw new Error(`未预期 SQL: ${sql}`)
  })
  const planner = createPostgresFolderPathMirrorPlanner(rootPath, (name) => `alias:${name}`)
  try {
    const mutation = await planner(client, owner, 30, 'rename', '旧')
    assert.deepEqual(mutation.fileChanges, [{
      fileId: 201, beforeStorageKey: oldKey, afterStorageKey: newKey,
      beforeDisplayName: '记录', afterDisplayName: '记录',
    }])
    const update = sqlCalls.find(({ sql }) => sql.includes('UPDATE files SET storage_key=$1'))
    assert.deepEqual(update?.values, [newKey, '记录', 'alias:记录', 'personal', null, null, 201, owner])
    await mutation.apply()
    assert.equal(await readFile(target, 'utf8'), 'file bytes')
    await mutation.finalize()
    await assert.rejects(readFile(source), { code: 'ENOENT' })
    await assert.rejects(lstat(path.dirname(source)), { code: 'ENOENT' })
    await assert.rejects(lstat(path.dirname(path.dirname(source))), { code: 'ENOENT' })
    await lstat(path.dirname(path.dirname(path.dirname(source))))
  } finally {
    await rm(rootPath, { recursive: true, force: true })
  }
})

test('Postgres path planner follows project date keys and resolves disk name collisions without overwriting', async () => {
  const rootPath = await mkdtemp(path.join(tmpdir(), 'gugu-folder-planner-'))
  const folderPath = `${owner}/项目文件/2024/05/计划 #77/归档`
  const oldKey = `${owner}/个人文件/旧/报告.txt`
  const targetKey = `${folderPath}/报告(1).txt`
  const collisionPath = path.join(rootPath, `${folderPath}/报告.txt`)
  const originalPath = path.join(rootPath, ...oldKey.split('/'))
  await mkdir(path.dirname(collisionPath), { recursive: true })
  await mkdir(path.dirname(originalPath), { recursive: true })
  await writeFile(collisionPath, 'existing file')
  await writeFile(originalPath, 'moving file')
  const client = clientFor((sql, values) => {
    if (sql.includes('FROM folders WHERE id=$1') && Number(values?.[0]) === 77) return { rows: [folder(77, null, '归档', 77)] }
    if (sql.includes('FROM projects')) return { rows: [{ name: '计划', start_date: '2024-05-03', created_at: '2020-01-01' }] }
    if (sql.includes('WITH RECURSIVE subtree')) return { rows: [folder(77, null, '归档', 77)] }
    if (sql.includes('FROM files WHERE user_id=$1 AND folder_id=ANY')) {
      return { rows: [{ id: 202, folder_id: 77, storage_key: oldKey, display_name: '报告', ext: 'TXT', storage_backend: 'local' }] }
    }
    if (sql.includes('SELECT id FROM files WHERE user_id=$1 AND storage_key=$2')) return { rowCount: 0, rows: [] }
    if (sql.includes('UPDATE files SET storage_key=$1')) return { rowCount: 1, rows: [] }
    throw new Error(`未预期 SQL: ${sql}`)
  })
  const planner = createPostgresFolderPathMirrorPlanner(rootPath, (name) => `alias:${name}`)
  try {
    const mutation = await planner(client, owner, 77, 'rename', '旧')
    assert.deepEqual(mutation.fileChanges, [{
      fileId: 202, beforeStorageKey: oldKey, afterStorageKey: targetKey,
      beforeDisplayName: '报告', afterDisplayName: '报告(1)',
    }])
    await mutation.apply()
    assert.equal(await readFile(collisionPath, 'utf8'), 'existing file')
    assert.equal(await readFile(path.join(rootPath, ...targetKey.split('/')), 'utf8'), 'moving file')
    await mutation.rollback()
    assert.equal(await readFile(originalPath, 'utf8'), 'moving file')
    assert.equal(await readFile(collisionPath, 'utf8'), 'existing file')
  } finally {
    await rm(rootPath, { recursive: true, force: true })
  }
})

test('Postgres path planner rejects an owner-mismatched ancestor instead of constructing a path', async () => {
  const rootPath = await mkdtemp(path.join(tmpdir(), 'gugu-folder-planner-'))
  const client = clientFor((sql, values) => {
    if (sql.includes('FROM folders WHERE id=$1') && Number(values?.[0]) === 55) return { rows: [folder(55, 1, 'child')] }
    if (sql.includes('FROM workspace_directories')) return { rows: [] }
    if (sql.includes('FROM projects')) return { rows: [] }
    if (sql.includes('FROM folders WHERE id=$1') && Number(values?.[0]) === 1) return { rows: [] }
    throw new Error(`不应继续执行 SQL: ${sql}`)
  })
  try {
    const planner = createPostgresFolderPathMirrorPlanner(rootPath, () => '')
    await assert.rejects(planner(client, owner, 55, 'create', null), /父级归属无效/)
  } finally {
    await rm(rootPath, { recursive: true, force: true })
  }
})

test('Postgres path planner materializes workspace folders under the frozen directory segment', async () => {
  const rootPath = await mkdtemp(path.join(tmpdir(), 'gugu-folder-planner-'))
  const client = clientFor((sql, values) => {
    if (sql.includes('FROM folders WHERE id=$1') && Number(values?.[0]) === 88) {
      return { rows: [folder(88, null, '设计区', null, 9)] }
    }
    if (sql.includes('FROM workspace_directories')) return { rows: [{ directory_name: 'frozen-workspace' }] }
    if (sql.includes('WITH RECURSIVE subtree')) return { rows: [folder(88, null, '设计区', null, 9)] }
    throw new Error(`不应执行此 SQL: ${sql}`)
  })
  try {
    const planner = createPostgresFolderPathMirrorPlanner(rootPath, () => '')
    const mutation = await planner(client, owner, 88, 'create', null)
    await mutation.apply()
    await lstat(path.join(rootPath, owner, 'workspace', 'frozen-workspace', '设计区'))
    await mutation.rollback()
    await assert.rejects(lstat(path.join(rootPath, owner, 'workspace', 'frozen-workspace', '设计区')), { code: 'ENOENT' })
  } finally {
    await rm(rootPath, { recursive: true, force: true })
  }
})

test('Postgres path planner moves a folder subtree across Local scopes and prunes its old directory skeleton', async () => {
  const rootPath = await mkdtemp(path.join(tmpdir(), 'gugu-folder-planner-'))
  const oldKey = `${owner}/个人文件/来源/归档/记录.md`
  const newKey = `${owner}/项目文件/2026/04/目标项目 #44/资料/归档/记录.md`
  const oldPath = path.join(rootPath, ...oldKey.split('/'))
  const newPath = path.join(rootPath, ...newKey.split('/'))
  await mkdir(path.dirname(oldPath), { recursive: true })
  await writeFile(oldPath, '移动中的正文')
  let moved = false
  const client = clientFor((sql, values) => {
    if (sql.includes('FROM folders WHERE id=$1') && Number(values?.[0]) === 30) {
      return { rows: [folder(30, moved ? 44 : 50, '归档', moved ? 44 : null)] }
    }
    if (sql.includes('FROM folders WHERE id=$1') && Number(values?.[0]) === 44) {
      return { rows: [folder(44, null, '资料', 44)] }
    }
    if (sql.includes('FROM folders WHERE id=$1') && Number(values?.[0]) === 50) {
      return { rows: [folder(50, null, '来源')] }
    }
    if (sql.includes('FROM projects')) {
      return { rows: [{ name: '目标项目', start_date: '2026-04-10', created_at: '2026-04-10' }] }
    }
    if (sql.includes('WITH RECURSIVE subtree')) {
      return { rows: [folder(30, moved ? 44 : 50, '归档', moved ? 44 : null)] }
    }
    if (sql.includes('FROM files WHERE user_id=$1 AND folder_id=ANY')) {
      return { rows: [{ id: 201, folder_id: 30, storage_key: oldKey, display_name: '记录', ext: 'md', storage_backend: 'local' }] }
    }
    if (sql.includes('SELECT id FROM files WHERE user_id=$1 AND storage_key=$2')) return { rows: [], rowCount: 0 }
    if (sql.includes('UPDATE files SET storage_key=$1')) { moved = true; return { rows: [], rowCount: 1 } }
    throw new Error(`未预期 SQL: ${sql}`)
  })

  try {
    const oldDirectoryKeys = await capturePostgresFolderPathMirrorDirectoryKeys(rootPath, client, owner, 30)
    assert.deepEqual(oldDirectoryKeys, [
      `${owner}/个人文件/来源/归档`,
    ])
    moved = true
    const planner = createPostgresFolderPathMirrorPlanner(rootPath, (name) => `alias:${name}`)
    const mutation = await planner(client, owner, 30, 'move', null, oldDirectoryKeys)
    assert.deepEqual(mutation.fileChanges, [{
      fileId: 201,
      beforeStorageKey: oldKey,
      afterStorageKey: newKey,
      beforeDisplayName: '记录',
      afterDisplayName: '记录',
    }])
    await mutation.apply()
    assert.equal(await readFile(newPath, 'utf8'), '移动中的正文')
    await mutation.finalize()
    await assert.rejects(readFile(oldPath), { code: 'ENOENT' })
    await assert.rejects(lstat(path.dirname(oldPath)), { code: 'ENOENT' })
  } finally {
    await rm(rootPath, { recursive: true, force: true })
  }
})
