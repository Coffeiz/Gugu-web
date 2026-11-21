import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CoreError } from '@gugu/core'
import { createToolRegistry, createDeleteFileTool, createDeleteFolderTool } from '@gugu/core/tools'
import type { AgentDispatchLease } from '../../../../src/modules/agent/run/dispatch.js'
import type { FolderDeleteOperations } from '../../../../src/modules/files/folders/delete.js'
import type { FileDeleteOperations } from '../../../../src/modules/files/trash/service.js'
import { createWebAgentFileDeletePort, createWebAgentFileFolderDeletePort } from '../../../../src/modules/agent/tools/files/delete.js'

const identity = { ownerId: '00000000-0000-4000-8000-000000000001', sessionId: '33', runId: 'folder-delete-run' }
const lease = { identity, token: 'lease', fence: 1, input: { v: 2, source: 'web' }, mode: 'start', cancelRequested: false } as AgentDispatchLease
const scope = { identity, roundId: 'round-1', signal: new AbortController().signal, resolution: null,
  execute: async () => { throw new Error('文件夹工具不得执行宿主 Shell') } }

test('真实 ToolRegistry dispatch 将可信 owner、lease 与持久回执交给文件夹软删事务', async () => {
  const queries: unknown[][] = [], removals: unknown[][] = []
  const pool = { async query(_sql: string, values: unknown[]) { queries.push(values); return { rows: [{}], rowCount: 1 } } }
  const operations: FolderDeleteOperations = { async remove(ownerId, folderId, metadata, operation) {
    removals.push([ownerId, folderId, metadata, operation?.receipt])
    await operation?.authorize({ query: async () => ({ rows: [{}], rowCount: 1 }) } as never)
    return { success: true, deleted_folder_id: folderId, note: '文件夹「我的资料」已删除，其中的文件已移入回收站（30 天内可恢复）',
      _file_op: { op: 'remove', kind: 'folder', id: folderId } }
  } }
  const registry = createToolRegistry({ groups: [{ id: 'files', name: '文件', tools: [createDeleteFolderTool(createWebAgentFileFolderDeletePort(pool as never, operations, lease))] }], authorize: async () => true })
  const result = await registry.tools.dispatch({ id: 'delete', name: 'delete_folder', input: { folder_id: 72 } }, scope)
  assert.deepEqual(queries, [[identity.ownerId, identity.sessionId, identity.runId, lease.token, lease.fence]])
  assert.deepEqual(removals.map(([owner, folderId, metadata]) => [owner, folderId, metadata]),
    [[identity.ownerId, 72, { undoContextId: identity.sessionId, origin: null }]])
  const receipt = removals[0]![3] as { method: string; operationId: string; fingerprint: string }
  assert.equal(receipt.method, 'agent.file.delete_folder')
  assert.match(receipt.operationId, /^[0-9a-f-]{36}$/u)
  assert.match(receipt.fingerprint, /^[0-9a-f]{64}$/u)
  assert.deepEqual(result.kind === 'completed' ? result.value : null, {
    success: true, deleted_folder_id: 72,
    note: '文件夹「我的资料」已删除，其中的文件已移入回收站（30 天内可恢复）',
    _file_op: { op: 'remove', kind: 'folder', id: 72 },
  })
})

test('文件夹删除提交未知后只通过 owner 收据恢复原结果', async () => {
  let stored: { method: string; fingerprint: string; result_json: string } | null = null
  let mutationCount = 0
  const pool = { async query(sql: string) {
    if (sql.includes('FROM core_operation_receipts')) return { rows: stored ? [stored] : [], rowCount: stored ? 1 : 0 }
    return { rows: [{}], rowCount: 1 }
  } }
  const resultValue = { success: true, deleted_folder_id: 72, note: '已移入回收站', _file_op: { op: 'remove', kind: 'folder', id: 72 } }
  const operations: FolderDeleteOperations = { async remove(_owner, _id, _metadata, operation) {
    await operation?.authorize({ query: async () => ({ rows: [{}], rowCount: 1 }) } as never)
    mutationCount++
    stored = { method: operation!.receipt.method, fingerprint: operation!.receipt.fingerprint, result_json: JSON.stringify(resultValue) }
    throw new CoreError('storage_error', '文件夹删除提交结果未知')
  } }
  const port = createWebAgentFileFolderDeletePort(pool as never, operations, lease)
  const call = { id: 'delete-recover', name: 'delete_folder', input: { folder_id: 72 } }
  const roundId = 'folder-delete-run:1'
  const registry = createToolRegistry({ groups: [{ id: 'files', name: '文件', tools: [createDeleteFolderTool(port)] }], authorize: async () => true })
  assert.deepEqual(await registry.tools.dispatch(call, { ...scope, roundId }), { kind: 'unknown' })
  assert.equal(mutationCount, 1)
  assert.deepEqual(await registry.tools.reconcile(call, { ...identity, roundId }), {
    kind: 'completed', successful: true, mutated: false, value: resultValue,
  })
  assert.equal(mutationCount, 1, '重放必须只读持久回执，不能再次执行文件夹删除')
})

