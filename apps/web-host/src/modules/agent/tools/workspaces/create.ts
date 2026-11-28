import { createHash } from 'node:crypto'
import { DatabaseError, type Pool } from 'pg'
import type { RunIdentity, ToolResult } from '@gugu/core/agent'
import { CoreError, dataContext } from '@gugu/core'
import type { SqlDataRuntime } from '@gugu/core/data'
import type { WorkspaceCreateInput, WorkspaceCreatePort } from '@gugu/core/tools'
import { diagLogRaw } from '../../../../shared/log-files.js'
import type { AgentDispatchLease } from '../../run/dispatch.js'

export interface WebAgentWorkspaceCreateOptions {
  core: SqlDataRuntime
  pool: Pick<Pool, 'query'>
  lease: AgentDispatchLease
  createDeclaration(ownerId: string, input: { name: string; kind: 'project'; projectId?: number; enabled: boolean }): Promise<{ id: number }>
  createDirectory(ownerId: string, name: string): Promise<{ id: number }>
  readWorkspace(ownerId: string, workspaceId: number, signal: AbortSignal): Promise<Record<string, unknown> | null>
  listWorkspaces(ownerId: string, signal: AbortSignal): Promise<readonly Record<string, unknown>[]>
}

function sameLease(identity: RunIdentity, expected: RunIdentity): boolean {
  return identity.ownerId === expected.ownerId && identity.sessionId === expected.sessionId && identity.runId === expected.runId
}

function operationId(parts: readonly string[]): string {
  const hash = createHash('sha256').update(JSON.stringify(parts)).digest('hex')
  const raw = `${hash.slice(0, 12)}5${hash.slice(13, 16)}8${hash.slice(17, 32)}`
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`
}

/** 每个 Web lease 复用正式工作区服务；持久预留保证不确定写入不会被同一调用重放。 */
export function createWebAgentWorkspaceCreatePort(options: WebAgentWorkspaceCreateOptions): WorkspaceCreatePort {
  if (!options.core.receipts) throw new Error('工作区创建需要持久调用收据')
  if (options.lease.input.v !== 2 || options.lease.input.source !== 'web') throw new TypeError('Web Agent 工作区来源无法验证')
  const expected = Object.freeze({ ...options.lease.identity })
  const absent = new Error('工作区创建结果收据不存在')

  function coordinates(input: WorkspaceCreateInput) {
    if (!sameLease(input.identity, expected) || !/^[1-9]\d*$/.test(input.identity.sessionId)
      || !input.roundId.trim() || !input.toolCallId.trim()) throw new Error('工作区创建授权已失效')
    const context = dataContext(expected.ownerId)
    const parts = ['agent.workspace.create', expected.ownerId, expected.sessionId, expected.runId, input.roundId, input.toolCallId]
    return {
      context,
      params: input.args,
      reservationId: operationId([...parts, 'reservation']),
      resultId: operationId([...parts, 'result']),
    }
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

  function diagnose(phase: string, reason: string, error?: unknown) {
    const runId = /^[a-z0-9-]{1,128}$/iu.test(expected.runId) ? expected.runId : createHash('sha256').update(expected.runId).digest('hex')
    const fields = { run_id: runId, phase, reason,
      ...(error instanceof DatabaseError && /^[0-9A-Z]{5}$/u.test(error.code ?? '') ? {
        sqlstate: error.code,
        table: /^[a-z_][a-z0-9_]{0,62}$/u.test(error.table ?? '') ? error.table : undefined,
        column: /^[a-z_][a-z0-9_]{0,62}$/u.test(error.column ?? '') ? error.column : undefined,
      } : error instanceof CoreError ? { code: error.code } : {}),
    }
    diagLogRaw('agent.workspace.create', JSON.stringify(fields))
  }

  async function activeAfterReservation(signal: AbortSignal, phase: string) {
    try {
      if (await active(signal)) return true
      diagnose(phase, 'lease_lost')
      return false
    } catch (error) {
      signal.throwIfAborted()
      diagnose(phase, 'lease_check_failed', error)
      throw error
    }
  }

  async function readResult(input: WorkspaceCreateInput): Promise<ToolResult> {
    try {
      const key = coordinates(input)
      const saved = await options.core.operationWithTransaction(key.context, key.resultId,
        'agent.workspace.create.result', key.params, async () => { throw absent })
      return { kind: 'completed', successful: true, mutated: false, value: saved.result }
    } catch (error) {
      diagnose('reconcile', error === absent ? 'receipt_missing' : 'receipt_read_failed', error)
      return { kind: 'unknown' }
    }
  }

  return {
    async create(input) {
      input.signal.throwIfAborted()
      if (!sameLease(input.identity, expected) || !await active(input.signal))
        return { kind: 'completed', successful: false, mutated: false, executed: false, value: { error: '工作区创建授权已失效' } }
      const key = coordinates(input)
      let reservation
      try {
        reservation = await options.core.operationWithTransaction(key.context, key.reservationId,
          'agent.workspace.create.reservation', key.params, async () => {
            input.signal.throwIfAborted()
            return { reserved: true }
          }, { signal: input.signal })
      } catch (error) {
        input.signal.throwIfAborted()
        diagnose('reservation', 'receipt_write_failed', error)
        return readResult(input)
      }
      if (reservation.replayed) return readResult(input)
      if (!await activeAfterReservation(input.signal, 'before_write')) return { kind: 'unknown' }

      let value: Record<string, unknown>
      let phase = 'create_declaration'
      try {
        const { workspace_name: name, kind, enabled = true, project_id } = input.args
        if (kind === 'directory') {
          phase = 'create_directory'
          const directory = await options.createDirectory(expected.ownerId, name)
          input.signal.throwIfAborted()
          phase = 'read_directory_declaration'
          const rows = await options.listWorkspaces(expected.ownerId, input.signal)
          const workspace = rows.find(row => row.kind === 'directory' && Number(row.directory_id) === directory.id)
          if (!workspace || !Number.isSafeInteger(Number(workspace.id))) throw new Error('新建工作区目录后未找到对应工作区绑定')
          value = { success: true, workspace }
        } else {
          const created = await options.createDeclaration(expected.ownerId, {
            name, kind, enabled,
            ...(kind === 'project' && project_id !== undefined ? { projectId: project_id } : {}),
          })
          input.signal.throwIfAborted()
          phase = 'read_declaration'
          const workspace = await options.readWorkspace(expected.ownerId, created.id, input.signal)
          if (!workspace) throw new Error('工作区创建后未能读取对应声明')
          value = { success: true, workspace }
        }
      } catch (error) {
        input.signal.throwIfAborted()
        diagnose(phase, 'operation_failed', error)
        return { kind: 'unknown' }
      }
      if (!await activeAfterReservation(input.signal, 'before_result')) return { kind: 'unknown' }
      try {
        const saved = await options.core.operationWithTransaction(key.context, key.resultId,
          'agent.workspace.create.result', key.params, async () => value, { signal: input.signal })
        return { kind: 'completed', successful: true, mutated: !saved.replayed, value: saved.result }
      } catch (error) {
        input.signal.throwIfAborted()
        diagnose('result', 'receipt_write_failed', error)
        return readResult(input)
      }
    },
    reconcile: readResult,
  }
}
