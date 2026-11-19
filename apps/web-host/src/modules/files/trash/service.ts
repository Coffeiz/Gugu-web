import { CoreError } from '@gugu/core'
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'
import type { PoolClient, Pool, QueryResultRow } from 'pg'
import { link, lstat, mkdir, realpath, rm, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { isPathWithin } from '../../../shared/path-safety.js'
import { isOwnedFileStorageKey, normalizeFileOwnerId, parseFileId } from '../store.js'
import { lockFileSyncPath, lockFileSyncPaths } from '../storage/sync.js'
import { buildOriginalKey } from '@gugu/core/project-file-paths'

export interface FileDeleteReceipt {
  operationId: string
  fingerprint: string
  method: 'agent.file.delete_file'
}

export interface FileDeleteAgentResult {
  result: Record<string, unknown>
  replayed: boolean
}

export interface FileDeleteAgentOperation {
  receipt: FileDeleteReceipt
  signal: AbortSignal
  authorize(client: Pick<PoolClient, 'query'>): Promise<void>
}

export interface FileDeleteOperations {
  remove(ownerId: string, fileId: number, undoContextId: string | null, clientId: string | null,
    operation?: FileDeleteAgentOperation): Promise<void | FileDeleteAgentResult | { kind: 'unknown' }>
  removeMany?(ownerId: string, fileIds: number[], undoContextId: string | null, clientId: string | null,
    operation?: FileDeleteAgentOperation): Promise<void | FileDeleteAgentResult | { kind: 'unknown' }>
}

export interface FileDeleteRouteOptions {
  requireUser: preHandlerHookHandler
  ownerIdFromRequest(request: FastifyRequest): string
  operations: FileDeleteOperations
}

function fileId(value: string): number {
  if (!/^[+-]?\d+$/.test(value)) throw new CoreError('invalid_request', '文件 ID 无效')
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw new CoreError('invalid_request', '文件 ID 无效')
  return parsed
}

function requestHeader(request: FastifyRequest, name: string): string | null {
  const value = request.headers[name]
  return typeof value === 'string' ? value.trim().slice(0, 128) || null : null
}

export function registerFileDeleteRoutes(app: FastifyInstance, options: FileDeleteRouteOptions): void {
  app.delete<{ Params: { fid: string } }>('/api/v1/files/:fid', {
    preHandler: options.requireUser,
  }, async (request, reply) => {
    await options.operations.remove(
      options.ownerIdFromRequest(request),
      fileId(request.params.fid),
      requestHeader(request, 'x-undo-context-id'),
      requestHeader(request, 'x-client-id'),
    )
    return reply.code(204).send()
  })
  if (options.operations.removeMany) {
    app.post('/api/v1/files/batch-delete', { preHandler: options.requireUser }, async (request, reply) => {
      const body = request.body
      if (!body || typeof body !== 'object' || Array.isArray(body))
        throw new CoreError('invalid_request', '批量删除参数无效')
      const ids = (body as Record<string, unknown>).ids
      if (!Array.isArray(ids) || ids.some((id) => !Number.isSafeInteger(id)))
        throw new CoreError('invalid_request', '文件 ID 列表无效')
      await options.operations.removeMany!(
        options.ownerIdFromRequest(request),
        ids as number[],
        requestHeader(request, 'x-undo-context-id'),
        requestHeader(request, 'x-client-id'),
      )
      return reply.code(204).send()
    })
  }
}

interface FileRow extends QueryResultRow {
  id: number | string
  user_id: string
  display_name: string
  ext: string
  space: string
  project_id: number | string | null
  folder_id: number | string | null
  workspace_directory_id: number | string | null
  stage_name: string
  mind_map_id: number | string | null
  storage_key: string
  version: number | string
  size: string
  size_bytes: number | string
  mime_type: string | null
  img_width: number | string | null
  img_height: number | string | null
  deleted_at: Date | string | null
}

function safeSegment(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, '_')
}

function trashKey(ownerId: string, storageKey: string, displayName: string, ext: string): string {
  const prefix = `${ownerId}/`
  const parent = storageKey.slice(0, storageKey.lastIndexOf('/'))
  let logicalParent = parent.startsWith(prefix) ? parent.slice(prefix.length) : ''
  logicalParent = logicalParent.includes('/') ? logicalParent.slice(logicalParent.indexOf('/') + 1) : ''
  const filename = `${safeSegment(displayName)}${ext ? `.${ext.toLowerCase()}` : ''}`
  return `${ownerId}/trash/${logicalParent ? `${logicalParent}/` : ''}${filename}`
}

async function removeMatchingLink(keep: string, remove: string): Promise<void> {
  try {
    const [a, b] = await Promise.all([lstat(keep), lstat(remove)])
    if (a.isFile() && b.isFile() && a.dev === b.dev && a.ino === b.ino) { await unlink(remove); return }
    console.error('文件删除清理遇到路径变化，可能存在残留')
  } catch { console.error('文件删除清理失败，可能存在残留') }
}

