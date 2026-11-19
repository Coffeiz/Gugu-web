import { CoreError } from '@gugu/core'
import { createHash } from 'node:crypto'
import { stableJson, type RunIdentity, type ToolCall, type ToolResult } from '@gugu/core/agent'
import type { FileArchivePort } from '@gugu/core/tools'
import type { Pool, PoolClient } from 'pg'
import type { WriteRequestMetadata } from '../../../../app.js'
import type { FileArchiveOperations, FileArchiveReceipt } from '../../../files/archive/service.js'
import type { AgentDispatchLease } from '../../run/dispatch.js'
import { createWebAgentRagRunAuthorization } from '../../rag/authorize.js'

function sameLease(identity: RunIdentity, expected: RunIdentity): boolean {
  return identity.ownerId === expected.ownerId && identity.sessionId === expected.sessionId && identity.runId === expected.runId
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CoreError('storage_error', '归档操作返回无效结果')
  return value as Record<string, unknown>
}

function ids(value: unknown): number[] {
  if (!Array.isArray(value) || value.some(id => !Number.isSafeInteger(Number(id)) || Number(id) < 1))
    throw new CoreError('storage_error', '归档操作返回无效结果')
  return value.map(Number)
}

const digest = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex')
function receipt(identity: RunIdentity & { roundId: string }, call: ToolCall): FileArchiveReceipt {
  const method = call.name === 'compress_files' ? 'agent.file.compress' : 'agent.file.extract'
  const hash = digest([method, identity.ownerId, identity.sessionId, identity.runId, identity.roundId, call.id])
  return { operationId: `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`,
    fingerprint: digest(call.input), method }
}

const completed = (value: Record<string, unknown>): ToolResult => ({ kind: 'completed', successful: true, mutated: true, value: { success: true, ...value } })
function commitOutcomeUnknown(error: unknown): boolean {
  return error instanceof CoreError && error.code === 'storage_error' && error.message.includes('提交结果未知')
}

/** 仅把当前 Web dispatch lease 的 owner 文件操作接入正式归档事务。 */
export function createWebAgentFileArchivePort(
  pool: Pick<Pool, 'query'>,
  operations: FileArchiveOperations,
  lease: AgentDispatchLease,
): FileArchivePort {
  if (lease.input.v !== 2 || lease.input.source !== 'web') throw new TypeError('Web Agent 文件归档来源无法验证')
  const expected = Object.freeze({ ...lease.identity })
  const authorization = createWebAgentRagRunAuthorization(pool, lease, { enabledFileArchive: true })
  const metadata: WriteRequestMetadata = {
    idempotencyKey: null,
    undoContextId: `agent:${expected.sessionId}:${expected.runId}`.slice(0, 128),
    clientId: null,
  }
  const guard = (name: 'compress_files' | 'extract_files', identity: RunIdentity, signal: AbortSignal) =>
    async (client: Pick<PoolClient, 'query'>): Promise<void> => {
      signal.throwIfAborted()
      if (!sameLease(identity, expected) || !await createWebAgentRagRunAuthorization(client, lease, { enabledFileArchive: true })
        .authorize(identity, name, signal)) throw new CoreError('conflict', '文件归档授权已失效')
    }

  return {
    async compress(identity, input, roundId, call, signal) {
      signal.throwIfAborted()
      if (!sameLease(identity, expected) || !await authorization.authorize(identity, 'compress_files', signal))
        throw new CoreError('conflict', '文件归档授权已失效')
      let raw: unknown
      try {
        raw = await operations.archive(expected.ownerId, {
          fileIds: input.entries.filter(entry => entry.kind === 'file').map(entry => entry.id),
          folderIds: input.entries.filter(entry => entry.kind === 'folder').map(entry => entry.id),
          ...(input.folder_id !== undefined ? { folderId: input.folder_id } : {}),
          ...(input.archive_name !== undefined ? { name: input.archive_name } : {}),
        }, metadata, guard('compress_files', identity, signal), { receipt: receipt({ ...identity, roundId }, call), signal })
      } catch (error) { if (commitOutcomeUnknown(error)) return { kind: 'unknown' }; throw error }
      const result = record(raw)
      if (!Number.isSafeInteger(result.id) || typeof result.displayName !== 'string' || typeof result.ext !== 'string')
        throw new CoreError('storage_error', '归档服务返回无效文件')
      return { file_id: Number(result.id), name: `${result.displayName}${result.ext ? `.${result.ext}` : ''}` }
    },
    async extract(identity, input, roundId, call, signal) {
      signal.throwIfAborted()
      if (!sameLease(identity, expected) || !await authorization.authorize(identity, 'extract_files', signal))
        throw new CoreError('conflict', '文件归档授权已失效')
      let rawResult: unknown
      try {
        rawResult = await operations.unarchive(expected.ownerId, {
          fileId: input.file_id,
          ...(input.folder_id !== undefined ? { folderId: input.folder_id } : {}),
          ...(input.format !== undefined ? { format: input.format } : {}),
        }, metadata, guard('extract_files', identity, signal), { receipt: receipt({ ...identity, roundId }, call), signal })
      } catch (error) { if (commitOutcomeUnknown(error)) return { kind: 'unknown' }; throw error }
      const raw = record(rawResult)
      const result = {
        created_count: Number(raw.created_count), file_count: Number(raw.file_count), folder_count: Number(raw.folder_count),
        skipped_count: Number(raw.skipped_count), rejected_count: Number(raw.rejected_count),
        file_ids: ids(raw.file_ids), folder_ids: ids(raw.folder_ids),
      }
      if (Object.values(result).slice(0, 5).some(value => !Number.isSafeInteger(value) || Number(value) < 0))
        throw new CoreError('storage_error', '归档服务返回无效结果')
      return result
    },
    async reconcile(identity, call) {
      if (!sameLease(identity, expected) || !['compress_files', 'extract_files'].includes(call.name))
        return { kind: 'completed', successful: false, mutated: false, value: { error: '文件归档授权已失效' } }
      const key = receipt(identity, call)
      const stored = await pool.query<{ method: string; fingerprint: string; result_json: string }>(
        'SELECT method,fingerprint,result_json FROM core_operation_receipts WHERE owner_id=$1 AND operation_id=$2',
        [expected.ownerId, key.operationId])
      const row = stored.rows[0]
      if (!row) return { kind: 'unknown' }
      if (row.method !== key.method || row.fingerprint !== key.fingerprint)
        return { kind: 'completed', successful: false, mutated: false, value: { error: '操作标识已用于不同内容' } }
      const raw = record(JSON.parse(row.result_json))
      if (key.method === 'agent.file.compress') {
        if (!Number.isSafeInteger(raw.id) || typeof raw.displayName !== 'string' || typeof raw.ext !== 'string')
          return { kind: 'unknown' }
        return completed({ file_id: Number(raw.id), name: `${raw.displayName}${raw.ext ? `.${raw.ext}` : ''}` })
      }
      const value = {
        created_count: Number(raw.created_count), file_count: Number(raw.file_count), folder_count: Number(raw.folder_count),
        skipped_count: Number(raw.skipped_count), rejected_count: Number(raw.rejected_count), file_ids: ids(raw.file_ids), folder_ids: ids(raw.folder_ids),
      }
      if (Object.values(value).slice(0, 5).some(count => !Number.isSafeInteger(count) || Number(count) < 0))
        return { kind: 'unknown' }
      return completed({ ...value, file_ids: value.file_ids.slice(0, 100), folder_ids: value.folder_ids.slice(0, 100),
        ids_truncated: value.file_ids.length > 100 || value.folder_ids.length > 100 })
    },
  }
}
