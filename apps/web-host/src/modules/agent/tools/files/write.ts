import { createHash } from 'node:crypto'
import { CoreError, dataContext } from '@gugu/core'
import type { RunIdentity, ToolResult } from '@gugu/core/agent'
import type { SqlDataRuntime } from '@gugu/core/data'
import type { FileGrepPort, FileMoveItemsPort, FolderCreatePort, FolderRenamePort } from '@gugu/core/tools'
import type { Pool, QueryResultRow } from 'pg'
import type { FileUpdateOperations } from '../../../files/store.js'
import type { FolderWriteOperations } from '../../../files/folders/write.js'
import type { AgentDispatchLease } from '../../run/dispatch.js'

type FileLocationRow = QueryResultRow & {
  id: number | string
  user_id: string
  version: number | string
  space: string
  project_id: number | string | null
  workspace_directory_id: number | string | null
  folder_id: number | string | null
  display_name: string
  ext: string
}
type FolderLocationRow = QueryResultRow & {
  id: number | string
  user_id: string
  version: number | string
  project_id: number | string | null
  workspace_directory_id: number | string | null
  parent_id: number | string | null
  name: string
}

function sameNullableId(left: unknown, right: unknown): boolean {
  return (left === null ? null : Number(left)) === (right === null ? null : Number(right))
}

function safeItemError(error: unknown): string {
  if (error instanceof CoreError) return error.message
  return '移动失败，请检查目标位置后重试'
}

export interface WebAgentFolderCreateOptions {
  core: SqlDataRuntime
  pool: Pick<Pool, 'query'>
  operations: FolderWriteOperations
  lease: AgentDispatchLease
}

