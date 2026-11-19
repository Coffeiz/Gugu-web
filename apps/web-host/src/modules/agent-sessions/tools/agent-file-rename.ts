import { createHash } from 'node:crypto'
import { CoreError } from '@gugu/core'
import { stableJson, type ToolCall, type ToolResult } from '@gugu/core/agent'
import type { Pool, QueryResultRow } from 'pg'
import type { RunIdentity } from '@gugu/core/agent'
import type { FileGrepPort, FileRenamePort } from '@gugu/core/tools'
import type { FileUpdateOperations, FileUpdateReceipt } from '../../files/file-update.js'
import type { AgentDispatchLease } from '../persistence/agent-run-dispatch-postgres.js'
import { createWebAgentRagRunAuthorization } from './agent-rag-run-authorization.js'

type FileRow = QueryResultRow & { id: number | string; user_id: string; display_name: string; ext: string; version: number | string }

/** 将可信 lease 绑定到既有文件更新事务，不让模型提供 owner 或物理存储路径。 */
export function createWebAgentFileRenamePort(
  pool: Pick<Pool, 'query'>,
  operations: FileUpdateOperations,
  lease: AgentDispatchLease,
  files?: Pick<FileGrepPort, 'list'>,
): FileRenamePort {
  if (lease.input.v !== 2 || lease.input.source !== 'web') throw new TypeError('Web Agent 文件重命名来源无法验证')
  const expected = Object.freeze({ ...lease.identity })
  const matchesLease = (identity: RunIdentity) => identity.ownerId === expected.ownerId
    && identity.sessionId === expected.sessionId && identity.runId === expected.runId
  const digest = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex')
  const receipt = (identity: RunIdentity & { roundId: string }, call: ToolCall): FileUpdateReceipt => {
    const hash = digest(['agent.file.rename', identity.ownerId, identity.sessionId, identity.runId, identity.roundId, call.id])
    return { operationId: `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`,
      fingerprint: digest(call.input), method: 'agent.file.rename' }
  }
  const toolResult = (value: Record<string, unknown>, mutated: boolean): ToolResult => {
    if (!Number.isSafeInteger(value.id) || typeof value.displayName !== 'string' || typeof value.ext !== 'string' || !Number.isSafeInteger(value.version))
      return { kind: 'unknown' }
    return { kind: 'completed', successful: true, mutated,
      value: { file_id: Number(value.id), old_name: value.old_name,
        name: `${value.displayName}${value.ext ? `.${value.ext}` : ''}`, version: Number(value.version) } }
  }
  const authorization = createWebAgentRagRunAuthorization(pool, lease, { enabledFileRename: true })
  const metadata = { idempotencyKey: null, undoContextId: `agent:${expected.sessionId}:${expected.runId}`.slice(0, 128), clientId: null }
  return {
    async resolveFilePath(identity, path, signal) {
      signal.throwIfAborted()
      if (!files || !matchesLease(identity)) return null
      const rows = (await files.list(identity, signal)).filter(file => file.path === path)
      signal.throwIfAborted()
      return rows.length === 1 ? rows[0]!.file_id : null
    },
    async rename(identity, id, name, extension, expectedVersion, roundId, call, signal) {
      signal.throwIfAborted()
      if (!matchesLease(identity) || !Number.isSafeInteger(id) || id < 1)
        return { kind: 'completed', successful: false, mutated: false, value: { error: '文件不存在或无权访问' } }
      if (!await authorization.authorize(identity, 'rename_file', signal)) throw new CoreError('conflict', '文件重命名授权已失效')
      const result = await pool.query<FileRow>(`SELECT id,user_id,display_name,ext,version FROM files
        WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`, [id, expected.ownerId])
      signal.throwIfAborted()
      const row = result.rows[0]
      if (!row || String(row.user_id).toLowerCase() !== expected.ownerId.toLowerCase())
        return { kind: 'completed', successful: false, mutated: false, value: { error: '文件不存在或无权访问' } }
      const version = Number(row.version)
      if (expectedVersion !== undefined && expectedVersion !== version)
        return { kind: 'completed', successful: false, mutated: false, value: { error: '文件已被其他端修改，请刷新后重试' } }
      if (row.display_name === name)
        return { kind: 'completed', successful: false, mutated: false, value: { error: '文件名未变化' } }
      let raw: unknown
      try {
        raw = await operations.update(expected.ownerId, id, {
          version, displayName: name, ...(extension !== undefined ? { ext: extension } : {}),
          folderSet: false, projectSet: false, workspaceDirectorySet: false,
        }, metadata, {
          receipt: { ...receipt({ ...identity, roundId }, call), previousName: `${row.display_name}${row.ext ? `.${row.ext}` : ''}` }, signal,
          async authorize(client) {
            if (!await createWebAgentRagRunAuthorization(client, lease, { enabledFileRename: true }).authorize(identity, 'rename_file', signal))
              throw new CoreError('conflict', '文件重命名授权已失效')
          },
        })
      } catch (error) {
        signal.throwIfAborted()
        if (error instanceof CoreError && ['invalid_request', 'not_found', 'conflict'].includes(error.code))
          return { kind: 'completed', successful: false, mutated: false, value: { error: error.message } }
        throw error
      }
      const updated = raw as { file?: unknown; replayed?: boolean }
      if (!updated || typeof updated !== 'object' || Array.isArray(updated) || !updated.file
        || typeof updated.file !== 'object' || Array.isArray(updated.file)) return { kind: 'unknown' }
      return toolResult(updated.file as Record<string, unknown>, updated.replayed !== true)
    },
    async reconcile(identity, call) {
      if (!matchesLease(identity) || call.name !== 'rename_file')
        return { kind: 'completed', successful: false, mutated: false, value: { error: '文件重命名授权已失效' } }
      const key = receipt(identity, call)
      const stored = await pool.query<{ method: string; fingerprint: string; result_json: string }>(
        'SELECT method,fingerprint,result_json FROM core_operation_receipts WHERE owner_id=$1 AND operation_id=$2',
        [expected.ownerId, key.operationId])
      const row = stored.rows[0]
      if (!row) return { kind: 'unknown' }
      if (row.method !== key.method || row.fingerprint !== key.fingerprint)
        return { kind: 'completed', successful: false, mutated: false, value: { error: '操作标识已用于不同内容' } }
      try { return toolResult(JSON.parse(row.result_json) as Record<string, unknown>, false) }
      catch { return { kind: 'unknown' } }
    },
  }
}
