import type { FileDeletePort, FilePathLookup } from '@gugu/core/tools'
import { createHash } from 'node:crypto'
import { CoreError } from '@gugu/core'
import { stableJson, type ToolCall, type ToolResult } from '@gugu/core/agent'
import type { Pool, PoolClient } from 'pg'
import type { AgentDispatchLease } from '../../run/dispatch.js'
import type { FileDeleteAgentResult, FileDeleteOperations, FileDeleteReceipt } from '../../../files/trash/service.js'
import type { RunIdentity } from '@gugu/core/agent'
import { createWebAgentRagRunAuthorization } from '../../rag/authorize.js'
import { isOwnedFilePath } from '../../../files/store.js'

function sameLease(identity: RunIdentity, expected: RunIdentity): boolean {
  return identity.ownerId === expected.ownerId && identity.sessionId === expected.sessionId && identity.runId === expected.runId
}

const digest = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex')
function fileReceipt(identity: RunIdentity & { roundId: string }, call: ToolCall): FileDeleteReceipt {
  const hash = digest(['agent.file.delete_file', identity.ownerId, identity.sessionId, identity.runId, identity.roundId, call.id])
  return { operationId: `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`,
    fingerprint: digest(call.input), method: 'agent.file.delete_file' }
}

function toFileDeleteToolResult(outcome: FileDeleteAgentResult | { kind: 'unknown' } | void): ToolResult {
  if (outcome && 'kind' in outcome && outcome.kind === 'unknown') return { kind: 'unknown' }
  if (!outcome || !('result' in outcome) || typeof outcome.result !== 'object' || outcome.result.success !== true)
    throw new CoreError('storage_error', '文件删除返回无效结果')
  return { kind: 'completed', successful: true, mutated: !outcome.replayed, value: outcome.result }
}

/** 将 owner 文件软删除接到正式文件删除事务、回收站、Undo 与变更通知。 */
export function createWebAgentFileDeletePort(
  pool: Pick<Pool, 'query'>,
  operations: FileDeleteOperations,
  lease: AgentDispatchLease,
  files?: Pick<FilePathLookup, 'list'>,
): FileDeletePort {
  if (lease.input.v !== 2 || lease.input.source !== 'web') throw new TypeError('Web Agent 文件删除来源无法验证')
  const expected = Object.freeze({ ...lease.identity })
  const authorization = createWebAgentRagRunAuthorization(pool, lease, { enabledFileDelete: true })
  async function resolveStorageKey(identity: RunIdentity, path: string, signal: AbortSignal) {
    signal.throwIfAborted()
    if (!files || !sameLease(identity, expected)) return null
    const rows = (await files.list(identity, signal)).filter(file => file.path === path)
    signal.throwIfAborted()
    return rows.length === 1 ? rows[0]!.filePath : null
  }
  return { async resolveFilePath(identity, path, signal) {
    return await resolveStorageKey(identity, path, signal)
  }, async remove(identity, path, roundId, call, signal) {
    signal.throwIfAborted()
    if (!sameLease(identity, expected) || !await authorization.authorize(identity, 'delete_file', signal))
      throw new Error('文件删除授权已失效')
    if (!isOwnedFilePath(expected.ownerId, path)) throw new Error('文件不存在')
    try {
      const outcome = await operations.remove(expected.ownerId, path, expected.sessionId, null, {
        receipt: fileReceipt({ ...identity, roundId }, call), signal,
        async authorize(client: Pick<PoolClient, 'query'>) {
          const current = createWebAgentRagRunAuthorization(client, lease, { enabledFileDelete: true })
          if (!sameLease(identity, expected) || !await current.authorize(identity, 'delete_file', signal))
            throw new CoreError('conflict', '文件删除授权已失效')
        },
      })
      signal.throwIfAborted()
      return toFileDeleteToolResult(outcome)
    } catch (error) {
      if (error instanceof CoreError && error.code === 'storage_error' && error.message.includes('提交结果未知')) return { kind: 'unknown' }
      throw error
    }
  }, async removeMany(identity, paths, roundId, call, signal) {
    signal.throwIfAborted()
    if (!sameLease(identity, expected) || !await authorization.authorize(identity, 'delete_file', signal))
      throw new Error('文件删除授权已失效')
    if (!operations.removeMany) throw new Error('文件批量删除能力不可用')
    if (!paths.length || paths.length > 50 || paths.some(path => !isOwnedFilePath(expected.ownerId, path))
      || new Set(paths).size !== paths.length) throw new Error('文件路径列表无效')
    try {
      const outcome = await operations.removeMany(expected.ownerId, [...paths], expected.sessionId, null, {
        receipt: fileReceipt({ ...identity, roundId }, call), signal,
        async authorize(client: Pick<PoolClient, 'query'>) {
          const current = createWebAgentRagRunAuthorization(client, lease, { enabledFileDelete: true })
          if (!sameLease(identity, expected) || !await current.authorize(identity, 'delete_file', signal))
            throw new CoreError('conflict', '文件删除授权已失效')
        },
      })
      signal.throwIfAborted()
      return toFileDeleteToolResult(outcome)
    } catch (error) {
      if (error instanceof CoreError && error.code === 'storage_error' && error.message.includes('提交结果未知')) return { kind: 'unknown' }
      throw error
    }
  }, async reconcile(identity, call): Promise<ToolResult> {
    if (!sameLease(identity, expected)) return { kind: 'completed', successful: false, mutated: false,
      value: { error: '文件删除授权已失效' } }
    const receipt = fileReceipt(identity, call)
    const stored = await pool.query<{ method: string; fingerprint: string; result_json: string }>(
      'SELECT method,fingerprint,result_json FROM core_operation_receipts WHERE owner_id=$1 AND operation_id=$2',
      [expected.ownerId, receipt.operationId])
    const row = stored.rows[0]
    if (!row) return { kind: 'unknown' }
    if (row.method !== receipt.method || row.fingerprint !== receipt.fingerprint)
      return { kind: 'completed', successful: false, mutated: false, value: { error: '操作标识已用于不同内容' } }
    const value = JSON.parse(row.result_json) as Record<string, unknown>
    return { kind: 'completed', successful: true, mutated: false, value }
  } }
}
