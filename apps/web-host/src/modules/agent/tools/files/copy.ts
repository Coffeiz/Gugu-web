import { CoreError } from '@gugu/core'
import { createHash } from 'node:crypto'
import { stableJson, type ToolResult } from '@gugu/core/agent'
import type { Pool, QueryResultRow } from 'pg'
import type { RunIdentity } from '@gugu/core/agent'
import type { FileCopyPort, FileGrepPort } from '@gugu/core/tools'
import type { FileCopyOperations, FileCopyReceipt } from '../../../files/store.js'
import type { AgentDispatchLease } from '../../run/dispatch.js'
import { createWebAgentRagRunAuthorization } from '../../rag/authorize.js'

type FileRow = QueryResultRow & { id: number | string; user_id: string }

/** 文件复制仅允许当前 lease 的 owner 源文件，目标空间与副本事务由文件域处理。 */
export function createWebAgentFileCopyPort(
  pool: Pick<Pool, 'query'>,
  operations: FileCopyOperations,
  lease: AgentDispatchLease,
  files?: Pick<FileGrepPort, 'list'>,
): FileCopyPort {
  if (lease.input.v !== 2 || lease.input.source !== 'web') throw new TypeError('Web Agent 文件复制来源无法验证')
  const expected = Object.freeze({ ...lease.identity })
  const matchesLease = (identity: RunIdentity) => identity.ownerId === expected.ownerId
    && identity.sessionId === expected.sessionId && identity.runId === expected.runId
  const digest = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex')
  const receipt = (identity: RunIdentity & { roundId: string }, call: import('@gugu/core/agent').ToolCall): FileCopyReceipt => {
    const hash = digest(['agent.file.copy', identity.ownerId, identity.sessionId, identity.runId, identity.roundId, call.id])
    return { operationId: `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`,
      fingerprint: digest(call.input), method: 'agent.file.copy' }
  }
  const result = (file: Record<string, unknown>, mutated: boolean): ToolResult => {
    if (!Number.isSafeInteger(file.id) || typeof file.displayName !== 'string' || !Number.isSafeInteger(file.version))
      return { kind: 'unknown' }
    return { kind: 'completed', successful: true, mutated,
      value: { file_id: Number(file.id), name: file.displayName, version: Number(file.version) } }
  }
  const authorization = createWebAgentRagRunAuthorization(pool, lease, { enabledFileCopy: true })
  const metadata = {
    idempotencyKey: null,
    undoContextId: `agent:${expected.sessionId}:${expected.runId}`.slice(0, 128),
    clientId: null,
  }
  return {
    async resolveFilePath(identity, path, signal) {
      signal.throwIfAborted()
      if (!files || !matchesLease(identity)) return null
      const rows = (await files.list(identity, signal)).filter(file => file.path === path)
      signal.throwIfAborted()
      return rows.length === 1 ? rows[0]!.file_id : null
    },
    async copy(identity, id, destination, roundId, call, signal) {
      signal.throwIfAborted()
      if (!matchesLease(identity) || !Number.isSafeInteger(id) || id < 1) return { kind: 'completed', successful: false, mutated: false, value: { error: '文件不存在或无权访问' } }
      if (!await authorization.authorize(identity, 'copy_file', signal)) throw new CoreError('conflict', '文件复制授权已失效')
      const source = await pool.query<FileRow>(`SELECT id,user_id FROM files
        WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`, [id, expected.ownerId])
      signal.throwIfAborted()
      const row = source.rows[0]
      if (!row || String(row.user_id).toLowerCase() !== expected.ownerId.toLowerCase()) return { kind: 'completed', successful: false, mutated: false, value: { error: '文件不存在或无权访问' } }
      try {
        const raw = await operations.copy(expected.ownerId, id, {
          folderId: destination.folder_id ?? null,
          projectId: destination.project_id ?? null,
          workspaceDirectoryId: destination.workspace_directory_id ?? null,
          onConflict: 'keep_both',
          overwriteFileId: null,
        }, metadata, {
          receipt: receipt({ ...identity, roundId }, call), signal,
          async authorize(client) {
            if (!await createWebAgentRagRunAuthorization(client, lease, { enabledFileCopy: true }).authorize(identity, 'copy_file', signal))
              throw new CoreError('conflict', '文件复制授权已失效')
          },
        }) as { file?: unknown; replayed?: boolean }
        if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !raw.file || typeof raw.file !== 'object' || Array.isArray(raw.file)) return { kind: 'unknown' }
        return result(raw.file as Record<string, unknown>, raw.replayed !== true)
      } catch (error) {
        signal.throwIfAborted()
        if (error instanceof CoreError && ['invalid_request', 'not_found', 'conflict'].includes(error.code))
          return { kind: 'completed', successful: false, mutated: false, value: { error: error.message } }
        if (error instanceof CoreError && error.code === 'storage_error' && error.message.includes('提交结果未知')) return { kind: 'unknown' }
        throw error
      }
    },
    async reconcile(identity, call) {
      if (!matchesLease(identity) || call.name !== 'copy_file') return { kind: 'completed', successful: false, mutated: false, value: { error: '文件复制授权已失效' } }
      const key = receipt(identity, call)
      const stored = await pool.query<{ method: string; fingerprint: string; result_json: string }>(
        'SELECT method,fingerprint,result_json FROM core_operation_receipts WHERE owner_id=$1 AND operation_id=$2',
        [expected.ownerId, key.operationId])
      const row = stored.rows[0]
      if (!row) return { kind: 'unknown' }
      if (row.method !== key.method || row.fingerprint !== key.fingerprint)
        return { kind: 'completed', successful: false, mutated: false, value: { error: '操作标识已用于不同内容' } }
      try { return result(JSON.parse(row.result_json) as Record<string, unknown>, false) }
      catch { return { kind: 'unknown' } }
    },
  }
}