async function safePath(storageRoot: string, key: string): Promise<{ root: string; target: string }> {
  const segments = key.split('/')
  if (segments.length < 2 || segments.some((part) => !part || part === '.' || part === '..' || part.includes('\\') || part.includes('\0')))
    throw new CoreError('storage_error', '文件存储位置无效')
  const root = await realpath(storageRoot)
  let target = root
  for (const segment of segments) {
    target = path.resolve(target, segment)
    if (!isPathWithin(root, target)) throw new CoreError('storage_error', '文件存储位置无效')
    try {
      if ((await lstat(target)).isSymbolicLink()) throw new CoreError('storage_error', '文件存储位置无效')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return { root, target }
}

async function availableTrashKey(
  client: PoolClient, storageRoot: string, ownerId: string, baseKey: string, displayName: string, ext: string,
): Promise<string> {
  let suffix = 0
  while (true) {
    const name = suffix === 0 ? displayName : `${displayName}(${suffix})`
    const key = suffix === 0 ? baseKey
      : `${baseKey.slice(0, baseKey.lastIndexOf('/') + 1)}${safeSegment(name)}${ext ? `.${ext.toLowerCase()}` : ''}`
    const diskPath = await safePath(storageRoot, key)
    const exists = await stat(diskPath.target).then(
      () => true,
      (error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? false : Promise.reject(error),
    )
    const row = await client.query(
      'SELECT 1 FROM files WHERE user_id=$1 AND storage_key=$2 AND deleted_at IS NULL', [ownerId, key],
    )
    if (!exists && !row.rowCount) return key
    suffix++
  }
}

function snapshot(file: FileRow) {
  return {
    id: Number(file.id), display_name: file.display_name, ext: file.ext, space: file.space,
    project_id: file.project_id === null ? null : Number(file.project_id),
    folder_id: file.folder_id === null ? null : Number(file.folder_id),
    workspace_directory_id: file.workspace_directory_id === null ? null : Number(file.workspace_directory_id),
    stage_name: file.stage_name, mind_map_id: file.mind_map_id === null ? null : Number(file.mind_map_id),
    storage_key: file.storage_key, version: Number(file.version), size: file.size,
    size_bytes: Number(file.size_bytes), mime_type: file.mime_type,
    img_width: file.img_width === null ? null : Number(file.img_width),
    img_height: file.img_height === null ? null : Number(file.img_height),
    deleted_at: file.deleted_at instanceof Date ? file.deleted_at.toISOString() : file.deleted_at,
  }
}

async function recordBatchDeleteUndo(
  client: PoolClient, ownerId: string, contextId: string | null, beforeRows: FileRow[], afterRows: FileRow[],
): Promise<void> {
  const context = contextId?.trim().slice(0, 128)
  if (!context || !beforeRows.length) return
  const before = Object.fromEntries(beforeRows.map((file) => [`file:${file.id}`, snapshot(file)]))
  const after = Object.fromEntries(afterRows.map((file) => [`file:${file.id}`, snapshot(file)]))
  const refs = beforeRows.map((file) => ({ kind: 'file', id: Number(file.id) }))
  const versions = Object.fromEntries(beforeRows.map((file) => [`file:${file.id}`, { version: Number(file.version) }]))
  await client.query(
    `UPDATE undo_operations SET status='expired',failure_code='redo_cleared_by_new_operation'
     WHERE user_id=$1 AND undo_context_id=$2 AND actor_type='web' AND status='undone'`, [ownerId, context],
  )
  await client.query(
    `INSERT INTO undo_operations (id,user_id,undo_context_id,group_id,resource,action,target_refs,
       before_state,after_state,base_versions,artifact_refs,actor_type,status,created_at,expires_at,undone_at,failure_code)
     VALUES ($1,$2,$3,$4,'files','delete',$5::json,$6::json,$7::json,$8::json,'{}'::json,
       'web','active',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP+INTERVAL '30 days',NULL,NULL)`,
    [`op-${randomUUID().replaceAll('-', '')}`, ownerId, context, `group-${randomUUID().replaceAll('-', '')}`,
      JSON.stringify(refs), JSON.stringify({ items: before }), JSON.stringify({ items: after }), JSON.stringify(versions)],
  )
}

export function createPostgresFileDeleteOperations(
  pool: Pool,
  options: {
    storageRoot: string
    createDeleteLink?: typeof link
    publishChanged(event: { ownerId: string; entityId: number; origin: string | null }): Promise<void>
  },
): FileDeleteOperations {
  return {
    async remove(rawOwnerId, fileId, undoContextId, clientId, operation) {
      const ownerId = normalizeFileOwnerId(rawOwnerId)
      if (!Number.isSafeInteger(fileId)) throw new CoreError('invalid_request', '文件 ID 无效')
      const client = await pool.connect()
      let sourcePath: string | null = null
      let destinationPath: string | null = null
      let moved = false
      let committed = false
      let commitAttempted = false
      let operationResult: FileDeleteAgentResult | undefined
      try {
        await client.query('BEGIN')
        // 先串行化同一用户的回收站目标分配，再取得文件行和来源路径锁。
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('file-trash:' || $1, 0))", [ownerId])
        operation?.signal.throwIfAborted()
        await operation?.authorize(client)
        if (operation) {
          await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${ownerId}:${operation.receipt.operationId}`])
          const previous = await readFileDeleteReceipt(client, ownerId, operation.receipt)
          if (previous) {
            await client.query('COMMIT')
            committed = true
            return { result: previous, replayed: true }
          }
        }
        const result = await client.query<FileRow>(
          'SELECT * FROM files WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL FOR UPDATE', [fileId, ownerId],
        )
        const before = result.rows[0]
        if (!before) throw new CoreError('not_found', '文件不存在')
        if (!isOwnedFileStorageKey(ownerId, before.storage_key)) throw new CoreError('not_found', '文件不存在')
        await lockFileSyncPath(client, ownerId, before.storage_key)
        sourcePath = (await safePath(options.storageRoot, before.storage_key)).target
        const destinationKey = await availableTrashKey(
          client, options.storageRoot, ownerId,
          trashKey(ownerId, before.storage_key, before.display_name, before.ext), before.display_name, before.ext,
        )
        destinationPath = (await safePath(options.storageRoot, destinationKey)).target
        await mkdir(path.dirname(destinationPath), { recursive: true, mode: 0o700 })
        await (options.createDeleteLink ?? link)(sourcePath, destinationPath)
        moved = true
        const updated = await client.query<FileRow>(
          `UPDATE files SET storage_key=$3,deleted_at=CURRENT_TIMESTAMP,version=version+1,updated_at=CURRENT_TIMESTAMP
           WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL RETURNING *`, [fileId, ownerId, destinationKey],
        )
        const after = updated.rows[0]
        if (!after) throw new CoreError('not_found', '文件不存在')
        await recordBatchDeleteUndo(client, ownerId, undoContextId, [before], [after])
        if (operation) {
          operation.signal.throwIfAborted()
          operationResult = { replayed: false, result: { success: true, file_id: fileId,
            name: `${before.display_name}.${before.ext}`, note: '已移入回收站，30 天内可还原',
            _file_op: { op: 'remove', kind: 'file', id: fileId } } }
          await writeFileDeleteReceipt(client, ownerId, operation.receipt, operationResult.result)
        }
        operation?.signal.throwIfAborted()
        commitAttempted = true
        await client.query('COMMIT')
        committed = true
        if (sourcePath && destinationPath) await removeMatchingLink(destinationPath, sourcePath)
      } catch (error) {
        if (!committed) {
          await client.query('ROLLBACK').catch(() => undefined)
          if (moved && sourcePath && destinationPath) {
            await mkdir(path.dirname(sourcePath), { recursive: true, mode: 0o700 }).catch(() => undefined)
            if (!commitAttempted) await removeMatchingLink(sourcePath, destinationPath)
            else console.error('文件删除提交结果未知，保留两处文件供核查')
          }
        }
        if (!committed && commitAttempted && operation)
          throw new CoreError('storage_error', '文件删除提交结果未知')
        throw error
      } finally {
        client.release()
      }
      await options.publishChanged({ ownerId, entityId: fileId, origin: clientId }).catch(() => undefined)
      return operationResult
    },

    async removeMany(rawOwnerId, fileIds, undoContextId, clientId, operation) {
      const ownerId = normalizeFileOwnerId(rawOwnerId)
      if (fileIds.some((id) => !Number.isSafeInteger(id))) throw new CoreError('invalid_request', '文件 ID 无效')
      if (new Set(fileIds).size !== fileIds.length) throw new CoreError('invalid_request', '文件 ID 不能重复')
      if (!fileIds.length) return
      const client = await pool.connect()
      const movedFiles: Array<{ sourcePath: string; destinationPath: string }> = []
      let committed = false
      let commitAttempted = false
      let changedIds: number[] = []
      let operationResult: FileDeleteAgentResult | undefined
      try {
        await client.query('BEGIN')
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('file-trash:' || $1, 0))", [ownerId])
        operation?.signal.throwIfAborted()
        await operation?.authorize(client)
        if (operation) {
          await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${ownerId}:${operation.receipt.operationId}`])
          const previous = await readFileDeleteReceipt(client, ownerId, operation.receipt)
          if (previous) {
            await client.query('COMMIT')
            committed = true
            return { result: previous, replayed: true }
          }
        }
        const result = await client.query<FileRow>(
          `SELECT * FROM files WHERE id=ANY($1::integer[]) AND user_id=$2 AND deleted_at IS NULL
           ORDER BY storage_key,id FOR UPDATE`, [fileIds, ownerId],
        )
        const beforeRows = result.rows
        if (operation && beforeRows.length !== fileIds.length) throw new CoreError('not_found', '文件不存在')
        if (beforeRows.some((file) => !isOwnedFileStorageKey(ownerId, file.storage_key)))
          throw new CoreError('not_found', '文件不存在')
        if (!beforeRows.length) {
          commitAttempted = true
          await client.query('COMMIT')
          committed = true
          return
        }
        await lockFileSyncPaths(client, ownerId, beforeRows.map((file) => file.storage_key))
        for (const before of beforeRows) {
          const sourcePath = (await safePath(options.storageRoot, before.storage_key)).target
          const destinationKey = await availableTrashKey(
            client, options.storageRoot, ownerId,
            trashKey(ownerId, before.storage_key, before.display_name, before.ext), before.display_name, before.ext,
          )
          const destinationPath = (await safePath(options.storageRoot, destinationKey)).target
          await mkdir(path.dirname(destinationPath), { recursive: true, mode: 0o700 })
          await (options.createDeleteLink ?? link)(sourcePath, destinationPath)
          movedFiles.push({ sourcePath, destinationPath })
          const updated = await client.query<FileRow>(
            `UPDATE files SET storage_key=$3,deleted_at=CURRENT_TIMESTAMP,version=version+1,updated_at=CURRENT_TIMESTAMP
             WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL RETURNING *`,
            [before.id, ownerId, destinationKey],
          )
          if (!updated.rows[0]) throw new CoreError('not_found', '文件不存在')
        }
        const current = await client.query<FileRow>(
          'SELECT * FROM files WHERE id=ANY($1::integer[]) AND user_id=$2 ORDER BY id',
          [beforeRows.map((file) => Number(file.id)), ownerId],
        )
        await recordBatchDeleteUndo(client, ownerId, undoContextId, beforeRows, current.rows)
        if (operation) {
          operation.signal.throwIfAborted()
          const byId = new Map(beforeRows.map(file => [Number(file.id), file]))
          operationResult = { replayed: false, result: { success: true, deleted_count: fileIds.length,
            results: fileIds.map(id => {
              const file = byId.get(id)!
              return { file_id: id, name: `${file.display_name}.${file.ext}`, note: '已移入回收站，30 天内可还原',
                _file_op: { op: 'remove', kind: 'file', id } }
            }) } }
          await writeFileDeleteReceipt(client, ownerId, operation.receipt, operationResult.result)
        }
        operation?.signal.throwIfAborted()
        commitAttempted = true
        await client.query('COMMIT')
        committed = true
        for (const move of movedFiles) await removeMatchingLink(move.destinationPath, move.sourcePath)
        changedIds = beforeRows.map((file) => Number(file.id))
      } catch (error) {
        if (!committed) {
          await client.query('ROLLBACK').catch(() => undefined)
          for (const move of movedFiles.reverse()) {
            await mkdir(path.dirname(move.sourcePath), { recursive: true, mode: 0o700 }).catch(() => undefined)
            if (!commitAttempted) await removeMatchingLink(move.sourcePath, move.destinationPath)
            else console.error('文件批量删除提交结果未知，保留两处文件供核查')
          }
        }
        if (!committed && commitAttempted && operation)
          throw new CoreError('storage_error', '文件删除提交结果未知')
        throw error
      } finally {
        client.release()
      }
      for (const entityId of changedIds)
        await options.publishChanged({ ownerId, entityId, origin: clientId }).catch(() => undefined)
      return operationResult
    },
  }
}

