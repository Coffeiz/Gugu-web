import { createHash } from 'node:crypto'
import type { SqlDataRuntime } from '@gugu/core/data'
import type { WorkspaceDirectoryDeletePort, WorkspaceDirectoryDeleteRequest, WorkspaceDirectoryDeleteReceiptRequest, WorkspaceDirectoryDeletePreview, WorkspaceUnlinkConfirmation } from '@gugu/core/tools'
import type { Pool } from 'pg'
import type { AgentDispatchLease } from '../../run/dispatch.js'
import type { WorkspaceDirectoryOperations } from '../../../workspaces/routes.js'

export interface WebAgentWorkspaceDirectoryDeleteOptions {
  core: SqlDataRuntime
  pool: Pick<Pool, 'query'>
  lease: AgentDispatchLease
  operations: WorkspaceDirectoryOperations
  confirmation: WorkspaceUnlinkConfirmation
}

function sameLease(left: WorkspaceDirectoryDeleteRequest['identity'], right: WorkspaceDirectoryDeleteRequest['identity']) {
  return left.ownerId === right.ownerId && left.sessionId === right.sessionId && left.runId === right.runId
}
function uuid(parts: readonly string[], phase: string) {
  const hash = createHash('sha256').update(JSON.stringify([...parts, phase])).digest('hex')
  const raw = `${hash.slice(0, 12)}5${hash.slice(13, 16)}8${hash.slice(17, 32)}`
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`
}
function previewShape(value: WorkspaceDirectoryDeletePreview) {
  return [value.id, value.name, value.directory_name, value.is_default, value.is_system,
    value.file_count, value.folder_count, value.bound_session_count, value.bound_task_count]
}

/** Web lease 的目录删除适配器；确认收据先占位，结果未知时不重放物理删除。 */
export function createWebAgentWorkspaceDirectoryDeletePort(options: WebAgentWorkspaceDirectoryDeleteOptions): WorkspaceDirectoryDeletePort {
  if (!options.core.receipts) throw new Error('工作区目录删除需要持久调用收据')
  const expected = Object.freeze({ ...options.lease.identity })
  if (options.lease.input.v !== 2 || options.lease.input.source !== 'web') throw new TypeError('Web Agent 工作区目录来源无法验证')
  const absent = new Error('工作区目录删除结果收据不存在')
  const coordinates = (input: WorkspaceDirectoryDeleteReceiptRequest) => {
    if (!sameLease(input.identity, expected) || !/^[1-9]\d*$/.test(input.identity.sessionId)
      || !input.roundId.trim() || !input.toolCallId.trim()) throw new Error('工作区目录删除授权已失效')
    const context = { ownerId: expected.ownerId }
    const parts = ['agent.workspace.directory.delete', expected.ownerId, expected.sessionId, expected.runId, input.roundId, input.toolCallId]
    const preview = 'preview' in input ? input.preview as WorkspaceDirectoryDeletePreview : undefined
    return { context, reservationId: uuid(parts, 'reservation'), resultId: uuid(parts, 'result'),
      resultParams: { directory_id: input.directoryId },
      reservationParams: { directory_id: input.directoryId,
        snapshot: preview ? previewShape(preview) : undefined } }
  }
  async function active(signal: AbortSignal) {
    signal.throwIfAborted()
    const result = await options.pool.query(`SELECT 1 FROM conversation_sessions s
      JOIN agent_run_dispatch d ON d.user_id=s.user_id AND d.session_id=s.id
      WHERE s.user_id=$1 AND s.id=$2 AND s.active_run_id=$3 AND d.run_id=$3 AND d.state='selected'
        AND d.token=$4 AND d.fence=$5 AND d.lease_expires_at>clock_timestamp()`,
    [expected.ownerId, expected.sessionId, expected.runId, options.lease.token, options.lease.fence])
    signal.throwIfAborted()
    return result.rowCount === 1
  }
  async function readResult(input: WorkspaceDirectoryDeleteReceiptRequest) {
    try {
      const key = coordinates(input)
      const receipt = await options.core.operationWithTransaction(key.context, key.resultId,
        'agent.workspace.directory.delete.result', key.resultParams, async () => { throw absent })
      const value = receipt.result as Record<string, unknown>
      return { kind: 'completed' as const, successful: value.success === true, mutated: false, value }
    } catch { return { kind: 'unknown' as const } }
  }
  return {
    async preview(identity, directoryId, signal) {
      if (!sameLease(identity, expected) || !await active(signal)) throw new Error('工作区目录删除授权已失效')
      const row = await options.operations.previewDelete(expected.ownerId, directoryId)
      signal.throwIfAborted()
      return { id: row.id, name: row.name, directory_name: row.directory_name, is_default: row.is_default, is_system: row.is_system,
        file_count: row.file_count, folder_count: row.folder_count, bound_session_count: row.bound_session_count, bound_task_count: row.bound_task_count }
    },
    reconcile: readResult,
    async apply(input) {
      input.signal.throwIfAborted()
      if (!sameLease(input.identity, expected) || !await active(input.signal)) return { kind: 'completed', successful: false, mutated: false, value: { error: '工作区目录删除授权已失效' } }
      const key = coordinates(input)
      let reservation
      try {
        reservation = await options.core.operationWithTransaction(key.context, key.reservationId,
          'agent.workspace.directory.delete.reservation', key.reservationParams, async tx => {
            input.signal.throwIfAborted()
            if (!await options.confirmation.claim(tx, input.confirmation, input.signal)) throw new Error('工作区目录删除确认无效或已过期')
            return { reserved: true }
          }, { signal: input.signal })
      } catch { return readResult(input) }
      if (reservation.replayed) return readResult(input)
      if (!await active(input.signal)) return { kind: 'unknown' }
      let value: Record<string, unknown>
      try {
        input.signal.throwIfAborted()
        await options.operations.delete(expected.ownerId, input.directoryId, input.preview)
        value = { success: true, deleted_directory_id: input.directoryId, name: input.preview.name }
      } catch (error) {
        if (input.signal.aborted) throw error
        const code = error !== null && typeof error === 'object' && 'code' in error ? String(error.code) : ''
        if (code === 'not_found') value = { error: 'Workspace 目录不存在' }
        else if (code === 'conflict') value = { error: '工作区目录删除确认已失效；目录内容或状态已变化，请重新确认' }
        else return { kind: 'unknown' }
      }
      try {
        const saved = await options.core.operationWithTransaction(key.context, key.resultId,
          'agent.workspace.directory.delete.result', key.resultParams, async () => value, { signal: input.signal })
        const result = saved.result as Record<string, unknown>
        return { kind: 'completed', successful: result.success === true, mutated: result.success === true && !saved.replayed, value: result }
      } catch { return readResult(input) }
    },
  }
}
