import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createToolRegistry, createListDirectoryTool } from '@gugu/core/tools'
import type { RunIdentity } from '@gugu/core/agent'
import type { Pool } from 'pg'
import { createWebAgentFileDirectoryPort } from '../../src/modules/agent/tools/files/directory.js'
import type { AgentDispatchLease } from '../../src/modules/agent/run/dispatch.js'
import type { FileBrowserOperations } from '../../src/modules/files/browse.js'
import { createPostgresFileBrowserOperations } from '../../src/modules/files/browse.js'

const identity: RunIdentity = { ownerId: 'owner-test', sessionId: 'session-test', runId: 'run-test' }
const lease: AgentDispatchLease = {
  identity, token: 'synthetic-token', fence: 1, mode: 'start', cancelRequested: false,
  input: { v: 2, source: 'web', accessVersion: 'a'.repeat(64), userMessageId: 1, locale: 'zh-CN', origin: null },
}

test('文件库登记路径经 Core ToolRegistry、owner SQL 解析和文件浏览服务读取', async () => {
  const sqlCalls: Array<{ sql: string; values: unknown[] }> = []
  const pool = { async query(sql: string, values: unknown[] = []) {
    sqlCalls.push({ sql, values })
    assert.equal(values[0], identity.ownerId)
    if (sql.includes('FROM projects')) return { rows: [{ id: 5 }] }
    if (sql.includes('FROM folders')) {
      assert.equal(values[3], 5)
      return { rows: [{ id: 20 }] }
    }
    throw new Error('unexpected SQL')
  } } as unknown as Pick<Pool, 'query'>
  const observed: unknown[] = []
  const operations: FileBrowserOperations = {
    async listFiles(ownerId, query) {
      assert.equal(ownerId, identity.ownerId)
      observed.push({ kind: 'files', query })
      return { items: [{ id: 17, displayName: '说明', ext: 'md' }], has_more: false, next_cursor: null }
    },
    async listFolders(ownerId, query) {
      assert.equal(ownerId, identity.ownerId)
      observed.push({ kind: 'folders', query })
      return { items: [], has_more: false, next_cursor: null }
    },
  }
  const registry = createToolRegistry({ authorize: async () => true, tools: [
    createListDirectoryTool(createWebAgentFileDirectoryPort(operations, lease, pool)),
  ] })
  const result = await registry.tools.dispatch({ id: 'browse', name: 'list_dir', input: { file_path: '/project/项目甲/资料' } }, {
    identity, roundId: 'round-1', signal: new AbortController().signal, resolution: null,
    execute: async () => { throw new Error('目录读取不得调用执行后端') },
  })

  assert.equal(result.successful, true, JSON.stringify(result))
  assert.equal(sqlCalls.length, 2)
  assert.deepEqual(observed, [
    { kind: 'files', query: { limit: 100, cursor: null, sortBy: 'createdAt', sortOrder: 'desc',
      space: 'project', projectId: 5, folderId: 20, workspaceDirectoryId: null, mindMapId: null, ext: null, q: null, mode: 'OR' } },
    { kind: 'folders', query: { limit: 100, cursor: null, sortBy: 'createdAt', sortOrder: 'desc',
      projectId: 5, workspaceDirectoryId: null, parentId: 20 } },
  ])
})

test('文件库登记路径 owner 不匹配时在查询与浏览前拒绝', async () => {
  let queries = 0
  const pool = { async query() { queries++; return { rows: [] } } } as unknown as Pick<Pool, 'query'>
  const port = createWebAgentFileDirectoryPort({
    async listFiles() { throw new Error('must not browse') },
    async listFolders() { throw new Error('must not browse') },
  }, lease, pool)
  await assert.rejects(port.list({ ...identity, ownerId: 'other-owner' }, {
    path: '/personal', kind: 'both', limit: 100, sort_by: 'createdAt', sort_order: 'desc',
  }, new AbortController().signal), /授权已失效/)
  assert.equal(queries, 0)
})

test('list_dir OR/AND 查询经 Core 规范化后进入 owner 文件分页 SQL 并返回准确 total', async () => {
  const databaseIdentity = { ...identity, ownerId: 'a1f7f14e-6a6f-4b45-94da-93e0d8867b19' }
  const databaseLease = { ...lease, identity: databaseIdentity }
  const calls: Array<{ sql: string; values: unknown[] }> = []
  const pool = { async query(sql: string, values: unknown[] = []) {
    calls.push({ sql, values })
    if (sql.includes('SELECT count(*)::int AS total')) {
      assert.match(sql, /file\.display_name ILIKE \$9 AND file\.display_name ILIKE \$10/u)
      assert.deepEqual(values.slice(-2), ['%Alpha%', '%Beta%'])
      return { rows: [{ total: 9 }] }
    }
    if (sql.includes('SELECT file.id')) {
      assert.match(sql, /ORDER BY .* LIMIT \$11/u)
      return { rows: [{ id: 7, display_name: 'Alpha Beta', ext: 'TXT', space: 'personal',
        workspace_directory_id: null, project_id: null, project_name: null, project_color: null,
        stage_name: null, folder_id: null, folder_name: null, mind_map_id: null, size: '1 B', size_bytes: 1,
        mime_type: 'text/plain', created_at: '2026-11-19T10:00:00.000000', deleted_at: null,
        img_width: null, img_height: null, version: 1, page_sort: '2026-11-19T10:00:00.000000+00:00' }] }
    }
    if (sql.includes('FROM folders folder')) return { rows: [] }
    throw new Error(`unexpected SQL: ${sql}`)
  } } as unknown as Pick<Pool, 'query'>
  const operations = createPostgresFileBrowserOperations(pool as Pool, 'synthetic-browser-secret')
  const registry = createToolRegistry({ authorize: async () => true, tools: [
    createListDirectoryTool(createWebAgentFileDirectoryPort(operations, databaseLease, pool)),
  ] })
  const result = await registry.tools.dispatch({ id: 'query', name: 'list_dir', input: {
    space: 'personal', queries: [' Alpha ', 'alpha', 'Beta'], mode: 'AND',
  } }, {
    identity: databaseIdentity, roundId: 'round-query', signal: new AbortController().signal, resolution: null,
    execute: async () => { throw new Error('目录查询不得调用执行后端') },
  })
  assert.equal(result.successful, true, JSON.stringify(result))
  assert.equal(calls.length, 3)
  assert.deepEqual(result.value, {
    files: [{ id: 7, displayName: 'Alpha Beta', ext: 'TXT', space: 'personal', workspaceDirectoryId: null,
      projectId: null, projectName: null, projectColor: null, stageName: null, folderId: null, folderName: null,
      mindMapId: null, size: '1 B', sizeBytes: 1, mimeType: 'text/plain', createdAt: '2026-11-19T10:00:00Z',
      deletedAt: null, imgWidth: null, imgHeight: null, version: 1 }],
    folders: [], files_has_more: false, next_file_cursor: null, total: 9,
    folders_has_more: false, next_folder_cursor: null, shown: 1, truncated: false,
  })
})
