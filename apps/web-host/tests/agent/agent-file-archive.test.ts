import assert from 'node:assert/strict'
import test from 'node:test'
import { CoreError } from '@gugu/core'
import type { Pool, PoolClient } from 'pg'
import type { FileArchiveOperations } from '../../src/modules/files/file-archive.js'
import { createWebAgentFileArchivePort } from '../../src/modules/agent-sessions/tools/agent-file-archive.js'
import { createWebAgentRagRunAuthorization } from '../../src/modules/agent-sessions/tools/agent-rag-run-authorization.js'

const identity = { ownerId: '00000000-0000-4000-8000-000000000001', sessionId: '17', runId: 'run-archive' }
const lease = {
  identity, input: { v: 2, source: 'web' }, token: 'dispatch-token', fence: 3,
} as unknown as import('../../src/modules/agent-sessions/persistence/agent-run-dispatch-postgres.js').AgentDispatchLease

function harness(active = true) {
  const statements: string[] = []
  const pool = { async query(sql: string) {
    statements.push(sql)
    return { rowCount: active ? 1 : 0, rows: active ? [{}] : [] }
  } } as unknown as Pick<Pool, 'query'>
  const calls: unknown[] = []
  const operations: FileArchiveOperations = {
    async archive(owner, input, metadata, authorize, operation) {
      await authorize?.({ query: async (sql: string) => { statements.push(String(sql)); return { rowCount: active ? 1 : 0, rows: active ? [{}] : [] } } } as unknown as Pick<PoolClient, 'query'>)
      calls.push({ method: 'archive', owner, input, metadata, operation })
      return { id: 41, displayName: '归档', ext: 'zip' }
    },
    async unarchive(owner, input, metadata, authorize, operation) {
      await authorize?.({ query: async (sql: string) => { statements.push(String(sql)); return { rowCount: active ? 1 : 0, rows: active ? [{}] : [] } } } as unknown as Pick<PoolClient, 'query'>)
      calls.push({ method: 'unarchive', owner, input, metadata, operation })
      return { created_count: 2, file_count: 1, folder_count: 1, skipped_count: 0, rejected_count: 0, file_ids: [52], folder_ids: [61] }
    },
  }
  return { port: createWebAgentFileArchivePort(pool, operations, lease), statements, calls }
}

test('文件归档 Host 端口把可信 owner、目标空间输入和取消/Undo metadata 传给领域服务', async () => {
  const h = harness()
  const compressCall = { id: 'tool-call-1', name: 'compress_files', input: { entries: [{ kind: 'file', id: 4 }, { kind: 'folder', id: 8 }], folder_id: 12, archive_name: '资料' } } as import('@gugu/core/agent').ToolCall
  const compressed = await h.port.compress(identity, {
    entries: [{ kind: 'file', id: 4 }, { kind: 'folder', id: 8 }], folder_id: 12, archive_name: '资料',
  }, 'run-archive:0', compressCall, new AbortController().signal)
  assert.deepEqual(compressed, { file_id: 41, name: '归档.zip' })
  assert.deepEqual(h.calls[0], { method: 'archive', owner: identity.ownerId,
    input: { fileIds: [4], folderIds: [8], folderId: 12, name: '资料' },
    metadata: { idempotencyKey: null, undoContextId: 'agent:17:run-archive', clientId: null },
    operation: h.calls[0] && (h.calls[0] as { operation: unknown }).operation })
  const archiveOperation = (h.calls[0] as { operation: { receipt: { operationId: string; fingerprint: string; method: string }; signal: AbortSignal } }).operation
  assert.equal(archiveOperation.receipt.method, 'agent.file.compress')
  assert.match(archiveOperation.receipt.operationId, /^[0-9a-f-]{36}$/u)
  assert.match(archiveOperation.receipt.fingerprint, /^[0-9a-f]{64}$/u)
  assert.ok(archiveOperation.signal instanceof AbortSignal)
  const extractCall = { id: 'tool-call-2', name: 'extract_files', input: { file_id: 41, format: 'zip' } } as import('@gugu/core/agent').ToolCall
  const extracted = await h.port.extract(identity, { file_id: 41, format: 'zip' }, 'run-archive:1', extractCall, new AbortController().signal)
  assert.deepEqual(extracted, { created_count: 2, file_count: 1, folder_count: 1, skipped_count: 0,
    rejected_count: 0, file_ids: [52], folder_ids: [61] })
  assert.deepEqual(h.calls[1], { method: 'unarchive', owner: identity.ownerId,
    input: { fileId: 41, format: 'zip' }, metadata: { idempotencyKey: null, undoContextId: 'agent:17:run-archive', clientId: null },
    operation: (h.calls[1] as { operation: unknown }).operation })
  const extractOperation = (h.calls[1] as { operation: { receipt: { method: string }; signal: AbortSignal } }).operation
  assert.equal(extractOperation.receipt.method, 'agent.file.extract')
  assert.ok(extractOperation.signal instanceof AbortSignal)
  assert.equal(h.statements.length, 4)
})

