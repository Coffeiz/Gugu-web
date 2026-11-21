import { createSaveAttachmentTool } from '@gugu/core/tools'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Kysely, PostgresDialect } from 'kysely'
import type { SqlDataRuntime } from '@gugu/core/data'
import type { FileUploadOperations } from '../../../src/modules/files/upload.js'
import { createWebAgentSaveAttachmentPort } from '../../../src/modules/agent/tools/files/save.js'
import { createAgentToolRegistry } from '../../../src/modules/agent/tools/registry.js'

test('save_attachment 经 Host adapter 暂存真实附件字节、绑定租约并按收据恢复', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-agent-save-attachment-'))
  const ownerId = randomUUID(), identity = { ownerId, sessionId: '18', runId: 'save-attachment-run' }
  const db = new Kysely<Record<string, never>>({ dialect: new PostgresDialect({ pool: { async end() {} } as never }) })
  const sourcePath = join(root, 'incoming.txt')
  await writeFile(sourcePath, '附件正文')
  let active = true, latestQueries = 0, downloadCalls = 0, storeCalls = 0, writes = 0
  const pool = { async end() {}, async query(sql: string, values: unknown[]) {
    if (sql.includes('FROM chat_attachments')) {
      latestQueries++
      assert.deepEqual(values, [ownerId, 18])
      return { rowCount: 1, rows: [{ attach_id: 'attachment-1' }] }
    }
    assert.match(sql, /agent_run_dispatch/u)
    assert.deepEqual(values, [ownerId, '18', identity.runId, 'lease-token', 5])
    return { rowCount: active ? 1 : 0, rows: active ? [{}] : [] }
  } }
  const receipts = new Map<string, Record<string, unknown>>()
  const upload: FileUploadOperations = {
    async getUploadCapacity(owner, input) {
      assert.equal(owner, ownerId)
      assert.deepEqual(input, { space: 'personal', projectId: null, folderId: null, workspaceDirectoryId: null,
        stageName: '', mindMapId: null, onConflict: 'keep_both', overwriteFileId: null })
      return 1024 * 1024
    },
    async store(owner, staged, metadata, operation) {
      storeCalls++
      assert.equal(owner, ownerId)
      assert.equal(metadata.undoContextId, `agent:${identity.sessionId}:${identity.runId}`)
      assert.equal(staged.originalName, 'draft.txt')
      assert.equal(staged.input.onConflict, 'keep_both')
      assert.equal((await readFile(staged.path)).toString('utf8'), '附件正文')
      assert.equal(operation?.receipt.method, 'agent.file.save_uploaded_file')
      await operation?.authorize({ async query(sql: string, values: unknown[]) {
        return pool.query(sql, values)
      } } as never)
      const existing = receipts.get(operation!.receipt.operationId)
      if (existing) return { file: existing, replayed: true }
      writes++
      const file = { id: 41, displayName: 'draft', ext: 'txt', sizeBytes: Buffer.byteLength('附件正文'), space: 'personal', folderId: null, logicalPath: '/personal/draft.txt' }
      receipts.set(operation!.receipt.operationId, file)
      return { file, replayed: false }
    },
  }
  const lease = { identity, token: 'lease-token', fence: 5,
    input: { v: 2, source: 'web', accessVersion: 'a'.repeat(64) } } as never
  const port = createWebAgentSaveAttachmentPort({ pool: pool as never, db: db as never, upload, lease,
    async downloadAttachment(owner, attachId) {
      downloadCalls++
      assert.equal(owner, ownerId)
      assert.equal(attachId, 'attachment-1')
      return { fileName: 'draft.txt', ext: 'txt', mimeType: 'text/plain', handle: await open(sourcePath, 'r') }
    } })
  const registry = createAgentToolRegistry({ core: {} as SqlDataRuntime, saveAttachment: createSaveAttachmentTool(port),
    authorize: async (current, name) => current.ownerId === ownerId && name === 'save_attachment' })
  const call = { id: 'save-attachment', name: 'save_attachment', input: { source: 'latest' } }
  const scope = { identity, roundId: 'round', signal: new AbortController().signal, resolution: null,
    execute: async () => { throw new Error('不允许执行宿主 Shell') } }
  try {
    assert.ok((await registry.capabilities(identity)).some(item => item.name === 'save_attachment'))
    const first = await registry.tools.dispatch(call, scope)
    assert.deepEqual(first, { kind: 'completed', successful: true, mutated: true,
      value: { file_id: 41, name: 'draft.txt', path: '/personal/draft.txt', size: Buffer.byteLength('附件正文'), space: 'personal' } })
    const replay = await registry.tools.dispatch(call, scope)
    assert.deepEqual(replay, { kind: 'completed', successful: true, mutated: false,
      value: { file_id: 41, name: 'draft.txt', path: '/personal/draft.txt', size: Buffer.byteLength('附件正文'), space: 'personal' } })
    active = false
    const stale = await registry.tools.dispatch({ ...call, id: 'stale' }, scope)
    assert.equal(stale.kind, 'completed')
    if (stale.kind === 'completed') assert.equal(stale.successful, false)
    assert.equal(latestQueries, 3)
    assert.equal(downloadCalls, 3)
    assert.equal(storeCalls, 3)
    assert.equal(writes, 1)
  } finally { await db.destroy(); await rm(root, { recursive: true, force: true }) }
})