async function readFileDeleteReceipt(
  client: Pick<PoolClient, 'query'>, ownerId: string, receipt: FileDeleteAgentOperation['receipt'],
): Promise<Record<string, unknown> | null> {
  const result = await client.query<{ method: string; fingerprint: string; result_json: string }>(
    'SELECT method,fingerprint,result_json FROM core_operation_receipts WHERE owner_id=$1 AND operation_id=$2',
    [ownerId, receipt.operationId],
  )
  const row = result.rows[0]
  if (!row) return null
  if (row.method !== receipt.method || row.fingerprint !== receipt.fingerprint)
    throw new CoreError('conflict', '操作标识已用于不同内容')
  const value: unknown = JSON.parse(row.result_json)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CoreError('storage_error', '文件删除回执无效')
  return value as Record<string, unknown>
}

async function writeFileDeleteReceipt(
  client: Pick<PoolClient, 'query'>, ownerId: string, receipt: FileDeleteAgentOperation['receipt'], value: Record<string, unknown>,
): Promise<void> {
  await client.query(`INSERT INTO core_operation_receipts(owner_id,operation_id,method,fingerprint,result_json,created_at)
    VALUES($1,$2,$3,$4,$5,CURRENT_TIMESTAMP)`, [ownerId, receipt.operationId, receipt.method, receipt.fingerprint, JSON.stringify(value)])
}

