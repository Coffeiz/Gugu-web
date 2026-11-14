import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { Pool } from 'pg'
import { createPostgresFileReadOperations } from '../../src/domains/files/file-reads-postgres.js'

const owner = '00000000-0000-4000-8000-000000000041'

function fakePool(query: (sql: string, values?: unknown[]) => Promise<{ rows?: unknown[] }> | { rows?: unknown[] }): Pool {
  return { async query(sql: string, values?: unknown[]) { return await query(sql, values) } } as unknown as Pool
}

function fileRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 17,
    storage_key: `${owner}/notes/meeting.md`,
    display_name: '会议记录',
    ext: 'md',
    space: 'personal',
    workspace_directory_id: null,
    project_id: null,
    project_name: null,
    project_color: null,
    stage_name: '',
    folder_id: null,
    folder_name: null,
    mind_map_id: null,
    size: '1 KB',
    size_bytes: '1024',
    mime_type: 'text/markdown',
    created_at: '2026-11-12T10:20:30.123456',
    deleted_at: null,
    img_width: null,
    img_height: null,
    version: '3',
    ...overrides,
  }
}

test('file detail is owner scoped and maps the Python response fields and UTC timestamp', async () => {
  const queries: Array<{ sql: string; values?: unknown[] }> = []
  const operations = createPostgresFileReadOperations(fakePool((sql, values) => {
    queries.push({ sql, values })
    return { rows: [fileRow({ project_id: 9, project_name: '合成项目', project_color: 'blue #abc', folder_id: 4, folder_name: '资料' })] }
  }))

  const response = await operations.getFile(owner, 17) as Record<string, unknown>

  assert.equal(response.id, 17)
  assert.equal(response.displayName, '会议记录')
  assert.equal(response.projectColor, '#abc')
  assert.equal(response.folderName, '资料')
  assert.equal(response.createdAt, '2026-11-12T10:20:30.123456Z')
  assert.match(queries[0]!.sql, /file\.user_id=\$2 AND file\.deleted_at IS NULL/)
  assert.deepEqual(queries[0]!.values, [17, owner])
})

test('file location returns a bounded root-to-leaf path after checking owner and exact scope', async () => {
  const operations = createPostgresFileReadOperations(fakePool((sql, values) => {
    if (sql.includes('FROM files file')) return { rows: [fileRow({ folder_id: 4 })] }
    if (sql.includes('FROM folders')) {
      const id = Number(values?.[0])
      return { rows: [id === 4
        ? { id: 4, project_id: null, workspace_directory_id: null, parent_id: 2, name: '子目录', version: 2 }
        : { id: 2, project_id: null, workspace_directory_id: null, parent_id: null, name: '资料', version: 1 }] }
    }
    throw new Error(`未预期 SQL: ${sql}`)
  }))

  const response = await operations.getFileLocation(owner, 17) as {
    folderPath: Array<{ id: number; name: string }>
  }

  assert.deepEqual(response.folderPath, [
    { id: 2, projectId: null, workspaceDirectoryId: null, parentId: null, name: '资料', fileCount: 0, folderCount: 0, version: 1 },
    { id: 4, projectId: null, workspaceDirectoryId: null, parentId: 2, name: '子目录', fileCount: 0, folderCount: 0, version: 2 },
  ])
})

test('file location hides a missing or cross-scope ancestor instead of returning foreign path metadata', async () => {
  const operations = createPostgresFileReadOperations(fakePool((sql) => {
    if (sql.includes('FROM files file')) return { rows: [fileRow({ folder_id: 4 })] }
    if (sql.includes('FROM folders')) return { rows: [{
      id: 4, project_id: null, workspace_directory_id: 99, parent_id: null, name: '他人目录', version: 1,
    }] }
    throw new Error(`未预期 SQL: ${sql}`)
  }))

  await assert.rejects(operations.getFileLocation(owner, 17), (error: unknown) =>
    typeof error === 'object' && error !== null && 'code' in error
      && (error as { code: unknown }).code === 'not_found')
})

