import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { createAuthorizedWebAgentProductionRagRunPorts } from '../../src/domains/agent-sessions/tools/agent-rag-production-ports.js'
import { createWebAgentFileReadPort } from '../../src/domains/agent-sessions/tools/agent-file-read.js'

test('read_file 生产 registry 只读同 owner 文件并在 lease 撤销后拒绝', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-agent-file-read-'))
  try {
    const ownerId = randomUUID(), sessionId = '73', runId = 'file-read-run'
    const identity = { ownerId, sessionId, runId }
    const relativePath = `${ownerId}/personal/notes.txt`
    await mkdir(join(root, ownerId, 'personal'), { recursive: true })
    await writeFile(join(root, relativePath), '第一行\r\n第二行\n第三行', 'utf8')
    let active = true
    let fileQueries = 0
    const pool = { async query(sql: string, values: unknown[]) {
      if (sql.includes('agent_run_dispatch')) return { rowCount: active ? 1 : 0, rows: [{}] }
      assert.match(sql, /FROM files WHERE id=\$1 AND user_id=\$2 AND deleted_at IS NULL/u)
      assert.equal(values[1], ownerId)
      fileQueries++
      if (values[0] !== 7) return { rowCount: 0, rows: [] }
      return { rowCount: 1, rows: [{ id: 7, user_id: ownerId, storage_key: relativePath, display_name: 'notes', ext: 'txt' }] }
    } }
    const lease = { identity, token: 'synthetic-token', fence: 2, mode: 'start' as const, cancelRequested: false,
      input: { v: 2 as const, source: 'web' as const, accessVersion: 'b'.repeat(64), userMessageId: 3, locale: 'zh-CN' as const, origin: null } }
    const ports = createAuthorizedWebAgentProductionRagRunPorts({
      core: {} as never, pool: pool as never, storageRoot: root, lease,
      selection: { contextPolicy: { loadOwnerContext: true, memoryEnabled: true }, contextScopeKey: lease.input.accessVersion, modelIdentity: 'synthetic-model' },
      enabled: async () => true, enabledFileRead: true, readFile: createWebAgentFileReadPort(pool as never, root, lease),
    })
    assert.equal((await ports.configuration(identity, new AbortController().signal)).toolNames.includes('read_file'), true)
    const scope = { identity, roundId: '1', signal: new AbortController().signal, resolution: null,
      execute: async () => { throw new Error('read_file 不得执行宿主命令') } }
    const result = await ports.toolRegistry.tools.dispatch({ id: 'read-lines', name: 'read_file', input: { file_id: 7, target_lines: '2-3' } }, scope)
    assert.deepEqual(result.kind === 'completed' ? result.value : null, {
      file_id: 7, name: 'notes.txt', content: '第二行\n第三行', numbered_content: '2: 第二行\n3: 第三行',
      line_range: { start: 2, end: 3 }, _source_size_bytes: Buffer.byteLength('第一行\r\n第二行\n第三行'),
    })
    const missing = await ports.toolRegistry.tools.dispatch({ id: 'missing', name: 'read_file', input: { file_id: 8 } }, scope)
    assert.equal(missing.kind === 'completed' && JSON.stringify(missing.value).includes('文件不存在或无权访问'), true)
    const beforeRevocation = fileQueries
    active = false
    const revoked = await ports.toolRegistry.tools.dispatch({ id: 'after-revoke', name: 'read_file', input: { file_id: 7 } }, scope)
    assert.equal(revoked.kind === 'completed' && revoked.executed, false)
    assert.equal(fileQueries, beforeRevocation, 'lease 撤销后不得查询或打开文件')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