export interface FileRestoreOperations {
  restore(ownerId: string, fileId: number, origin?: string | null): Promise<void>
  restoreBatch?(ownerId: string, fileIds: number[], origin?: string | null): Promise<void>
  restoreFolder?(ownerId: string, folderId: number, origin?: string | null): Promise<unknown>
}

export interface FileRestoreRouteOptions {
  requireUser: preHandlerHookHandler
  ownerIdFromRequest(request: FastifyRequest): string
  operations: FileRestoreOperations
}

export function registerFileRestoreRoutes(app: FastifyInstance, options: FileRestoreRouteOptions): void {
  app.post<{ Params: { fid: string } }>('/api/v1/trash/:fid/restore', {
    preHandler: options.requireUser,
  }, async (request, reply) => {
    const rawClientId = request.headers['x-client-id']
    const clientId = typeof rawClientId === 'string' ? rawClientId.trim().slice(0, 128) || null : null
    await options.operations.restore(options.ownerIdFromRequest(request), parseFileId(request.params.fid), clientId)
    return reply.code(204).send()
  })
}

interface RestoreRow extends QueryResultRow {
  id: number | string
  user_id: string
  display_name: string
  ext: string
  space: string
  project_id: number | string | null
  folder_id: number | string | null
  workspace_directory_id: number | string | null
  stage_name: string
  mind_map_id: number | string | null
  storage_key: string
  version: number | string
  size: string
  size_bytes: number | string
  mime_type: string | null
  img_width: number | string | null
  img_height: number | string | null
  created_at: Date | string
  deleted_at: Date | string | null
}

interface FolderRow extends QueryResultRow {
  id: number | string
  project_id: number | string | null
  workspace_directory_id: number | string | null
  parent_id: number | string | null
  name: string
  deleted_at: Date | string | null
  depth: number
  deleted_stamp: string
  version: number | string
}

class RestoreStoragePathError extends Error {}