test('save_attachment workspace 从可信会话绑定解析目录并在写入事务复核重绑定', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-agent-save-workspace-'))
  const ownerId = randomUUID(), identity = { ownerId, sessionId: '29', runId: 'save-workspace-run' }
  const sourcePath = join(root, 'incoming.txt')
  await writeFile(sourcePath, '工作区附件')
  let active = true, directoryId = 73, stores = 0, writes = 0
  const pool = { async end() {}, async query(sql: string, values: unknown[]) {
    if (sql.includes('agent_run_dispatch')) {
      assert.deepEqual(values, [ownerId, '29', identity.runId, 'lease-token', 6])
      return { rowCount: active ? 1 : 0, rows: active ? [{}] : [] }
    }
    if (sql.includes('FROM conversation_sessions')) {
      assert.deepEqual(values, [29, ownerId])
      return { rowCount: 1, rows: [{ workspace_id: 22 }] }
    }
    if (sql.includes('FROM workspaces'))
      return { rowCount: 1, rows: [{ id: 22, name: '工作区', kind: 'directory', folder_id: null,
        project_id: null, directory_id: directoryId, enabled: true }] }
    if (sql.includes('FROM workspace_directories'))
      return { rowCount: 1, rows: [{ id: directoryId, directory_name: '默认目录' }] }
    throw new Error('未预期的 SQL')
  } }
  const db = new Kysely<Record<string, never>>({ dialect: new PostgresDialect({ pool: pool as never }) })
  const upload: FileUploadOperations = {
    async getUploadCapacity(owner, input) {
      assert.equal(owner, ownerId)
      assert.equal(input.space, 'workspace')
      assert.equal(input.workspaceDirectoryId, 73)
      return 1024 * 1024
    },
    async store(owner, staged, _metadata, operation) {
      stores++
      assert.equal(owner, ownerId)
      assert.equal(staged.input.space, 'workspace')
      assert.equal(staged.input.workspaceDirectoryId, 73)
      assert.equal((await readFile(staged.path)).toString('utf8'), '工作区附件')
      if (stores === 2) directoryId = 74
      await operation?.authorize({ async query(sql: string, values: unknown[]) { return pool.query(sql, values) } } as never)
      writes++
      return { file: { id: 52, displayName: 'draft', ext: 'txt', sizeBytes: Buffer.byteLength('工作区附件') }, replayed: false }
    },
  }
  const lease = { identity, token: 'lease-token', fence: 6,
    input: { v: 2, source: 'web', accessVersion: 'b'.repeat(64) } } as never
  const port = createWebAgentSaveAttachmentPort({ pool: pool as never, db: db as never, upload, lease,
    async downloadAttachment(_owner, _attachId) {
      return { fileName: 'draft.txt', ext: 'txt', mimeType: 'text/plain', handle: await open(sourcePath, 'r') }
    } })
  const registry = createAgentToolRegistry({ core: {} as SqlDataRuntime, saveAttachment: createSaveAttachmentTool(port),
    authorize: async (current, name) => current.ownerId === ownerId && name === 'save_attachment' })
  const scope = { identity, roundId: 'round', signal: new AbortController().signal, resolution: null,
    execute: async () => { throw new Error('不允许执行宿主 Shell') } }
  const call = (id: string) => ({ id, name: 'save_attachment', input: { attach_id: 'workspace-attachment', space: 'workspace' } })
  try {
    const saved = await registry.tools.dispatch(call('workspace-save'), scope)
    assert.deepEqual(saved, { kind: 'completed', successful: true, mutated: true,
      value: { file_id: 52, name: 'draft.txt', size: Buffer.byteLength('工作区附件'), space: 'workspace' } })
    const rebound = await registry.tools.dispatch(call('workspace-rebound'), scope)
    assert.equal(rebound.kind, 'completed')
    if (rebound.kind === 'completed') assert.equal(rebound.successful, false)
    assert.equal(stores, 2)
    assert.equal(writes, 1)
  } finally {
    await db.destroy()
    await rm(root, { recursive: true, force: true })
  }
})

