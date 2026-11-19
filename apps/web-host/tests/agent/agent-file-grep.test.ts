import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { SqlDataRuntime } from '@gugu/core/data'
import { createAgentToolRegistry } from '../../src/modules/agent-sessions/tools/agent-tool-registry.js'
import { createWebAgentFileGrepPort } from '../../src/modules/agent-sessions/tools/agent-file-grep.js'

const identity = { ownerId: '00000000-0000-4000-8000-000000000001', sessionId: '71', runId: 'grep-synthetic' }
const lease = { identity, token: 'lease-synthetic', fence: 5, mode: 'start', cancelRequested: false,
  input: { v: 2, source: 'web' } } as never

test('grep 经 Host owner 查询、packages/fs 文件读取和生产 ToolRegistry 返回实际命中', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-agent-file-grep-'))
  try {
    const storageKey = `${identity.ownerId}/notes/a.txt`
    await mkdir(join(root, identity.ownerId, 'notes'), { recursive: true })
    await writeFile(join(root, storageKey), '上文\n可信命中 needle\n下文', 'utf8')
    const queries: Array<{ sql: string; values: unknown[] }> = []
    const pool = { async query(sql: string, values: unknown[] = []) {
      queries.push({ sql, values })
      if (sql.includes('WITH RECURSIVE folder_paths')) return { rows: [{
        id: 15, display_name: 'a', ext: 'txt', space: 'personal', project_id: null, folder_id: null,
        workspace_directory_id: null, project_name: null, directory_name: null, folder_path: null,
        size_bytes: '40', mime_type: 'text/plain',
      }] }
      return { rows: [{ storage_key: storageKey, ext: 'txt', mime_type: 'text/plain', size_bytes: '40' }] }
    } }
    const port = createWebAgentFileGrepPort(pool as never, root, lease)
    const registry = createAgentToolRegistry({ core: {} as SqlDataRuntime, fileGrep: port,
      authorize: async (current, name) => current.ownerId === identity.ownerId && name === 'grep' })
    const result = await registry.tools.dispatch({ id: 'grep-call', name: 'grep', input: { query: 'NEEDLE', path: '/personal' } }, {
      identity, roundId: 'round', signal: new AbortController().signal, resolution: null,
      execute: async () => { throw new Error('文件 grep 不得访问 Shell') },
    })
    assert.deepEqual(queries.map(query => query.values), [[identity.ownerId], [15, identity.ownerId]])
    assert.match(queries[0]!.sql, /file\.user_id=\$1/u)
    assert.match(queries[1]!.sql, /user_id=\$2/u)
    assert.equal(result.kind, 'completed')
    if (result.kind !== 'completed') return
    assert.equal(result.successful, true)
    assert.deepEqual(result.value, {
      success: true, query: 'NEEDLE', path: '/personal', context_lines: 2, scanned_files: 1, skipped_files: 0,
      matched_files: 1, total_matches: 1, truncated: false, truncation_reasons: [], results: [{
        file_id: 15, name: 'a.txt', space: 'personal', path: '/personal/a.txt', project_id: null, folder_id: null,
        workspace_directory_id: null, matches: [{ line: 2, text: '可信命中 needle', context: [
          { line: 1, text: '上文' }, { line: 2, text: '可信命中 needle' }, { line: 3, text: '下文' },
        ] }],
      }],
    })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('grep adapter 在访问数据库和磁盘前拒绝身份不匹配或非 Web 来源', async () => {
  let calls = 0
  const pool = { async query() { calls++; return { rows: [] } } }
  const port = createWebAgentFileGrepPort(pool as never, tmpdir(), lease)
  await assert.rejects(port.list({ ...identity, ownerId: '00000000-0000-4000-8000-000000000002' }, new AbortController().signal), /授权已失效/u)
  assert.equal(calls, 0)
  assert.throws(() => createWebAgentFileGrepPort(pool as never, tmpdir(),
    { ...lease, input: { v: 2, source: 'telegram' } } as never), /来源无法验证/u)
})
