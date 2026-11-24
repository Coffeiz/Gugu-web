import { CoreError } from '@gugu/core'
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'
import type { PoolClient, Pool, QueryResultRow } from 'pg'
import { link, lstat, mkdir, realpath, rm, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { isPathWithin } from '../../../shared/path-safety.js'
import { isOwnedFileStorageKey, normalizeFileOwnerId } from '../store.js'
import { lockFileSyncPath, lockFileSyncPaths } from '../storage/sync.js'

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
  remove(ownerId: string, storageKey: string, undoContextId: string | null, clientId: string | null,
    operation?: FileDeleteAgentOperation): Promise<void | FileDeleteAgentResult | { kind: 'unknown' }>
  removeMany?(ownerId: string, storageKeys: string[], undoContextId: string | null, clientId: string | null,
    operation?: FileDeleteAgentOperation): Promise<void | FileDeleteAgentResult | { kind: 'unknown' }>
}

export interface FileDeleteRouteOptions {
  requireUser: preHandlerHookHandler
  ownerIdFromRequest(request: FastifyRequest): string
  operations: FileDeleteOperations
}

function storageKey(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096 || value.startsWith('/') || value.includes('\\')
    || value.includes('\0') || value.split('/').some(part => !part || part === '.' || part === '..'))
    throw new CoreError('invalid_request', '文件路径无效')
  return value
}

function requestHeader(request: FastifyRequest, name: string): string | null {
  const value = request.headers[name]
  return typeof value === 'string' ? value.trim().slice(0, 128) || null : null
}

export function registerFileDeleteRoutes(app: FastifyInstance, options: FileDeleteRouteOptions): void {
  app.delete<{ Querystring: { path?: string } }>('/api/v1/files/by-path', {
    preHandler: options.requireUser,
  }, async (request, reply) => {
    await options.operations.remove(
      options.ownerIdFromRequest(request),
      storageKey(request.query.path),
      requestHeader(request, 'x-undo-context-id'),
      requestHeader(request, 'x-client-id'),
    )
    return reply.code(204).send()
  })
  if (options.operations.removeMany) {
    app.post('/api/v1/files/by-path/batch-delete', { preHandler: options.requireUser }, async (request, reply) => {
      const body = request.body
      if (!body || typeof body !== 'object' || Array.isArray(body))
        throw new CoreError('invalid_request', '批量删除参数无效')
      const rawPaths = (body as Record<string, unknown>).paths
      if (!Array.isArray(rawPaths) || rawPaths.length > 500) throw new CoreError('invalid_request', '文件路径列表无效')
      const paths = rawPaths.map(storageKey)
      await options.operations.removeMany!(
        options.ownerIdFromRequest(request),
        paths,
        requestHeader(request, 'x-undo-context-id'),
        requestHeader(request, 'x-client-id'),
      )
      return reply.code(204).send()
    })
  }
}

interface FileRow extends QueryResultRow {
  user_id: string
  display_name: string
  ext: string
  space: string
  project_id: number | string | null
  workspace_directory_id: number | string | null
  stage_name: string
  mind_map_id: number | string | null
  path: string
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
      'SELECT 1 FROM files WHERE user_id=$1 AND path=$2', [ownerId, key],
    )
    if (!exists && !row.rowCount) return key
    suffix++
  }
}