test('拒绝跨 lease 身份，且事务授权失效时不执行文件夹删除', async () => {
  let queryCount = 0, removeCount = 0
  let transactionAuthorization = false
  const operations: FolderDeleteOperations = { async remove(_owner, _id, _metadata, operation) {
    await operation?.authorize({ query: async () => ({ rows: [], rowCount: transactionAuthorization ? 1 : 0 }) } as never)
    removeCount++
    return { success: true, deleted_folder_id: 72 }
  } }
  const port = createWebAgentFileFolderDeletePort({ async query() { queryCount++; return { rows: [{}], rowCount: 1 } } } as never, operations, lease)
  await assert.rejects(port.remove({ ...identity, runId: 'other-run' }, 72, 'round',
    { id: 'call', name: 'delete_folder', input: { folder_id: 72 } } as never, new AbortController().signal))
  assert.equal(queryCount, 0)
  await assert.rejects(port.remove(identity, 72, 'round',
    { id: 'call', name: 'delete_folder', input: { folder_id: 72 } } as never, new AbortController().signal), /授权已失效/)
  assert.equal(removeCount, 0)
  transactionAuthorization = true
  await port.remove(identity, 72, 'round',
    { id: 'call-revoked-after-preflight', name: 'delete_folder', input: { folder_id: 72 } } as never, new AbortController().signal)
  assert.equal(removeCount, 1)
  assert.equal(queryCount, 2)
})

test('delete_file 经 Web lease 注册器只软删 owner 文件并保留 Undo 上下文', async () => {
  const queries: Array<{ sql: string; values: unknown[] }> = [], removals: unknown[][] = []
  const resultValue = { success: true, file_id: 72, name: '计划.md', note: '已移入回收站，30 天内可还原',
    _file_op: { op: 'remove', kind: 'file', id: 72 } }
  const pool = { async query(sql: string, values: unknown[]) {
    queries.push({ sql, values })
    if (sql.includes('agent_run_dispatch')) return { rows: [{}], rowCount: 1 }
    return { rows: [], rowCount: 0 }
  } }
  const operations: FileDeleteOperations = { async remove(...args) {
    removals.push(args)
    const operation = args[4]
    await operation?.authorize({ query: async () => ({ rows: [{}], rowCount: 1 }) } as never)
    return { result: resultValue, replayed: false }
  } }
  const port = createWebAgentFileDeletePort(pool as never, operations, lease)
  const registry = createToolRegistry({ groups: [{ id: 'files', name: '文件', tools: [createDeleteFileTool(port)] }], authorize: async () => true })
  const call = { id: 'delete', name: 'delete_file', input: { file_id: 72 } }
  const result = await registry.tools.dispatch(call, scope)
  assert.deepEqual(queries.map(query => query.values), [
    [identity.ownerId, identity.sessionId, identity.runId, lease.token, lease.fence],
  ])
  assert.deepEqual(removals.map(([owner, id, undo, client]) => [owner, id, undo, client]),
    [[identity.ownerId, 72, identity.sessionId, null]])
  const operation = removals[0]![4] as { receipt: { method: string; operationId: string; fingerprint: string } }
  assert.equal(operation.receipt.method, 'agent.file.delete_file')
  assert.match(operation.receipt.operationId, /^[0-9a-f-]{36}$/u)
  assert.match(operation.receipt.fingerprint, /^[0-9a-f]{64}$/u)
  assert.deepEqual(result.kind === 'completed' ? result.value : null, {
    ...resultValue,
  })
})

test('delete_file 通过当前 lease 的文件库清单解析逻辑路径，再调用 owner 删除事务', async () => {
  const removals: unknown[][] = []
  const pool = { async query() { return { rows: [{}], rowCount: 1 } } }
  const operations: FileDeleteOperations = { async remove(...args) {
    removals.push(args)
    await args[4]?.authorize({ query: async () => ({ rows: [{}], rowCount: 1 }) } as never)
    return { result: { success: true, file_id: 92, name: '计划.md', note: '已移入回收站' }, replayed: false }
  } }
  let listed = 0
  const files = { async list(current: typeof identity) {
    listed++
    assert.equal(current.ownerId, identity.ownerId)
    return [{ file_id: 92, name: '计划.md', space: 'personal' as const, path: '/personal/计划.md',
      project_id: null, folder_id: null, workspace_directory_id: null, size_bytes: 10, is_text: true }]
  } }
  const port = createWebAgentFileDeletePort(pool as never, operations, lease, files)
  const registry = createToolRegistry({ groups: [{ id: 'files', name: '文件', tools: [createDeleteFileTool(port)] }], authorize: async () => true })
  const result = await registry.tools.dispatch({ id: 'delete-path', name: 'delete_file', input: { file: '/personal/计划.md' } }, scope)
  assert.equal(listed, 1)
  assert.deepEqual(removals.map(([owner, id, undo]) => [owner, id, undo]), [[identity.ownerId, 92, identity.sessionId]])
  assert.deepEqual(result.kind === 'completed' ? result.value : null, {
    success: true, file_id: 92, name: '计划.md', note: '已移入回收站',
  })
})