function safeName(value: string): string { return value.replace(/[\\/:*?"<>|]/g, '_') }

function safeKey(ownerId: string, key: string): string[] {
  const parts = key.split('/')
  if (parts[0] !== ownerId || parts.length < 2
    || parts.some((part) => !part || part === '.' || part === '..' || part.includes('\\') || part.includes('\0')))
    throw new RestoreStoragePathError('文件存储位置无效')
  return parts
}

async function checkedPath(root: string, ownerId: string, key: string): Promise<string> {
  const parts = safeKey(ownerId, key)
  const target = path.resolve(root, ...parts)
  if (!isPathWithin(root, target)) throw new RestoreStoragePathError('文件存储位置无效')
  let current = root
  for (const part of parts) {
    current = path.join(current, part)
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new RestoreStoragePathError('文件存储路径不能经过符号链接')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ENOTDIR')
        throw error
    }
  }
  return target
}

function withConflictName(baseKey: string, displayName: string, ext: string, suffix: number) {
  const name = `${displayName}(${suffix})`
  const filename = `${safeName(name)}${ext ? `.${ext.toLowerCase()}` : ''}`
  return { key: `${baseKey.slice(0, baseKey.lastIndexOf('/') + 1)}${filename}`, name }
}

async function removeRestoreLink(keep: string, remove: string): Promise<void> {
  try {
    const [kept, removed] = await Promise.all([lstat(keep), lstat(remove)])
    if (kept.isFile() && removed.isFile() && kept.dev === removed.dev && kept.ino === removed.ino) {
      await unlink(remove)
      return
    }
    console.error('文件恢复清理遇到路径变化，可能存在残留')
  } catch {
    console.error('文件恢复清理失败，可能存在残留')
  }
}

export async function originalStorageKey(
  client: Pick<PoolClient, 'query'>,
  ownerId: string,
  file: Pick<RestoreRow, 'project_id' | 'folder_id' | 'workspace_directory_id' | 'mind_map_id' | 'space' | 'display_name' | 'ext'>,
): Promise<string> {
  let projectName = ''
  let projectDate = ''
  if (file.project_id !== null) {
    const project = await client.query<QueryResultRow & { name: string; start_date: string | null; created_at: Date | string }>(
      `SELECT name,start_date::text AS start_date,created_at FROM projects WHERE id=$1 AND user_id=$2 LIMIT 1`,
      [file.project_id, ownerId],
    )
    const row = project.rows[0]
    if (row) {
      projectName = row.name
      projectDate = row.start_date ?? (row.created_at instanceof Date
        ? row.created_at.toISOString().slice(0, 10) : String(row.created_at).slice(0, 10))
    }
  }

  let folderPath = ''
  if (file.folder_id !== null) {
    const result = await client.query<FolderRow>(
      `WITH RECURSIVE chain AS (
         SELECT id,parent_id,name,ARRAY[id]::integer[] AS visited,0 AS depth
         FROM folders WHERE id=$1 AND user_id=$2
           AND project_id IS NOT DISTINCT FROM $3::integer
           AND workspace_directory_id IS NOT DISTINCT FROM $4::integer
         UNION ALL
         SELECT parent.id,parent.parent_id,parent.name,chain.visited || parent.id,chain.depth+1
         FROM folders AS parent JOIN chain ON parent.id=chain.parent_id
         WHERE parent.user_id=$2
           AND parent.project_id IS NOT DISTINCT FROM $3::integer
           AND parent.workspace_directory_id IS NOT DISTINCT FROM $4::integer
           AND NOT parent.id=ANY(chain.visited)
       )
       SELECT name,parent_id FROM chain ORDER BY depth DESC`,
      [file.folder_id, ownerId, file.project_id, file.workspace_directory_id],
    )
    const rows = result.rows
    if (rows.length && rows[0]?.parent_id === null)
      folderPath = rows.map((row) => safeName(row.name)).join('/')
  }

  let workspaceName = ''
  if (file.workspace_directory_id !== null) {
    const result = await client.query<QueryResultRow & { directory_name: string; deleted_at: Date | string | null }>(
      'SELECT directory_name,deleted_at FROM workspace_directories WHERE id=$1 AND user_id=$2 LIMIT 1',
      [file.workspace_directory_id, ownerId],
    )
    const row = result.rows[0]
    if (!row || row.deleted_at !== null) throw new CoreError('conflict', '工作区目录不存在，无法恢复文件')
    workspaceName = row.directory_name
    if (!workspaceName || workspaceName === '.' || workspaceName === '..' || safeName(workspaceName) !== workspaceName)
      throw new CoreError('invalid_request', '工作区目录名无效')
  }

  let mindMapTitle = ''
  if (file.mind_map_id !== null) {
    const result = await client.query<QueryResultRow & { title: string }>(
      'SELECT title FROM mind_maps WHERE id=$1 AND user_id=$2 LIMIT 1', [file.mind_map_id, ownerId],
    )
    mindMapTitle = result.rows[0]?.title ?? ''
  }

  return buildOriginalKey(ownerId, file, {
    projectName, projectDate, projectId: Number(file.project_id ?? 0), folderPath,
    mindMapTitle, mindMapId: Number(file.mind_map_id ?? 0), workspaceDirectoryName: workspaceName,
  })
}

async function restoreLocalFile(
  rootPath: string,
  ownerId: string,
  file: RestoreRow,
  baseKey: string,
  createLink: typeof link = link,
): Promise<{ storageKey: string; displayName: string; movedFrom: string | null; movedTo: string | null }> {
  const root = await realpath(rootPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (!root || file.storage_key === baseKey)
    return { storageKey: baseKey, displayName: file.display_name, movedFrom: null, movedTo: null }

  let available = { key: baseKey, name: file.display_name }
  for (let suffix = 1; ; suffix += 1) {
    const candidate = suffix === 1 ? available : withConflictName(baseKey, file.display_name, file.ext, suffix - 1)
    const target = await checkedPath(root, ownerId, candidate.key)
    try {
      await lstat(target)
      available = withConflictName(baseKey, file.display_name, file.ext, suffix)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') { available = candidate; break }
      throw error
    }
  }

  const source = await checkedPath(root, ownerId, file.storage_key)
  try {
    for (let suffix = 1; ; suffix += 1) {
      const destination = await checkedPath(root, ownerId, available.key)
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
      try { await createLink(source, destination) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        available = withConflictName(baseKey, file.display_name, file.ext, suffix)
        continue
      }
      try {
        if (!(await lstat(destination)).isFile()) throw new RestoreStoragePathError('恢复文件类型无效')
        const resolved = await realpath(destination)
        if (!isPathWithin(root, resolved)) throw new RestoreStoragePathError('恢复后的文件超出存储根目录')
      } catch (error) {
        await unlink(destination).catch(() => undefined)
        if (error instanceof RestoreStoragePathError) throw error
        throw new CoreError('storage_error', '文件恢复未完成')
      }
      return { storageKey: available.key, displayName: available.name, movedFrom: source, movedTo: destination }
    }
  } catch (error) {
    if (error instanceof RestoreStoragePathError || error instanceof CoreError) throw error
    if (['EXDEV', 'EPERM', 'EOPNOTSUPP', 'ENOTSUP', 'EMLINK'].includes((error as NodeJS.ErrnoException).code ?? ''))
      throw new CoreError('storage_error', '文件存储不支持安全恢复')
    // Python 回收站恢复会在物理文件缺失或搬移失败时仍恢复数据库墓碑。
    return { storageKey: available.key, displayName: available.name, movedFrom: null, movedTo: null }
  }
}

export function createPostgresFileRestoreOperations(
  pool: Pool,
  options: {
    storageRoot: string
    createRestoreLink?: typeof link
    publishChanged(event: { ownerId: string; entityId: number; origin?: string | null; entityType?: 'file' | 'folder' }): Promise<void>
  },
): FileRestoreOperations {
  return {
    async restore(rawOwnerId, fileId, origin = null) {
      const ownerId = normalizeFileOwnerId(rawOwnerId)
      if (!Number.isSafeInteger(fileId) || fileId < 1) throw new CoreError('invalid_request', '文件 ID 无效')
      const client = await pool.connect()
      let committed = false
      let commitAttempted = false
      let movedFrom: string | null = null
      let movedTo: string | null = null
      try {
        await client.query('BEGIN')
        const found = await client.query<RestoreRow>(
          'SELECT * FROM files WHERE id=$1 AND user_id=$2 AND deleted_at IS NOT NULL FOR UPDATE', [fileId, ownerId],
        )
        const file = found.rows[0]
        if (!file) throw new CoreError('not_found', '文件不存在')
        if (file.folder_id !== null) {
          const folder = await client.query<QueryResultRow & { deleted_at: Date | string | null }>(
            'SELECT deleted_at FROM folders WHERE id=$1 AND user_id=$2 LIMIT 1', [file.folder_id, ownerId],
          )
          if (!folder.rows[0] || folder.rows[0].deleted_at !== null)
            throw new CoreError('conflict', '所属文件夹仍在回收站，请先恢复文件夹')
        }
        const baseKey = await originalStorageKey(client, ownerId, file)
        const restored = await restoreLocalFile(options.storageRoot, ownerId, file, baseKey, options.createRestoreLink)
        movedFrom = restored.movedFrom
        movedTo = restored.movedTo
        const updated = await client.query(
          `UPDATE files SET storage_key=$3,display_name=$4,deleted_at=NULL,updated_at=CURRENT_TIMESTAMP
           WHERE id=$1 AND user_id=$2 AND deleted_at IS NOT NULL RETURNING id`,
          [fileId, ownerId, restored.storageKey, restored.displayName],
        )
        if (!updated.rows[0]) throw new CoreError('not_found', '文件不存在')
        commitAttempted = true
        await client.query('COMMIT')
        committed = true
        if (movedFrom && movedTo) await removeRestoreLink(movedTo, movedFrom)
      } catch (error) {
        if (!committed) {
          await client.query('ROLLBACK').catch(() => undefined)
          if (!commitAttempted && movedFrom && movedTo) await removeRestoreLink(movedFrom, movedTo)
          if (commitAttempted) console.error('文件恢复提交结果未知，保留两处文件供核查')
        }
        throw error
      } finally {
        client.release()
      }
      await options.publishChanged({ ownerId, entityId: fileId, origin, entityType: 'file' }).catch(() => undefined)
    },

    async restoreBatch(rawOwnerId, rawFileIds, origin = null) {
      const ownerId = normalizeFileOwnerId(rawOwnerId)
      if (!Array.isArray(rawFileIds) || rawFileIds.some((id) => !Number.isSafeInteger(id) || id < 1))
        throw new CoreError('invalid_request', '文件 ID 列表无效')
      if (!rawFileIds.length) return
      const client = await pool.connect()
      const moved: Array<{ from: string; to: string }> = []
      let committed = false
      let commitAttempted = false
      const restoredFiles: number[] = []
      try {
        await client.query('BEGIN')
        const found = await client.query<RestoreRow>(
          `SELECT * FROM files WHERE id=ANY($1::integer[]) AND user_id=$2 AND deleted_at IS NOT NULL
           ORDER BY id FOR UPDATE`, [rawFileIds, ownerId],
        )
        const files = found.rows
        for (const file of files) {
          if (file.folder_id === null) continue
          const folder = await client.query<QueryResultRow & { deleted_at: Date | string | null }>(
            'SELECT deleted_at FROM folders WHERE id=$1 AND user_id=$2 LIMIT 1', [file.folder_id, ownerId],
          )
          if (!folder.rows[0] || folder.rows[0].deleted_at !== null)
            throw new CoreError('conflict', '所属文件夹仍在回收站，请先恢复文件夹')
        }
        for (const file of files) {
          const baseKey = await originalStorageKey(client, ownerId, file)
          const restored = await restoreLocalFile(options.storageRoot, ownerId, file, baseKey, options.createRestoreLink)
          if (restored.movedFrom && restored.movedTo)
            moved.push({ from: restored.movedFrom, to: restored.movedTo })
          const updated = await client.query(
            `UPDATE files SET storage_key=$3,display_name=$4,deleted_at=NULL,updated_at=CURRENT_TIMESTAMP
             WHERE id=$1 AND user_id=$2 AND deleted_at IS NOT NULL RETURNING id`,
            [file.id, ownerId, restored.storageKey, restored.displayName],
          )
          if (!updated.rows[0]) throw new CoreError('not_found', '文件不存在')
          restoredFiles.push(Number(file.id))
        }
        commitAttempted = true
        await client.query('COMMIT')
        committed = true
        for (const move of moved) await removeRestoreLink(move.to, move.from)
      } catch (error) {
        if (!committed) {
          await client.query('ROLLBACK').catch(() => undefined)
          if (!commitAttempted) for (const move of moved.reverse()) await removeRestoreLink(move.from, move.to)
          if (commitAttempted) console.error('文件批量恢复提交结果未知，保留两处文件供核查')
        }
        throw error
      } finally {
        client.release()
      }
      for (const entityId of restoredFiles)
        await options.publishChanged({ ownerId, entityId, origin, entityType: 'file' }).catch(() => undefined)
    },

    async restoreFolder(rawOwnerId, folderId, origin = null) {
      const ownerId = normalizeFileOwnerId(rawOwnerId)
      if (!Number.isSafeInteger(folderId) || folderId < 1) throw new CoreError('invalid_request', '文件夹 ID 无效')
      const client = await pool.connect()
      const moved: Array<{ from: string; to: string }> = []
      let committed = false
      let commitAttempted = false
      let root: FolderRow | undefined
      let restoredFiles: number[] = []
      try {
        await client.query('BEGIN')
        const rootResult = await client.query<FolderRow>(
          `SELECT folder.id,folder.project_id,folder.workspace_directory_id,folder.parent_id,folder.name,
             folder.deleted_at,folder.version,0 AS depth,
             to_char(folder.deleted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US') || '+00:00' AS deleted_stamp
           FROM folders folder LEFT JOIN folders parent ON parent.id=folder.parent_id
           WHERE folder.id=$1 AND folder.user_id=$2 AND folder.deleted_at IS NOT NULL
             AND (folder.parent_id IS NULL OR parent.deleted_at IS NULL)
           FOR UPDATE OF folder`, [folderId, ownerId],
        )
        root = rootResult.rows[0]
        if (!root) throw new CoreError('not_found', '文件夹不存在')
        const deletedStamp = root.deleted_stamp
        const tree = await client.query<FolderRow>(
          `WITH RECURSIVE descendants AS (
             SELECT id,project_id,workspace_directory_id,parent_id,name,deleted_at,0 AS depth
             FROM folders WHERE id=$1 AND user_id=$2 AND deleted_at=$3::timestamptz
             UNION ALL
             SELECT child.id,child.project_id,child.workspace_directory_id,child.parent_id,child.name,child.deleted_at,descendants.depth+1
             FROM folders child JOIN descendants ON child.parent_id=descendants.id
             WHERE child.user_id=$2 AND child.deleted_at=descendants.deleted_at AND descendants.depth<64
           ) SELECT descendants.*,to_char(descendants.deleted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US') || '+00:00' AS deleted_stamp
             FROM descendants ORDER BY depth,id`, [folderId, ownerId, deletedStamp],
        )
        const folders = tree.rows
        const folderIds = folders.map((folder) => Number(folder.id))
        await client.query('SELECT id FROM folders WHERE id=ANY($1::integer[]) AND user_id=$2 FOR UPDATE', [folderIds, ownerId])

        for (const folder of folders) {
          let restoredName = folder.name
          for (let suffix = 1; ; suffix += 1) {
            const collision = await client.query(
              `SELECT 1 FROM folders WHERE user_id=$1 AND project_id IS NOT DISTINCT FROM $2::integer
                 AND workspace_directory_id IS NOT DISTINCT FROM $3::integer
                 AND parent_id IS NOT DISTINCT FROM $4::integer AND name=$5 AND deleted_at IS NULL LIMIT 1`,
              [ownerId, folder.project_id, folder.workspace_directory_id, folder.parent_id, restoredName],
            )
            if (!collision.rowCount) break
            const marker = `(${suffix})`
            restoredName = `${folder.name.slice(0, 200 - marker.length)}${marker}`
          }
          const updated = await client.query<FolderRow>(
            `UPDATE folders SET name=$3,deleted_at=NULL,version=version+1,updated_at=CURRENT_TIMESTAMP
             WHERE id=$1 AND user_id=$2 AND deleted_at=$4::timestamptz
             RETURNING id,project_id,workspace_directory_id,parent_id,name,deleted_at,version,0 AS depth,NULL::text AS deleted_stamp`,
            [folder.id, ownerId, restoredName, deletedStamp],
          )
          if (!updated.rows[0]) throw new CoreError('not_found', '文件夹不存在')
          if (Number(folder.id) === folderId) root = updated.rows[0]
        }

        const files = await client.query<RestoreRow>(
          `SELECT * FROM files WHERE user_id=$1 AND folder_id=ANY($2::integer[])
             AND deleted_at=$3::timestamptz ORDER BY folder_id,id FOR UPDATE`,
          [ownerId, folderIds, deletedStamp],
        )
        for (const file of files.rows) {
          const baseKey = await originalStorageKey(client, ownerId, file)
          const restored = await restoreLocalFile(options.storageRoot, ownerId, file, baseKey, options.createRestoreLink)
          if (restored.movedFrom && restored.movedTo) moved.push({ from: restored.movedFrom, to: restored.movedTo })
          const updated = await client.query(
            `UPDATE files SET storage_key=$3,display_name=$4,deleted_at=NULL,updated_at=CURRENT_TIMESTAMP
             WHERE id=$1 AND user_id=$2 AND deleted_at=$5::timestamptz RETURNING id`,
            [file.id, ownerId, restored.storageKey, restored.displayName, deletedStamp],
          )
          if (!updated.rows[0]) throw new CoreError('not_found', '文件不存在')
          restoredFiles.push(Number(file.id))
        }
        commitAttempted = true
        await client.query('COMMIT')
        committed = true
        for (const move of moved) await removeRestoreLink(move.to, move.from)
      } catch (error) {
        if (!committed) {
          await client.query('ROLLBACK').catch(() => undefined)
          if (!commitAttempted) for (const move of moved.reverse()) await removeRestoreLink(move.from, move.to)
          if (commitAttempted) console.error('文件夹恢复提交结果未知，保留两处文件供核查')
        }
        throw error
      } finally {
        client.release()
      }
      for (const entityId of restoredFiles)
        await options.publishChanged({ ownerId, entityId, origin, entityType: 'file' }).catch(() => undefined)
      await options.publishChanged({ ownerId, entityId: folderId, origin, entityType: 'folder' }).catch(() => undefined)
      return {
        id: Number(root!.id), project_id: root!.project_id === null ? null : Number(root!.project_id),
        workspace_directory_id: root!.workspace_directory_id === null ? null : Number(root!.workspace_directory_id),
        parent_id: root!.parent_id === null ? null : Number(root!.parent_id), name: root!.name,
        file_count: 0, folder_count: 0, version: Number(root!.version ?? 1),
      }
    },
  }
}

export interface TrashOperations {
  listFiles(ownerId: string, query: { limit: number; cursor: string | null }): Promise<TrashPage<Record<string, unknown>>>
  listFolders(ownerId: string, query: { limit: number; cursor: string | null }): Promise<TrashPage<Record<string, unknown>>>
  listFolderContents(ownerId: string, folderId: number, query: {
    limit: number
    folderCursor: string | null
    fileCursor: string | null
  }): Promise<{
    folders: TrashPage<Record<string, unknown>>
    files: TrashPage<Record<string, unknown>>
  } | null>
  restoreFolder(ownerId: string, folderId: number, origin: string | null): Promise<unknown>
  restoreFiles(ownerId: string, fileIds: number[], origin: string | null): Promise<void>
  hardDeleteFile(ownerId: string, fileId: number, origin: string | null): Promise<void>
  hardDeleteFolder(ownerId: string, folderId: number, origin: string | null): Promise<void>
  startEmpty(ownerId: string): Promise<TrashPurgeJob>
  activeEmpty(ownerId: string): Promise<TrashPurgeJob | null>
  getEmpty(ownerId: string, jobId: number): Promise<TrashPurgeJob | null>
}

export interface TrashPurgeJob {
  id: number
  status: 'queued' | 'running' | 'completed' | 'failed'
  progressCurrent: number
  progressTotal: number
  failedCount: number
  errorCode: string | null
}

/** Agent 确认任务用稳定操作 ID 关联 purge job；重试不能创建第二个目标快照。 */
export interface AgentTrashPurgeOperations {
  startEmptyForAgent(ownerId: string, operationId: string, snapshot: {
    file_count: number; folder_count: number; digest: string
  }): Promise<TrashPurgeJob>
  getAgentEmpty(ownerId: string, operationId: string): Promise<TrashPurgeJob | null>
}

export class TrashCooldownError extends Error {
  constructor() {
    super('刚完成清空，请稍后再试')
    this.name = 'TrashCooldownError'
  }
}

export class TrashPurgeUnavailableError extends Error {
  readonly statusCode = 503

  constructor() {
    super('回收站清空服务暂不可用')
    this.name = 'TrashPurgeUnavailableError'
  }
}

export interface TrashPage<T> {
  items: T[]
  has_more: boolean
  next_cursor: string | null
}

export interface TrashRouteOptions {
  requireUser: preHandlerHookHandler
  ownerIdFromRequest(request: FastifyRequest): string
  operations: TrashOperations
}

function parsePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim()))
    throw new CoreError('invalid_request', `${label} 无效`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new CoreError('invalid_request', `${label} 无效`)
  return parsed
}

function queryText(request: FastifyRequest, name: string): string | null {
  const value = (request.query as Record<string, unknown>)[name]
  if (value === undefined) return null
  if (typeof value !== 'string') throw new CoreError('invalid_request', `${name} 无效`)
  return value
}

function pageLimit(request: FastifyRequest): number {
  const raw = queryText(request, 'limit')
  if (raw === null) return 100
  const limit = Number(raw)
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(limit) || limit < 1 || limit > 200)
    throw new CoreError('invalid_request', 'limit 必须在 1 到 200 之间')
  return limit
}