function folderCreateOperationId(parts: readonly string[]): string {
  const hash = createHash('sha256').update(JSON.stringify(parts)).digest('hex')
  const raw = `${hash.slice(0, 12)}5${hash.slice(13, 16)}8${hash.slice(17, 32)}`
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`
}

/** 文件组 Host 创建端口复用现有文件域事务，并以持久预留防止未知创建被重放。 */
export function createWebAgentFolderCreatePort(options: WebAgentFolderCreateOptions): FolderCreatePort {
  if (!options.core.receipts) throw new Error('文件夹创建需要持久调用收据')
  const { core, pool, operations, lease } = options
  if (lease.input.v !== 2 || lease.input.source !== 'web') throw new TypeError('Web Agent 文件夹来源无法验证')
  const expected = Object.freeze({ ...lease.identity })
  const absent = new Error('文件夹创建结果收据不存在')
  function coordinates(input: Parameters<FolderCreatePort['reconcile']>[0]) {
    if (input.identity.ownerId !== expected.ownerId || input.identity.sessionId !== expected.sessionId || input.identity.runId !== expected.runId
      || !/^[1-9]\d*$/.test(input.identity.sessionId) || !input.roundId.trim() || !input.toolCallId.trim())
      throw new Error('文件夹创建授权已失效')
    const context = dataContext(expected.ownerId)
    const parts = ['agent.folder.create', expected.ownerId, expected.sessionId, expected.runId, input.roundId, input.toolCallId]
    return { context, params: input.args,
      reservationId: folderCreateOperationId([...parts, 'reservation']),
      resultId: folderCreateOperationId([...parts, 'result']) }
  }
  async function active(signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted()
    const result = await pool.query(`SELECT 1 FROM conversation_sessions s
      JOIN agent_run_dispatch d ON d.user_id=s.user_id AND d.session_id=s.id
      WHERE s.user_id=$1 AND s.id=$2 AND s.active_run_id=$3 AND d.run_id=$3 AND d.state='selected'
        AND d.token=$4 AND d.fence=$5 AND d.lease_expires_at>clock_timestamp()`,
    [expected.ownerId, expected.sessionId, expected.runId, lease.token, lease.fence])
    signal.throwIfAborted()
    return result.rowCount === 1
  }
  async function readResult(input: Parameters<FolderCreatePort['reconcile']>[0]): Promise<ToolResult> {
    try {
      const key = coordinates(input)
      const saved = await core.operationWithTransaction(key.context, key.resultId,
        'agent.folder.create.result', key.params, async () => { throw absent })
      const result = saved.result as ToolResult
      return result.kind === 'completed' ? { ...result, mutated: false } : result
    } catch { return { kind: 'unknown' } }
  }
  return {
    async create(input) {
      input.signal.throwIfAborted()
      if (input.identity.ownerId !== expected.ownerId || input.identity.sessionId !== expected.sessionId || input.identity.runId !== expected.runId
        || !await active(input.signal)) return { kind: 'completed', successful: false, mutated: false, executed: false, value: { error: '文件夹创建授权已失效' } }
      const key = coordinates(input)
      let reservation
      try {
        reservation = await core.operationWithTransaction(key.context, key.reservationId,
          'agent.folder.create.reservation', key.params, async () => {
            input.signal.throwIfAborted()
            return { reserved: true }
          }, { signal: input.signal })
      } catch (error) {
        input.signal.throwIfAborted()
        return readResult(input)
      }
      if (reservation.replayed) return readResult(input)
      if (!await active(input.signal)) return { kind: 'unknown' }

      let result: ToolResult
      try {
        const folder = await operations.create(expected.ownerId, {
          name: input.args.folder_name,
          projectId: input.args.project_id ?? null,
          workspaceDirectoryId: input.args.workspace_directory_id ?? null,
          parentId: input.args.parent_id ?? null,
        }, { undoContextId: `agent:${expected.sessionId}:${expected.runId}`.slice(0, 128), origin: null })
        input.signal.throwIfAborted()
        if (!folder || typeof folder !== 'object' || Array.isArray(folder)) return { kind: 'unknown' }
        const value = folder as Record<string, unknown>
        if (!Number.isSafeInteger(value.id) || typeof value.name !== 'string' || !Number.isSafeInteger(value.version)
          || !Number.isSafeInteger(value.fileCount) || !Number.isSafeInteger(value.folderCount)) return { kind: 'unknown' }
        result = { kind: 'completed', successful: true, mutated: true, value: {
          folder_id: Number(value.id), name: value.name, version: Number(value.version),
          file_count: Number(value.fileCount), folder_count: Number(value.folderCount),
        } }
      } catch (error) {
        input.signal.throwIfAborted()
        if (!(error instanceof CoreError && error.code === 'not_found')) return { kind: 'unknown' }
        result = { kind: 'completed', successful: false, mutated: false, value: { error: '目标空间不存在或无权访问' } }
      }
      if (!await active(input.signal)) return { kind: 'unknown' }
      try {
        const saved = await core.operationWithTransaction(key.context, key.resultId,
          'agent.folder.create.result', key.params, async () => result, { signal: input.signal })
        const persisted = saved.result as ToolResult
        return saved.replayed && persisted.kind === 'completed' ? { ...persisted, mutated: false } : persisted
      } catch {
        input.signal.throwIfAborted()
        return readResult(input)
      }
    },
    reconcile: readResult,
  }
}

/** 按可信 owner 执行 CAS 重命名，并以持久回执防止未知提交被重复执行。 */
export function createWebAgentFolderRenamePort(options: WebAgentFolderCreateOptions): FolderRenamePort {
  const { core, pool, operations, lease } = options
  if (!core.receipts) throw new Error('文件夹重命名需要持久调用收据')
  if (lease.input.v !== 2 || lease.input.source !== 'web') throw new TypeError('Web Agent 文件夹来源无法验证')
  const expected = Object.freeze({ ...lease.identity })
  const absent = new Error('文件夹重命名结果收据不存在')
  function coordinates(input: Parameters<FolderRenamePort['reconcile']>[0]) {
    if (input.identity.ownerId !== expected.ownerId || input.identity.sessionId !== expected.sessionId || input.identity.runId !== expected.runId
      || !/^[1-9]\d*$/.test(input.identity.sessionId) || !input.roundId.trim() || !input.toolCallId.trim())
      throw new Error('文件夹重命名授权已失效')
    const context = dataContext(expected.ownerId)
    const parts = ['agent.folder.rename', expected.ownerId, expected.sessionId, expected.runId, input.roundId, input.toolCallId]
    const params = { folder_id: input.folderId, name: input.name, expected_version: input.expectedVersion }
    return { context, params, reservationId: folderCreateOperationId([...parts, 'reservation']),
      resultId: folderCreateOperationId([...parts, 'result']) }
  }
  async function active(signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted()
    const result = await pool.query(`SELECT 1 FROM conversation_sessions s
      JOIN agent_run_dispatch d ON d.user_id=s.user_id AND d.session_id=s.id
      WHERE s.user_id=$1 AND s.id=$2 AND s.active_run_id=$3 AND d.run_id=$3 AND d.state='selected'
        AND d.token=$4 AND d.fence=$5 AND d.lease_expires_at>clock_timestamp()`,
    [expected.ownerId, expected.sessionId, expected.runId, lease.token, lease.fence])
    signal.throwIfAborted()
    return result.rowCount === 1
  }
  async function readResult(input: Parameters<FolderRenamePort['reconcile']>[0]): Promise<ToolResult> {
    try {
      const key = coordinates(input)
      const saved = await core.operationWithTransaction(key.context, key.resultId,
        'agent.folder.rename.result', key.params, async () => { throw absent })
      const result = saved.result as ToolResult
      return result.kind === 'completed' ? { ...result, mutated: false } : result
    } catch { return { kind: 'unknown' } }
  }
  return {
    async rename(input) {
      input.signal.throwIfAborted()
      if (input.identity.ownerId !== expected.ownerId || input.identity.sessionId !== expected.sessionId || input.identity.runId !== expected.runId
        || !await active(input.signal)) return { kind: 'completed', successful: false, mutated: false, executed: false, value: { error: '文件夹重命名授权已失效' } }
      const key = coordinates(input)
      let reservation
      try {
        reservation = await core.operationWithTransaction(key.context, key.reservationId,
          'agent.folder.rename.reservation', key.params, async () => {
            input.signal.throwIfAborted()
            return { reserved: true }
          }, { signal: input.signal })
      } catch {
        input.signal.throwIfAborted()
        return readResult(input)
      }
      if (reservation.replayed) return readResult(input)
      if (!await active(input.signal)) return { kind: 'unknown' }

      let result: ToolResult
      try {
        const selected = await pool.query<FolderLocationRow>(`SELECT id,user_id::text AS user_id,version,project_id,workspace_directory_id,parent_id,name
          FROM folders WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`, [input.folderId, expected.ownerId])
        input.signal.throwIfAborted()
        const folder = selected.rows[0]
        if (!folder) result = { kind: 'completed', successful: false, mutated: false, value: { error: '文件夹不存在或无权访问' } }
        else {
          const version = Number(folder.version)
          if (input.expectedVersion !== undefined && input.expectedVersion !== version)
            result = { kind: 'completed', successful: false, mutated: false, value: { error: '文件夹已被修改，请刷新后重试' } }
          else if (folder.name === input.name)
            result = { kind: 'completed', successful: false, mutated: false, value: { error: '文件夹名称未变化' } }
          else {
            const updated = await operations.rename(expected.ownerId, input.folderId, { name: input.name, version }, {
              undoContextId: `agent:${expected.sessionId}:${expected.runId}`.slice(0, 128), origin: null,
            })
            input.signal.throwIfAborted()
            if (!updated || typeof updated !== 'object' || Array.isArray(updated)) return { kind: 'unknown' }
            const value = updated as Record<string, unknown>
            if (typeof value.name !== 'string' || !Number.isSafeInteger(value.version)) return { kind: 'unknown' }
            result = { kind: 'completed', successful: true, mutated: true, value: {
              folder_id: input.folderId, name: value.name, version: Number(value.version),
            } }
          }
        }
      } catch (error) {
        input.signal.throwIfAborted()
        if (error instanceof CoreError && error.code === 'not_found')
          result = { kind: 'completed', successful: false, mutated: false, value: { error: '文件夹不存在或无权访问' } }
        else if (error instanceof CoreError && error.code === 'conflict'
          && ['文件夹已被修改，请刷新后重试', '同名文件夹已存在'].includes(error.message))
          result = { kind: 'completed', successful: false, mutated: false, value: { error: error.message } }
        else return { kind: 'unknown' }
      }
      if (!await active(input.signal)) return { kind: 'unknown' }
      try {
        const saved = await core.operationWithTransaction(key.context, key.resultId,
          'agent.folder.rename.result', key.params, async () => result, { signal: input.signal })
        const persisted = saved.result as ToolResult
        return saved.replayed && persisted.kind === 'completed' ? { ...persisted, mutated: false } : persisted
      } catch {
        input.signal.throwIfAborted()
        return readResult(input)
      }
    },
    reconcile: readResult,
  }
}

/** 按 owner/lease 查询来源版本，再逐项委托文件 CAS 与文件夹树移动事务。 */
export function createWebAgentMoveItemsPort(
  pool: Pick<Pool, 'query'>,
  fileOperations: FileUpdateOperations,
  folderOperations: FolderWriteOperations,
  lease: AgentDispatchLease,
  files?: Pick<FileGrepPort, 'list'>,
): FileMoveItemsPort {
  const expected = Object.freeze({ ...lease.identity })
  const matchesLease = (identity: RunIdentity) => identity.ownerId === expected.ownerId
    && identity.sessionId === expected.sessionId && identity.runId === expected.runId
  const metadata = { idempotencyKey: null, undoContextId: `agent:${expected.sessionId}:${expected.runId}`.slice(0, 128), clientId: null }
  const folderMetadata = { undoContextId: metadata.undoContextId, origin: null }
  return {
    async move(identity, input, signal) {
      if (!matchesLease(identity)) throw new CoreError('invalid_request', '工具运行身份无效')
      const movedFiles: Record<string, unknown>[] = []
      const movedFolders: Record<string, unknown>[] = []
      const failed: Record<string, unknown>[] = []
      const targetProjectId = input.target.space === 'project' ? input.target.project_id! : null
      const targetFolderId = input.target.folder_id ?? null
      const candidates = input.files.some(file => typeof file === 'string')
        ? files && matchesLease(identity) ? await files.list(identity, signal) : []
        : []

      for (const item of input.files) {
        signal.throwIfAborted()
        const id = typeof item === 'number' ? item : candidates.filter(file => file.path === item).length === 1
          ? candidates.find(file => file.path === item)!.file_id : null
        if (id === null) {
          failed.push({ item, kind: 'file', error: '文件路径不存在或不唯一；请用 list_dir 确认' })
          continue
        }
        try {
          const result = await pool.query<FileLocationRow>(`SELECT id,user_id::text AS user_id,version,space,project_id,workspace_directory_id,folder_id,display_name,ext
            FROM files WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`, [id, expected.ownerId])
          const file = result.rows[0]
          if (!file) throw new CoreError('not_found', '文件不存在')
          const samePlace = sameNullableId(file.project_id, targetProjectId)
            && file.workspace_directory_id === null && sameNullableId(file.folder_id, targetFolderId)
          if (samePlace) throw new CoreError('invalid_request', '文件已在目标位置')
          const updated = await fileOperations.update(expected.ownerId, id, {
            version: Number(file.version), folderId: targetFolderId, projectId: targetProjectId,
            workspaceDirectoryId: null, folderSet: true, projectSet: true, workspaceDirectorySet: true,
          }, metadata)
          if (!updated || typeof updated !== 'object' || Array.isArray(updated)) throw new Error('文件移动状态未知')
          const value = updated as Record<string, unknown>
          movedFiles.push({ file_id: id, name: `${String(value.displayName ?? file.display_name)}.${String(value.ext ?? file.ext)}`,
            space: input.target.space, project_id: targetProjectId, folder_id: targetFolderId })
        } catch (error) {
          failed.push({ item: id, kind: 'file', error: safeItemError(error) })
        }
      }

      for (const id of input.folders) {
        signal.throwIfAborted()
        try {
          const result = await pool.query<FolderLocationRow>(`SELECT id,user_id::text AS user_id,version,project_id,workspace_directory_id,parent_id,name
            FROM folders WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`, [id, expected.ownerId])
          const folder = result.rows[0]
          if (!folder) throw new CoreError('not_found', '文件夹不存在')
          if (sameNullableId(folder.project_id, targetProjectId) && folder.workspace_directory_id === null
            && sameNullableId(folder.parent_id, targetFolderId)) throw new CoreError('invalid_request', '文件夹已在目标位置')
          const moved = await folderOperations.move(expected.ownerId, id, {
            parentId: targetFolderId, version: Number(folder.version), projectId: targetProjectId, projectSet: true,
            workspaceDirectoryId: null, workspaceDirectorySet: true,
          }, folderMetadata)
          if (!moved || typeof moved !== 'object' || Array.isArray(moved)) throw new Error('文件夹移动状态未知')
          const value = moved as Record<string, unknown>
          movedFolders.push({ folder_id: id, name: String(value.name ?? folder.name),
            folder_count: Number(value.folderCount ?? 0), space: input.target.space, project_id: targetProjectId })
        } catch (error) {
          failed.push({ item: id, kind: 'folder', error: safeItemError(error) })
        }
      }

      return { moved_files: movedFiles.length, moved_folders: movedFolders.length, failed_count: failed.length,
        files: movedFiles, folders: movedFolders, failed }
    },
  }
}
