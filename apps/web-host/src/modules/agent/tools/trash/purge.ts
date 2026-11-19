import type { Pool } from 'pg'
import { createHash } from 'node:crypto'
import { CoreError, dataContext } from '@gugu/core'
import type { SqlDataRuntime } from '@gugu/core/data'
import type { TrashListItem, TrashListPort, TrashPurgePort, TrashPurgeRequest, TrashPurgeSnapshot, TrashPurgeJobResult, TrashPurgeConfirmation } from '@gugu/core/tools'
import { createPostgresAgentTrashReader } from '../../../files/trash/store.js'
import type { AgentDispatchLease } from '../../run/dispatch.js'
import { TrashCooldownError, type AgentTrashPurgeOperations } from '../../../files/trash/service.js'

/** 只装配既有回收站只读服务，不接收模型提供的owner、游标或凭据。 */
export function createAgentTrashListPort(pool: Pool, secret: string): TrashListPort {
  const reader = createPostgresAgentTrashReader(pool, secret)
  return {
    async list(identity, limit, signal) {
      signal.throwIfAborted()
      const files = await reader.listFiles(identity.ownerId, { limit, cursor: null })
      signal.throwIfAborted()
      const folders = await reader.listFolders(identity.ownerId, { limit, cursor: null })
      signal.throwIfAborted()
      // 领域工厂固定采用Agent投影；不接受任意分页来源或模型自定义字段。
      return { files: files.items as unknown as TrashListItem[], folders: folders.items as unknown as TrashListItem[] }
    },
  }
}

export interface AgentTrashPurgeOptions {
  core: SqlDataRuntime
  pool: Pick<Pool, 'query'>
  lease: AgentDispatchLease
  operations: AgentTrashPurgeOperations
  confirmation: TrashPurgeConfirmation
}

function sameLease(left: TrashPurgeRequest['identity'], right: TrashPurgeRequest['identity']) {
  return left.ownerId === right.ownerId && left.sessionId === right.sessionId && left.runId === right.runId
}