function clientId(request: FastifyRequest): string | null {
  const value = request.headers['x-client-id']
  return typeof value === 'string' ? value.trim().slice(0, 128) || null : null
}

export function registerTrashRoutes(app: FastifyInstance, options: TrashRouteOptions): void {
  const owner = (request: FastifyRequest) => options.ownerIdFromRequest(request)
  app.get('/api/v1/trash/page', { preHandler: options.requireUser }, async (request) =>
    options.operations.listFiles(owner(request), { limit: pageLimit(request), cursor: queryText(request, 'cursor') }))

  app.get('/api/v1/trash/folders/page', { preHandler: options.requireUser }, async (request) =>
    options.operations.listFolders(owner(request), { limit: pageLimit(request), cursor: queryText(request, 'cursor') }))

  app.get<{ Params: { fid: string } }>('/api/v1/trash/folders/:fid/contents/page', {
    preHandler: options.requireUser,
  }, async (request) => {
    const result = await options.operations.listFolderContents(owner(request), parsePositiveInteger(request.params.fid, '文件夹 ID'), {
      limit: pageLimit(request),
      folderCursor: queryText(request, 'folder_cursor'),
      fileCursor: queryText(request, 'file_cursor'),
    })
    if (result === null) throw new CoreError('not_found', '文件夹不存在')
    return result
  })

  app.post<{ Params: { fid: string } }>('/api/v1/trash/folders/:fid/restore', {
    preHandler: options.requireUser,
  }, async (request) => options.operations.restoreFolder(
    owner(request), parsePositiveInteger(request.params.fid, '文件夹 ID'), clientId(request),
  ))

  app.post('/api/v1/trash/batch-restore', { preHandler: options.requireUser }, async (request, reply) => {
    const body = request.body
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || !Array.isArray((body as Record<string, unknown>).ids)
      || !((body as Record<string, unknown>).ids as unknown[]).every((id) =>
        typeof id === 'number' && Number.isSafeInteger(id) && id > 0))
      throw new CoreError('invalid_request', '文件 ID 列表无效')
    await options.operations.restoreFiles(owner(request), (body as { ids: number[] }).ids, clientId(request))
    return reply.code(204).send()
  })

  app.delete<{ Params: { fid: string } }>('/api/v1/trash/folders/:fid', {
    preHandler: options.requireUser,
  }, async (request, reply) => {
    await options.operations.hardDeleteFolder(owner(request), parsePositiveInteger(request.params.fid, '文件夹 ID'), clientId(request))
    return reply.code(204).send()
  })

  app.delete<{ Params: { fid: string } }>('/api/v1/trash/:fid', {
    preHandler: options.requireUser,
  }, async (request, reply) => {
    await options.operations.hardDeleteFile(owner(request), parsePositiveInteger(request.params.fid, '文件 ID'), clientId(request))
    return reply.code(204).send()
  })

  const startEmpty = async (request: FastifyRequest, reply: import('fastify').FastifyReply) => {
    try { return reply.code(202).send(await options.operations.startEmpty(owner(request))) }
    catch (error) {
      if (error instanceof TrashPurgeUnavailableError)
        return reply.code(503).send({ detail: error.message })
      if (!(error instanceof TrashCooldownError)) throw error
      return reply.code(429).header('Retry-After', '30').send({ detail: error.message })
    }
  }
  app.post('/api/v1/trash/empty', { preHandler: options.requireUser }, startEmpty)

  app.get('/api/v1/trash/empty/active', { preHandler: options.requireUser }, async (request) =>
    options.operations.activeEmpty(owner(request)))

  app.get<{ Params: { job_id: string } }>('/api/v1/trash/empty/:job_id', {
    preHandler: options.requireUser,
  }, async (request) => {
    const result = await options.operations.getEmpty(owner(request), parsePositiveInteger(request.params.job_id, '任务 ID'))
    if (result === null) throw new CoreError('not_found', '清空任务不存在')
    return result
  })

  // 旧客户端使用 DELETE /trash；与 POST /trash/empty 共用同一条持久化队列。
  app.delete('/api/v1/trash', { preHandler: options.requireUser }, startEmpty)
}