function snapshot(file: FileRow) {
  return {
    display_name: file.display_name, ext: file.ext, space: file.space,
    project_id: file.project_id === null ? null : Number(file.project_id),
    workspace_directory_id: file.workspace_directory_id === null ? null : Number(file.workspace_directory_id),
    stage_name: file.stage_name, mind_map_id: file.mind_map_id === null ? null : Number(file.mind_map_id),
    path: file.path, version: Number(file.version), size: file.size,
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
  const afterByPath = new Map(beforeRows.map((file, index) => [file.path, afterRows[index]!]))
  const before = Object.fromEntries(beforeRows.map((file) => [`file:${file.path}`, snapshot(file)]))
  const after = Object.fromEntries(beforeRows.map((file) => {
    const moved = afterByPath.get(file.path)
    if (!moved) throw new CoreError('storage_error', '文件撤销快照不完整')
    return [`file:${file.path}`, snapshot(moved)]
  }))
  const refs = beforeRows.map((file) => ({ kind: 'file', path: file.path }))
  const versions = Object.fromEntries(beforeRows.map((file) => [`file:${file.path}`, { version: Number(file.version) }]))
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
    publishChanged(event: { ownerId: string; entityId: string; origin: string | null }): Promise<void>
  },
): FileDeleteOperations {
  return {
    async remove(rawOwnerId, filePath, undoContextId, clientId, operation) {
      const ownerId = normalizeFileOwnerId(rawOwnerId)
      const targetKey = storageKey(filePath)
      if (!isOwnedFileStorageKey(ownerId, targetKey)) throw new CoreError('not_found', '文件不存在')
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
          'SELECT * FROM files WHERE path=$1 AND user_id=$2 AND deleted_at IS NULL FOR UPDATE', [targetKey, ownerId],
        )
        const before = result.rows[0]
        if (!before) throw new CoreError('not_found', '文件不存在')
        if (!isOwnedFileStorageKey(ownerId, before.path)) throw new CoreError('not_found', '文件不存在')
        await lockFileSyncPath(client, ownerId, before.path)
        sourcePath = (await safePath(options.storageRoot, before.path)).target
        const destinationKey = await availableTrashKey(
          client, options.storageRoot, ownerId,
          trashKey(ownerId, before.path, before.display_name, before.ext), before.display_name, before.ext,
        )
        destinationPath = (await safePath(options.storageRoot, destinationKey)).target
        await mkdir(path.dirname(destinationPath), { recursive: true, mode: 0o700 })
        await (options.createDeleteLink ?? link)(sourcePath, destinationPath)
        moved = true
        const updated = await client.query<FileRow>(
          `UPDATE files SET path=$3,deleted_at=CURRENT_TIMESTAMP,version=version+1,updated_at=CURRENT_TIMESTAMP
           WHERE path=$1 AND user_id=$2 AND deleted_at IS NULL RETURNING *`, [targetKey, ownerId, destinationKey],
        )
        const after = updated.rows[0]
        if (!after) throw new CoreError('not_found', '文件不存在')
        await recordBatchDeleteUndo(client, ownerId, undoContextId, [before], [after])
        if (operation) {
          operation.signal.throwIfAborted()
          operationResult = { replayed: false, result: { success: true,
            name: `${before.display_name}.${before.ext}`, note: '已移入回收站，30 天内可还原' } }
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
      await options.publishChanged({ ownerId, entityId: targetKey, origin: clientId }).catch(() => undefined)
      return operationResult
    },

    async removeMany(rawOwnerId, rawStorageKeys, undoContextId, clientId, operation) {
      const ownerId = normalizeFileOwnerId(rawOwnerId)
      const storageKeys = rawStorageKeys.map(storageKey)
      if (storageKeys.some(key => !isOwnedFileStorageKey(ownerId, key))) throw new CoreError('not_found', '文件不存在')
      if (new Set(storageKeys).size !== storageKeys.length) throw new CoreError('invalid_request', '文件路径不能重复')
      if (!storageKeys.length) return
      const client = await pool.connect()
      const movedFiles: Array<{ sourcePath: string; destinationPath: string }> = []
      let committed = false
      let commitAttempted = false
      let changedPaths: string[] = []
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
          `SELECT * FROM files WHERE path=ANY($1::text[]) AND user_id=$2 AND deleted_at IS NULL
           ORDER BY path FOR UPDATE`, [storageKeys, ownerId],
        )
        const beforeRows = result.rows
        if (beforeRows.length !== storageKeys.length) throw new CoreError('not_found', '文件不存在')
        if (beforeRows.some((file) => !isOwnedFileStorageKey(ownerId, file.path)))
          throw new CoreError('not_found', '文件不存在')
        if (!beforeRows.length) {
          commitAttempted = true
          await client.query('COMMIT')
          committed = true
          return
        }
        await lockFileSyncPaths(client, ownerId, beforeRows.map((file) => file.path))
        const afterRows: FileRow[] = []
        for (const before of beforeRows) {
          const sourcePath = (await safePath(options.storageRoot, before.path)).target
          const destinationKey = await availableTrashKey(
            client, options.storageRoot, ownerId,
            trashKey(ownerId, before.path, before.display_name, before.ext), before.display_name, before.ext,
          )
          const destinationPath = (await safePath(options.storageRoot, destinationKey)).target
          await mkdir(path.dirname(destinationPath), { recursive: true, mode: 0o700 })
          await (options.createDeleteLink ?? link)(sourcePath, destinationPath)
          movedFiles.push({ sourcePath, destinationPath })
          const updated = await client.query<FileRow>(
            `UPDATE files SET path=$3,deleted_at=CURRENT_TIMESTAMP,version=version+1,updated_at=CURRENT_TIMESTAMP
             WHERE path=$1 AND user_id=$2 AND deleted_at IS NULL RETURNING *`,
            [before.path, ownerId, destinationKey],
          )
          if (!updated.rows[0]) throw new CoreError('not_found', '文件不存在')
          afterRows.push(updated.rows[0])
        }
        await recordBatchDeleteUndo(client, ownerId, undoContextId, beforeRows, afterRows)
        if (operation) {
          operation.signal.throwIfAborted()
          const byPath = new Map(beforeRows.map(file => [file.path, file]))
          operationResult = { replayed: false, result: { success: true, deleted_count: storageKeys.length,
            results: storageKeys.map(key => {
              const file = byPath.get(key)!
              return { name: `${file.display_name}.${file.ext}`, note: '已移入回收站，30 天内可还原' }
            }) } }
          await writeFileDeleteReceipt(client, ownerId, operation.receipt, operationResult.result)
        }
        operation?.signal.throwIfAborted()
        commitAttempted = true
        await client.query('COMMIT')
        committed = true
        for (const move of movedFiles) await removeMatchingLink(move.destinationPath, move.sourcePath)
        changedPaths = beforeRows.map((file) => file.path)
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
      for (const entityId of changedPaths)
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
  restore(ownerId: string, storageKey: string, origin?: string | null): Promise<void>
  restoreBatch?(ownerId: string, storageKeys: string[], origin?: string | null): Promise<void>
}

export interface FileRestoreRouteOptions {
  requireUser: preHandlerHookHandler
  ownerIdFromRequest(request: FastifyRequest): string
  operations: FileRestoreOperations
}

export function registerFileRestoreRoutes(app: FastifyInstance, options: FileRestoreRouteOptions): void {
  app.post<{ Querystring: { path?: string } }>('/api/v1/trash/by-path/restore', {
    preHandler: options.requireUser,
  }, async (request, reply) => {
    const rawClientId = request.headers['x-client-id']
    const clientId = typeof rawClientId === 'string' ? rawClientId.trim().slice(0, 128) || null : null
    await options.operations.restore(options.ownerIdFromRequest(request), storageKey(request.query.path), clientId)
    return reply.code(204).send()
  })
}

interface RestoreRow extends QueryResultRow {
  user_id: string
  display_name: string
  ext: string
  space: string
  project_id: number | string | null
  workspace_directory_id: number | string | null
  stage_name: string
  mind_map_id: number | string | null
  path: string
  version: number | string
  size: string
  size_bytes: number | string
  mime_type: string | null
  img_width: number | string | null
  img_height: number | string | null
  created_at: Date | string
  deleted_at: Date | string | null
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
  ownerId: string,
  file: Pick<RestoreRow, 'space' | 'path'>,
): Promise<string> {
  const prefix = `${ownerId}/trash/`
  if (!file.path.startsWith(prefix)) throw new RestoreStoragePathError('回收站存储路径无效')
  const relativePath = safeKey(ownerId, file.path).slice(2).join('/')
  const storageRoot = file.space === 'personal' ? '个人文件'
    : file.space === 'project' ? '项目文件'
      : file.space === 'workspace' ? 'workspace' : null
  if (!storageRoot) throw new RestoreStoragePathError('文件存储空间无效')
  return `${ownerId}/${storageRoot}/${relativePath}`
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
  if (!root || file.path === baseKey)
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

  const source = await checkedPath(root, ownerId, file.path)
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
    publishChanged(event: { ownerId: string; entityId: string; origin?: string | null; entityType?: 'file' | 'folder' }): Promise<void>
  },
): FileRestoreOperations {
  return {
    async restore(rawOwnerId, rawStorageKey, origin = null) {
      const ownerId = normalizeFileOwnerId(rawOwnerId)
      const targetKey = storageKey(rawStorageKey)
      if (!isOwnedFileStorageKey(ownerId, targetKey)) throw new CoreError('not_found', '文件不存在')
      const client = await pool.connect()
      let committed = false
      let commitAttempted = false
      let movedFrom: string | null = null
      let movedTo: string | null = null
      try {
        await client.query('BEGIN')
        const found = await client.query<RestoreRow>(
          'SELECT * FROM files WHERE path=$1 AND user_id=$2 AND deleted_at IS NOT NULL FOR UPDATE', [targetKey, ownerId],
        )
        const file = found.rows[0]
        if (!file) throw new CoreError('not_found', '文件不存在')
        const baseKey = await originalStorageKey(ownerId, file)
        const restored = await restoreLocalFile(options.storageRoot, ownerId, file, baseKey, options.createRestoreLink)
        movedFrom = restored.movedFrom
        movedTo = restored.movedTo
        const updated = await client.query(
          `UPDATE files SET path=$3,display_name=$4,deleted_at=NULL,updated_at=CURRENT_TIMESTAMP
           WHERE path=$1 AND user_id=$2 AND deleted_at IS NOT NULL RETURNING path`,
          [targetKey, ownerId, restored.storageKey, restored.displayName],
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
      await options.publishChanged({ ownerId, entityId: targetKey, origin, entityType: 'file' }).catch(() => undefined)
    },

    async restoreBatch(rawOwnerId, rawStorageKeys, origin = null) {
      const ownerId = normalizeFileOwnerId(rawOwnerId)
      if (!Array.isArray(rawStorageKeys)) throw new CoreError('invalid_request', '文件路径列表无效')
      const targetKeys = rawStorageKeys.map(storageKey)
      if (targetKeys.some(key => !isOwnedFileStorageKey(ownerId, key)) || new Set(targetKeys).size !== targetKeys.length)
        throw new CoreError('invalid_request', '文件路径列表无效')
      if (!targetKeys.length) return
      const client = await pool.connect()
      const moved: Array<{ from: string; to: string }> = []
      let committed = false
      let commitAttempted = false
      const restoredFiles: string[] = []
      try {
        await client.query('BEGIN')
        const found = await client.query<RestoreRow>(
          `SELECT * FROM files WHERE path=ANY($1::text[]) AND user_id=$2 AND deleted_at IS NOT NULL
           ORDER BY path FOR UPDATE`, [targetKeys, ownerId],
        )
        const files = found.rows
        if (files.length !== targetKeys.length) throw new CoreError('not_found', '文件不存在')
        for (const file of files) {
          const baseKey = await originalStorageKey(ownerId, file)
          const restored = await restoreLocalFile(options.storageRoot, ownerId, file, baseKey, options.createRestoreLink)
          if (restored.movedFrom && restored.movedTo)
            moved.push({ from: restored.movedFrom, to: restored.movedTo })
          const updated = await client.query(
            `UPDATE files SET path=$3,display_name=$4,deleted_at=NULL,updated_at=CURRENT_TIMESTAMP
             WHERE path=$1 AND user_id=$2 AND deleted_at IS NOT NULL RETURNING path`,
            [file.path, ownerId, restored.storageKey, restored.displayName],
          )
          if (!updated.rows[0]) throw new CoreError('not_found', '文件不存在')
          restoredFiles.push(file.path)
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


  }
}