function operationId(parts: readonly string[], phase: string) {
  const hash = createHash('sha256').update(JSON.stringify([...parts, phase])).digest('hex')
  const raw = `${hash.slice(0, 12)}5${hash.slice(13, 16)}8${hash.slice(17, 32)}`
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`
}

/** Web Agent 只为当前 owner 创建 Node 回收站持久任务；确认、任务与工具结果分别有可恢复收据。 */
export function createAgentTrashPurgePort(options: AgentTrashPurgeOptions): TrashPurgePort {
  if (!options.core.receipts) throw new Error('回收站清空需要持久调用收据')
  if (options.lease.input.v !== 2 || options.lease.input.source !== 'web') throw new TypeError('Web Agent 回收站来源无法验证')
  const expected = Object.freeze({ ...options.lease.identity })
  const absent = new Error('回收站清空结果收据不存在')
  function keys(input: TrashPurgeRequest) {
    if (!sameLease(input.identity, expected) || !/^\d+$/.test(input.identity.sessionId)
      || !input.roundId.trim() || !input.toolCallId.trim()) throw new Error('回收站清空授权已失效')
    const context = dataContext(expected.ownerId)
    const parts = ['agent.trash.permanent_delete', expected.ownerId, expected.sessionId, expected.runId, input.roundId, input.toolCallId]
    return { context, reserveId: operationId(parts, 'reserve'), resultId: operationId(parts, 'result'), params: { all: true } }
  }
  async function active(signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted()
    const result = await options.pool.query(`SELECT 1 FROM conversation_sessions s
      JOIN agent_run_dispatch d ON d.user_id=s.user_id AND d.session_id=s.id
      WHERE s.user_id=$1 AND s.id=$2 AND s.active_run_id=$3 AND d.run_id=$3 AND d.state='selected'
        AND d.token=$4 AND d.fence=$5 AND d.lease_expires_at>clock_timestamp()`,
    [expected.ownerId, expected.sessionId, expected.runId, options.lease.token, options.lease.fence])
    signal.throwIfAborted()
    return result.rowCount === 1
  }
  async function readResult(input: TrashPurgeRequest, mutationIfThisCall = false): Promise<import('@gugu/core/agent').ToolResult> {
    const key = keys(input)
    try {
      const result = await options.core.operationWithTransaction(key.context, key.resultId,
        'agent.trash.permanent_delete.result', key.params, async () => { throw absent })
      const value = result.result as Record<string, unknown>
      return { kind: 'completed', successful: value.success === true, mutated: false, value }
    } catch { /* 尚无工具结果，继续从关联的 Agent job 或确认预留恢复。 */ }
    async function save(value: Record<string, unknown>, mutated = false) {
      const saved = await options.core.operationWithTransaction(key.context, key.resultId,
        'agent.trash.permanent_delete.result', key.params, async () => value)
      return { kind: 'completed' as const, successful: saved.result.success === true,
        mutated: saved.result.success === true && mutated && !saved.replayed, value: saved.result }
    }
    try {
      if (!await active(new AbortController().signal)) return { kind: 'unknown' }
      let job = await options.operations.getAgentEmpty(expected.ownerId, key.reserveId)
      if (!job) {
        const reservation = await options.core.receipt(key.context, key.reserveId)
        if (reservation?.method !== 'agent.trash.permanent_delete.reserve') return { kind: 'unknown' }
        const reserved = reservation.result as { reserved?: unknown; snapshot?: TrashPurgeSnapshot }
        if (reserved?.reserved !== true || !reserved.snapshot
          || !Number.isSafeInteger(reserved.snapshot.file_count) || !Number.isSafeInteger(reserved.snapshot.folder_count)
          || !/^[0-9a-f]{64}$/iu.test(reserved.snapshot.digest)) return { kind: 'unknown' }
        try {
          job = await options.operations.startEmptyForAgent(expected.ownerId, key.reserveId, reserved.snapshot)
        } catch (error) {
          if (error instanceof TrashCooldownError || error instanceof CoreError && ['busy', 'conflict'].includes(error.code))
            return save({ success: false, error: error.message })
          throw error
        }
      }
      return save({ success: true, job_id: job.id, status: job.status, progress_current: job.progressCurrent,
        progress_total: job.progressTotal, failed_count: job.failedCount, error_code: job.errorCode }, mutationIfThisCall)
    } catch { return { kind: 'unknown' } }
  }
  async function preview(identity: TrashPurgeRequest['identity'], signal: AbortSignal): Promise<TrashPurgeSnapshot> {
    if (!sameLease(identity, expected) || !await active(signal)) throw new Error('回收站清空授权已失效')
    const files = await options.pool.query<{ count: number | string; digest: string }>(
      `SELECT count(*)::int AS count, md5(COALESCE(string_agg(id::text || ':' || COALESCE(deleted_at::text,''), ',' ORDER BY id),'')) AS digest
       FROM (SELECT file.id,file.deleted_at FROM files file LEFT JOIN folders parent ON parent.id=file.folder_id
         WHERE file.user_id=$1 AND file.deleted_at IS NOT NULL AND (file.folder_id IS NULL OR parent.deleted_at IS NULL)) targets`,
      [expected.ownerId])
    signal.throwIfAborted()
    const folders = await options.pool.query<{ count: number | string; digest: string }>(
      `SELECT count(*)::int AS count, md5(COALESCE(string_agg(id::text || ':' || COALESCE(deleted_at::text,''), ',' ORDER BY id),'')) AS digest
       FROM (SELECT folder.id,folder.deleted_at FROM folders folder LEFT JOIN folders parent ON parent.id=folder.parent_id
         WHERE folder.user_id=$1 AND folder.deleted_at IS NOT NULL AND (folder.parent_id IS NULL OR parent.deleted_at IS NULL)) targets`,
      [expected.ownerId])
    signal.throwIfAborted()
    const file = files.rows[0], folder = folders.rows[0]
    if (!file || !folder) throw new Error('回收站快照不可用')
    const fileCount = Number(file.count), folderCount = Number(folder.count)
    if (![fileCount, folderCount].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error('回收站计数无效')
    return { file_count: fileCount, folder_count: folderCount, digest: createHash('sha256').update(`${file.digest}:${folder.digest}`).digest('hex') }
  }
  return {
    preview,
    reconcile: readResult,
    async apply(input) {
      input.signal.throwIfAborted()
      if (!sameLease(input.identity, expected) || !await active(input.signal))
        return { kind: 'completed', successful: false, mutated: false, value: { error: '回收站清空授权已失效' } }
      const key = keys(input)
      let current: TrashPurgeSnapshot
      try { current = await preview(input.identity, input.signal) }
      catch (error) { input.signal.throwIfAborted(); return { kind: 'completed', successful: false, mutated: false, value: { error: error instanceof Error ? error.message : '回收站状态不可用' } } }
      if (current.file_count !== input.snapshot.file_count || current.folder_count !== input.snapshot.folder_count || current.digest !== input.snapshot.digest)
        return { kind: 'completed', successful: false, mutated: false, value: { error: '回收站内容已变化，请重新确认' } }
      let reservation
      try {
        reservation = await options.core.operationWithTransaction(key.context, key.reserveId,
          'agent.trash.permanent_delete.reserve', { ...key.params, snapshot: current }, async tx => {
            input.signal.throwIfAborted()
            if (!await options.confirmation.claim(tx, input.confirmation, input.signal)) throw new Error('回收站清空确认无效或已过期')
            return { reserved: true, snapshot: current }
          }, { signal: input.signal })
      } catch { return readResult(input, true) }
      if (reservation.replayed) return readResult(input)
      if (!await active(input.signal)) return { kind: 'unknown' }
      try {
        input.signal.throwIfAborted()
        const job = await options.operations.startEmptyForAgent(expected.ownerId, key.reserveId, current)
        const value = { success: true, job_id: job.id, status: job.status, progress_current: job.progressCurrent,
          progress_total: job.progressTotal, failed_count: job.failedCount, error_code: job.errorCode }
        const saved = await options.core.operationWithTransaction(key.context, key.resultId,
          'agent.trash.permanent_delete.result', key.params, async () => value, { signal: input.signal })
        const result = saved.result as Record<string, unknown>
        return { kind: 'completed', successful: result.success === true, mutated: result.success === true && !saved.replayed, value: result }
      } catch (error) {
        input.signal.throwIfAborted()
        return readResult(input, true)
      }
    },
  }
}