test('delete_file 提交结果未知后通过 owner 收据恢复结果并避免重复删除', async () => {
  let stored: { method: string; fingerprint: string; result_json: string } | null = null
  let mutations = 0
  const pool = { async query(sql: string) {
    if (sql.includes('FROM core_operation_receipts')) return { rows: stored ? [stored] : [], rowCount: stored ? 1 : 0 }
    return { rows: [{}], rowCount: 1 }
  } }
  const value = { success: true, file_id: 73, name: '旧稿.txt', note: '已移入回收站，30 天内可还原',
    _file_op: { op: 'remove', kind: 'file', id: 73 } }
  const operations: FileDeleteOperations = { async remove(_owner, _id, _undo, _client, operation) {
    await operation?.authorize({ query: async () => ({ rows: [{}], rowCount: 1 }) } as never)
    if (!stored) {
      mutations++
      stored = { method: operation!.receipt.method, fingerprint: operation!.receipt.fingerprint, result_json: JSON.stringify(value) }
      throw new CoreError('storage_error', '文件删除提交结果未知')
    }
    return { result: value, replayed: true }
  } }
  const port = createWebAgentFileDeletePort(pool as never, operations, lease)
  const call = { id: 'delete-unknown', name: 'delete_file', input: { file_id: 73 } }
  const roundId = 'folder-delete-run:2'
  assert.deepEqual(await port.remove(identity, 73, roundId, call, new AbortController().signal), { kind: 'unknown' })
  assert.deepEqual(await port.reconcile!({ ...identity, roundId }, call), {
    kind: 'completed', successful: true, mutated: false, value,
  })
  assert.deepEqual(await port.remove(identity, 73, roundId, call, new AbortController().signal), {
    kind: 'completed', successful: true, mutated: false, value,
  })
  assert.equal(mutations, 1)
})

test('delete_file 撤权或 owner 不匹配时不查询、不产生回收站副作用', async () => {
  let calls = 0, removals = 0
  const pool = { async query() { calls++; return { rows: [], rowCount: 0 } } }
  const operations: FileDeleteOperations = { async remove() { removals++ } }
  const port = createWebAgentFileDeletePort(pool as never, operations, lease)
  const call = { id: 'delete', name: 'delete_file', input: { file_id: 72 } } as never
  await assert.rejects(port.remove({ ...identity, runId: 'other-run' }, 72, 'round', call, new AbortController().signal))
  assert.equal(calls, 0)
  await assert.rejects(port.remove(identity, 72, 'round', call, new AbortController().signal), /授权已失效/)
  assert.equal(calls, 1)
  assert.equal(removals, 0)
})

test('delete_file 批量经原子领域端口预校验完整 owner 集合，缺项不产生删除', async () => {
  let missing = false
  const queries: Array<{ sql: string; values: unknown[] }> = [], removals: unknown[][] = []
  const pool = { async query(sql: string, values: unknown[]) {
    queries.push({ sql, values })
    return { rows: [{}], rowCount: 1 }
  } }
  const operations: FileDeleteOperations = {
    async remove() { throw new Error('批量删除不得逐项降级') },
    async removeMany(...args) {
      if (missing) throw new Error('文件不存在')
      removals.push(args)
      await args[4]?.authorize({ query: async () => ({ rows: [{}], rowCount: 1 }) } as never)
      return { result: { success: true, deleted_count: 2, results: [] }, replayed: false }
    },
  }
  const port = createWebAgentFileDeletePort(pool as never, operations, lease)
  const registry = createToolRegistry({ groups: [{ id: 'files', name: '文件', tools: [createDeleteFileTool(port)] }], authorize: async () => true })
  const batch = { id: 'batch', name: 'delete_file', input: { file_ids: [73, 74] } }
  const result = await registry.tools.dispatch(batch, scope)
  assert.deepEqual(result.kind === 'completed' ? result.value : null, { success: true, deleted_count: 2, results: [] })
  assert.deepEqual(removals.map(([owner, ids, undo, client]) => [owner, ids, undo, client]),
    [[identity.ownerId, [73, 74], identity.sessionId, null]])
  missing = true
  const absent = await registry.tools.dispatch({ ...batch, id: 'missing' }, scope)
  assert.equal(absent.kind, 'completed')
  if (absent.kind === 'completed') assert.equal(absent.successful, false)
  assert.equal(removals.length, 1)
  assert.equal(queries.length, 2)
})