test('归档端口在事务授权失效或身份不符时不调用领域操作', async () => {
  const stale = harness(false)
  await assert.rejects(stale.port.compress(identity, { entries: [{ kind: 'file', id: 4 }] }, 'round',
    { id: 'call', name: 'compress_files', input: {} } as import('@gugu/core/agent').ToolCall, new AbortController().signal), /授权已失效/u)
  assert.equal(stale.calls.length, 0)
  const active = harness()
  await assert.rejects(active.port.extract({ ...identity, ownerId: '00000000-0000-4000-8000-000000000002' },
    { file_id: 41 }, 'round', { id: 'call', name: 'extract_files', input: {} } as import('@gugu/core/agent').ToolCall,
    new AbortController().signal), /授权已失效/u)
  assert.equal(active.calls.length, 0)
})

test('生产权限配置只有显式注入归档端口后才授权归档工具', async () => {
  const pool = { async query() { return { rowCount: 1, rows: [{}] } } } as unknown as Pick<Pool, 'query'>
  const disabled = createWebAgentRagRunAuthorization(pool, lease)
  const enabled = createWebAgentRagRunAuthorization(pool, lease, { enabledFileArchive: true })
  assert.equal(await disabled.authorize(identity, 'compress_files'), false)
  assert.equal(await disabled.authorize(identity, 'extract_files'), false)
  assert.equal(await enabled.authorize(identity, 'compress_files'), true)
  assert.equal(await enabled.authorize(identity, 'extract_files'), true)
})

test('文件归档从已提交的 owner 收据恢复结果，缺失时保持 unknown', async () => {
  let persisted: { method: string; fingerprint: string; result_json: string } | null = null
  const pool = { async query(sql: string) {
    if (sql.includes('FROM core_operation_receipts')) return { rowCount: persisted ? 1 : 0, rows: persisted ? [persisted] : [] }
    return { rowCount: 1, rows: [{}] }
  } } as unknown as Pick<Pool, 'query'>
  const operations: FileArchiveOperations = {
    async archive(_owner, _input, _metadata, authorize, operation) {
      await authorize?.({ query: async () => ({ rowCount: 1, rows: [{}] }) } as unknown as Pick<PoolClient, 'query'>)
      persisted = { method: operation!.receipt.method, fingerprint: operation!.receipt.fingerprint,
        result_json: JSON.stringify({ id: 88, displayName: '已归档', ext: 'zip' }) }
      return JSON.parse(persisted.result_json)
    },
    async unarchive() { throw new Error('不应调用') },
  }
  const port = createWebAgentFileArchivePort(pool, operations, lease)
  const call = { id: 'recover-1', name: 'compress_files', input: { entries: [{ kind: 'file', id: 7 }] } } as import('@gugu/core/agent').ToolCall
  const roundId = 'run-archive:recover'
  assert.deepEqual(await port.reconcile!({ ...identity, roundId }, call), { kind: 'unknown' })
  await port.compress(identity, { entries: [{ kind: 'file', id: 7 }] }, roundId, call, new AbortController().signal)
  assert.deepEqual(await port.reconcile!({ ...identity, roundId }, call), {
    kind: 'completed', successful: true, mutated: true, value: { success: true, file_id: 88, name: '已归档.zip' },
  })
})

test('提交结果未知时文件归档端口交给 Run 收据恢复，不伪装为普通失败', async () => {
  const pool = { async query() { return { rowCount: 1, rows: [{}] } } } as unknown as Pick<Pool, 'query'>
  const operations: FileArchiveOperations = {
    async archive() { throw new CoreError('storage_error', '压缩提交结果未知，请检查压缩结果') },
    async unarchive() { throw new CoreError('storage_error', '解压提交结果未知，请检查解压结果') },
  }
  const port = createWebAgentFileArchivePort(pool, operations, lease)
  const result = await port.compress(identity, { entries: [{ kind: 'file', id: 1 }] }, 'round',
    { id: 'call', name: 'compress_files', input: {} } as import('@gugu/core/agent').ToolCall, new AbortController().signal)
  assert.deepEqual(result, { kind: 'unknown' })
})