test('recent summary clamps at the requested row count and library counts are returned as numbers', async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = []
  const operations = createPostgresFileReadOperations(fakePool((sql, values) => {
    calls.push({ sql, values })
    if (sql.includes('ORDER BY file.id DESC LIMIT')) return { rows: [fileRow()] }
    return { rows: [{ personal_file_count: '2', personal_folder_count: '3', project_file_count: '5',
      project_folder_count: '7', trash_file_count: '11', trash_folder_count: '13' }] }
  }))

  const summary = await operations.getSummary(owner, 5) as { recentFiles: unknown[] }
  const counts = await operations.getLibraryCounts(owner) as Record<string, number>

  assert.equal(summary.recentFiles.length, 1)
  assert.deepEqual(calls[0]!.values, [owner, 5])
  assert.deepEqual(counts, {
    personalFileCount: 2, personalFolderCount: 3, projectFileCount: 5,
    projectFolderCount: 7, trashFileCount: 11, trashFolderCount: 13,
  })
})

test('storage snapshot prefers the maintained ledger and resolves the owner-specific quota', async () => {
  let values: unknown[] | undefined
  const operations = createPostgresFileReadOperations(fakePool((sql, queryValues) => {
    assert.match(sql, /ledger\.category='file_library'/)
    assert.match(sql, /users\.id=\$1/)
    values = queryValues
    return { rows: [{ storage_limit_bytes: '4096', ledger_used_bytes: '1536', file_used_bytes: '1800' }] }
  }), 8192)

  assert.deepEqual(await operations.getStorage(owner), { used_bytes: 1536, limit_bytes: 4096 })
  assert.deepEqual(values, [owner])
})

test('storage snapshot falls back to file records and preserves inherited, zero, and unlimited quotas', async () => {
  for (const [userLimit, defaultLimit, expectedLimit] of [
    [null, 8192, 8192],
    [0, 8192, 0],
    [-1, 8192, null],
    [null, -1, -1],
    [null, null, null],
  ] as const) {
    const operations = createPostgresFileReadOperations(fakePool(() => ({ rows: [{
      storage_limit_bytes: userLimit,
      ledger_used_bytes: null,
      file_used_bytes: '1800',
    }] })), defaultLimit)

    assert.deepEqual(await operations.getStorage(owner), { used_bytes: 1800, limit_bytes: expectedLimit })
  }
})

test('file content opens only an owned Local key and reports the physical byte length', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gugu-file-content-adapter-'))
  try {
    const key = `${owner}/notes/meeting.md`
    const target = path.join(root, key)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, 'physical-body')
    const operations = createPostgresFileReadOperations(
      fakePool(() => ({ rows: [fileRow({ storage_key: key, size_bytes: '1' })] })),
      null,
      root,
    )

    const source = await operations.openContent(owner, 17)
    assert.ok(source)
    assert.equal(source.size, Buffer.byteLength('physical-body'))
    assert.equal(source.fileName, '会议记录.md')
    assert.equal((await source.handle.readFile()).toString(), 'physical-body')
    await source.handle.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('file content refuses traversal keys and symlinks that point outside Local storage', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gugu-file-content-path-'))
  const outside = await mkdtemp(path.join(os.tmpdir(), 'gugu-file-content-outside-'))
  try {
    const outsideFile = path.join(outside, 'secret.txt')
    await writeFile(outsideFile, 'synthetic')
    const ownerRoot = path.join(root, owner)
    await mkdir(ownerRoot, { recursive: true })
    await symlink(outsideFile, path.join(ownerRoot, 'link.txt'))

    const traversal = createPostgresFileReadOperations(
      fakePool(() => ({ rows: [fileRow({ storage_key: `${owner}/../secret.txt` })] })), null, root,
    )
    await assert.rejects(traversal.openContent(owner, 17), (error: unknown) =>
      typeof error === 'object' && error !== null && 'code' in error
        && (error as { code: unknown }).code === 'not_found')

    const symlinked = createPostgresFileReadOperations(
      fakePool(() => ({ rows: [fileRow({ storage_key: `${owner}/link.txt` })] })), null, root,
    )
    await assert.rejects(symlinked.openContent(owner, 17), (error: unknown) =>
      typeof error === 'object' && error !== null && 'code' in error
        && (error as { code: unknown }).code === 'not_found')
    assert.equal((await readFile(outsideFile)).toString(), 'synthetic')
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})