test('save_attachment folder_path 按 owner 和文件空间解析为正式文件夹 ID', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-agent-save-folder-path-'))
  const ownerId = randomUUID(), identity = { ownerId, sessionId: '34', runId: 'save-folder-path-run' }
  const sourcePath = join(root, 'incoming.txt')
  await writeFile(sourcePath, '子目录附件')
  const pool = { async end() {}, async query(sql: string, values: unknown[]) {
    if (sql.includes('WITH RECURSIVE scoped_folders')) {
      assert.deepEqual(values, [ownerId, null, null, ['资料', '项目']])
      return { rowCount: 1, rows: [{ id: 91 }] }
    }
    assert.match(sql, /agent_run_dispatch/u)
    return { rowCount: 1, rows: [{}] }
  } }
  const db = new Kysely<Record<string, never>>({ dialect: new PostgresDialect({ pool: pool as never }) })
  const upload: FileUploadOperations = {
    async getUploadCapacity(_owner, input) {
      assert.equal(input.space, 'personal')
      assert.equal(input.folderId, 91)
      return 1024
    },
    async store(_owner, staged) {
      assert.equal((await readFile(staged.path)).toString('utf8'), '子目录附件')
      assert.equal(staged.input.folderId, 91)
      return { file: { id: 92, displayName: '资料', ext: 'txt', sizeBytes: Buffer.byteLength('子目录附件'),
        logicalPath: '/personal/资料/项目/资料.txt' }, replayed: false }
    },
  }
  const lease = { identity, token: 'lease-token', fence: 7,
    input: { v: 2, source: 'web', accessVersion: 'c'.repeat(64) } } as never
  const port = createWebAgentSaveAttachmentPort({ pool: pool as never, db: db as never, upload, lease,
    async downloadAttachment() { return { fileName: '资料.txt', ext: 'txt', mimeType: 'text/plain', handle: await open(sourcePath, 'r') } } })
  try {
    const result = await port.save(identity, { source: 'attach_id', attach_id: 'attachment-1', space: 'personal', folder_path: '资料/项目' },
      'round', { id: 'folder-path-call', name: 'save_attachment', input: {} }, AbortSignal.timeout(5_000))
    assert.deepEqual(result, { kind: 'saved', mutated: true, value: { file_id: 92, name: '资料.txt',
      path: '/personal/资料/项目/资料.txt', size: Buffer.byteLength('子目录附件'), space: 'personal', folder_id: 91 } })
  } finally {
    await db.destroy()
    await rm(root, { recursive: true, force: true })
  }
})
