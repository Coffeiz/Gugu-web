import { randomUUID } from 'node:crypto'
import { CoreError } from '@gugu/core'
import type { PoolClient, Pool, QueryResultRow } from 'pg'
import { resolveFileLibraryLimit, StorageQuotaScanBusy, type StorageQuotaReconcilePort } from '../../admin/storage.js'
import { lstat, readdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { isPathWithin } from '../../../shared/path-safety.js'

const FILE_LIBRARY = 'file_library'

const UNLIMITED_BYTES = '9223372036854775807'

/** 初始化新注册用户的文件库账本，账本与引导文件写入处于同一 PostgreSQL 事务。 */
export async function ensureRegistrationFileLibraryQuota(
  client: PoolClient,
  userId: string,
  defaultLimitBytes: number | null,
): Promise<void> {
  const user = await client.query<{ storage_limit_bytes: string | number | null }>(
    'SELECT storage_limit_bytes FROM users WHERE id=$1', [userId],
  )
  if (!user.rowCount) throw new CoreError('not_found', '用户不存在')

  const userLimit = user.rows[0]!.storage_limit_bytes
  const configuredLimit = userLimit === null ? defaultLimitBytes : userLimit
  const configuredLimitText = configuredLimit === null ? null : String(configuredLimit)
  const limitBytes = configuredLimitText === null || configuredLimitText === '-1'
    ? UNLIMITED_BYTES
    : configuredLimitText

  await client.query(
    `INSERT INTO storage_quota_ledgers
       (user_id,category,root_path,limit_bytes,used_bytes,reserved_bytes,status,
        initialized_at,last_reconciled_at,updated_at)
     VALUES ($1,$2,NULL,$3,0,0,'active',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
     ON CONFLICT (user_id,category) DO NOTHING`,
    [userId, FILE_LIBRARY, limitBytes],
  )
  await client.query(
    `INSERT INTO storage_quota_events
       (user_id,category,operation,delta_bytes,resource_type,resource_id,idempotency_key,metadata_json,created_at)
     VALUES ($1,$2,'initialize',0,'quota',$2,$3,'{"root_path":null}'::json,CURRENT_TIMESTAMP)
     ON CONFLICT (user_id,idempotency_key) DO NOTHING`,
    [userId, FILE_LIBRARY, `quota-init:${userId}:${FILE_LIBRARY}`],
  )
}

export type FileQuotaOperation = 'file_upload' | 'file_copy' | 'file_copy_overwrite' | 'onboarding_seed' | 'web_download'

/** 在当前文件事务中更新配额账本与事件，调用方提供操作语义和幂等键。 */
export async function updateFileStorageQuota(
  client: PoolClient,
  userId: string,
  fileId: number,
  delta: number,
  operation: FileQuotaOperation,
  idempotencyKey: string,
): Promise<void> {
  const result = await client.query<{
    used_bytes: string | number
    reserved_bytes: string | number
    limit_bytes: string | number
  }>(
    `SELECT used_bytes,reserved_bytes,limit_bytes FROM storage_quota_ledgers
     WHERE user_id=$1 AND category=$2 AND status='active' FOR UPDATE`,
    [userId, FILE_LIBRARY],
  )
  const ledger = result.rows[0]
  if (!ledger) throw new CoreError('busy', '存储配额账本尚未就绪，请稍后重试')

  const usedBytes = Number(ledger.used_bytes) + delta
  if (usedBytes < 0
    || (Number(ledger.limit_bytes) < Number.MAX_SAFE_INTEGER
      && usedBytes + Number(ledger.reserved_bytes) > Number(ledger.limit_bytes))) {
    throw new CoreError('conflict', '存储空间已满，无法上传')
  }

  await client.query(
    `UPDATE storage_quota_ledgers SET used_bytes=$3,updated_at=CURRENT_TIMESTAMP
     WHERE user_id=$1 AND category=$2`,
    [userId, FILE_LIBRARY, usedBytes],
  )
  await client.query(
    `INSERT INTO storage_quota_events
       (user_id,category,operation,delta_bytes,resource_type,resource_id,idempotency_key,metadata_json,created_at)
     VALUES ($1,$2,$3,$4,'file',$5,$6,NULL,CURRENT_TIMESTAMP)`,
    [userId, FILE_LIBRARY, operation, delta, String(fileId), idempotencyKey],
  )
}

const MAX_BIGINT = '9223372036854775807'

const MAX_ACTIVE_SCANS = 4

let activeScans = 0

const categories = ['file_library', 'shell_persistent', 'shell_ephemeral'] as const

type Category = typeof categories[number]

type MeasuredUsage = Record<Category, number>

interface LedgerSnapshot extends QueryResultRow {
  category: string
  used_bytes: string
  updated_at: string
}

interface WorkspaceFile extends QueryResultRow {
  storage_key: string
  size_bytes: string
}

function aborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('配额对账已取消')
}

function addBytes(total: number, bytes: number): number {
  const next = total + bytes
  if (!Number.isSafeInteger(next) || next < 0) throw new RangeError('存储用量超出支持范围')
  return next
}

async function canonicalRoot(storageRoot: string): Promise<string | null> {
  try { return await realpath(storageRoot) }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES') return null
    throw error
  }
}

/** 按 Python measure_directory 口径计普通文件逻辑字节，不跟随符号链接。 */
async function measureDirectory(storageRoot: string, directory: string, signal: AbortSignal): Promise<number> {
  const root = await canonicalRoot(storageRoot)
  if (root === null) return 0
  const target = path.resolve(directory)
  if (!isPathWithin(root, target)) return 0
  let current = root
  for (const segment of path.relative(root, target).split(path.sep).filter(Boolean)) {
    aborted(signal)
    current = path.join(current, segment)
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink() || !info.isDirectory()) return 0
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES') return 0
      throw error
    }
  }
  let total = 0
  async function visit(parent: string): Promise<void> {
    aborted(signal)
    let entries
    try { entries = await readdir(parent) }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES') return
      throw error
    }
    for (const name of entries) {
      aborted(signal)
      const child = path.join(parent, name)
      let info
      try { info = await lstat(child) }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES') continue
        throw error
      }
      if (info.isSymbolicLink()) continue
      if (info.isDirectory()) await visit(child)
      else if (info.isFile()) total = addBytes(total, info.size)
    }
  }
  await visit(target)
  return total
}

async function measureUserUsage(
  storageRoot: string,
  ownerId: string,
  registeredFiles: readonly WorkspaceFile[],
  signal: AbortSignal,
): Promise<MeasuredUsage> {
  const root = await canonicalRoot(storageRoot)
  if (root === null) return { file_library: 0, shell_persistent: 0, shell_ephemeral: 0 }
  const workspace = path.join(root, ownerId, 'workspace')
  const roots = [
    workspace,
    path.join(root, ownerId, '个人文件'),
    path.join(root, ownerId, '项目文件'),
    path.join(root, ownerId, 'trash'),
    path.join(root, ownerId.replaceAll('-', ''), '.data-portability', 'imported'),
  ]
  const sizes = await Promise.all(roots.map(root => measureDirectory(storageRoot, root, signal)))
  const fileLibrary = sizes.reduce(addBytes, 0)
  const workspaceBytes = sizes[0] ?? 0
  let registeredBytes = 0
  for (const file of registeredFiles) {
    aborted(signal)
    if (typeof file.storage_key !== 'string' || !file.storage_key) continue
    const candidate = path.resolve(root, file.storage_key)
    if (!isPathWithin(workspace, candidate)) continue
    try {
      const resolved = await realpath(candidate)
      if (!isPathWithin(workspace, resolved) || !(await stat(resolved)).isFile()) continue
      const bytes = Number(file.size_bytes)
      if (Number.isSafeInteger(bytes) && bytes >= 0) registeredBytes = addBytes(registeredBytes, bytes)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR' && code !== 'EACCES') throw error
    }
  }
  return {
    file_library: fileLibrary,
    shell_persistent: Math.max(0, workspaceBytes - registeredBytes),
    shell_ephemeral: 0,
  }
}

async function admittedMeasureUserUsage(
  storageRoot: string,
  ownerId: string,
  registeredFiles: readonly WorkspaceFile[],
  signal: AbortSignal,
): Promise<MeasuredUsage> {
  if (activeScans >= MAX_ACTIVE_SCANS) throw new StorageQuotaScanBusy()
  activeScans += 1
  try { return await measureUserUsage(storageRoot, ownerId, registeredFiles, signal) }
  finally { activeScans -= 1 }
}

function snapshot(rows: readonly LedgerSnapshot[]): Map<string, string> {
  return new Map(rows.map(row => [row.category, `${row.used_bytes}\u0000${row.updated_at}`]))
}

function unchanged(before: Map<string, string>, after: readonly LedgerSnapshot[]): boolean {
  const current = snapshot(after)
  return before.size === current.size && [...before].every(([category, value]) => current.get(category) === value)
}

async function rollback(client: PoolClient): Promise<void> {
  try { await client.query('ROLLBACK') } catch { /* 保留原始数据库异常。 */ }
}

/** Local PG 适配：文件扫描在事务外完成，提交时用账本版本检查保护并发增量。 */
export function createPostgresStorageQuotaReconcilePort(options: {
  pool: Pool
  storageRoot: string
  defaultFileLibraryLimit: () => string | number | null
  ephemeralLimit: () => string | number
}): StorageQuotaReconcilePort {
  return {
    async listUserIds() {
      const result = await options.pool.query<{ id: string }>('SELECT id::text AS id FROM users ORDER BY id ASC')
      return result.rows.map(row => row.id)
    },
    async reconcileUser(ownerId, signal) {
      aborted(signal)
      const read = await options.pool.connect()
      let initial: LedgerSnapshot[]
      let registeredFiles: WorkspaceFile[]
      try {
        initial = (await read.query<LedgerSnapshot>(`SELECT category,used_bytes::text AS used_bytes,
          updated_at::text AS updated_at FROM storage_quota_ledgers WHERE user_id=$1`, [ownerId])).rows
        registeredFiles = (await read.query<WorkspaceFile>(`SELECT storage_key,size_bytes::text AS size_bytes FROM files
          WHERE user_id=$1 AND workspace_directory_id IS NOT NULL AND deleted_at IS NULL`, [ownerId])).rows
      } finally { read.release() }
      const measured = await admittedMeasureUserUsage(options.storageRoot, ownerId, registeredFiles, signal)
      aborted(signal)

      const client = await options.pool.connect()
      let transaction = false
      try {
        await client.query('BEGIN')
        transaction = true
        const user = await client.query<{ storage_limit_bytes: string | null }>(
          'SELECT storage_limit_bytes::text AS storage_limit_bytes FROM users WHERE id=$1 FOR UPDATE', [ownerId],
        )
        if (!user.rowCount) throw new Error('用户不存在')
        const current = (await client.query<LedgerSnapshot>(`SELECT category,used_bytes::text AS used_bytes,
          updated_at::text AS updated_at FROM storage_quota_ledgers WHERE user_id=$1 FOR UPDATE`, [ownerId])).rows
        if (!unchanged(snapshot(initial), current)) {
          await client.query('COMMIT')
          transaction = false
          return
        }
        const currentByCategory = new Map(current.map(row => [row.category, row]))
        const fileLimit = resolveFileLibraryLimit(user.rows[0]!.storage_limit_bytes, options.defaultFileLibraryLimit())
        const limits: Record<Category, string> = {
          file_library: fileLimit,
          shell_persistent: MAX_BIGINT,
          shell_ephemeral: String(options.ephemeralLimit()),
        }
        const roots: Partial<Record<Category, string>> = {
          shell_persistent: path.join(options.storageRoot, ownerId, 'workspace'),
        }
        for (const category of categories) {
          aborted(signal)
          let row = currentByCategory.get(category)
          if (!row) {
            const inserted = await client.query(`INSERT INTO storage_quota_ledgers
              (user_id,category,root_path,limit_bytes,used_bytes,reserved_bytes,status,initialized_at,last_reconciled_at,updated_at)
              VALUES($1,$2,$3,$4,$5,0,'active',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
              ON CONFLICT(user_id,category) DO NOTHING RETURNING category`,
            [ownerId, category, roots[category] ?? null, limits[category], measured[category]])
            if (inserted.rowCount) {
              await client.query(`INSERT INTO storage_quota_events
                (user_id,category,operation,delta_bytes,resource_type,resource_id,idempotency_key,metadata_json,created_at)
                VALUES($1,$2,'initialize',0,'quota',$2,$3,$4::jsonb,CURRENT_TIMESTAMP)
                ON CONFLICT(user_id,idempotency_key) DO NOTHING`,
              [ownerId, category, `quota-init:${ownerId}:${category}`, JSON.stringify({ root_path: roots[category] ?? null })])
            }
            row = (await client.query<LedgerSnapshot>(`SELECT category,used_bytes::text AS used_bytes,
              updated_at::text AS updated_at FROM storage_quota_ledgers WHERE user_id=$1 AND category=$2 FOR UPDATE`,
            [ownerId, category])).rows[0]
            if (!row) throw new Error('配额账本初始化失败')
          }
          const delta = measured[category] - Number(row.used_bytes)
          const updated = await client.query<{ last_reconciled_at: string }>(`UPDATE storage_quota_ledgers SET
            root_path=COALESCE($3,root_path),limit_bytes=$4,used_bytes=$5,last_reconciled_at=CURRENT_TIMESTAMP,
            updated_at=CURRENT_TIMESTAMP WHERE user_id=$1 AND category=$2 RETURNING last_reconciled_at::text AS last_reconciled_at`,
          [ownerId, category, roots[category] ?? null, limits[category], measured[category]])
          if (delta !== 0) {
            await client.query(`INSERT INTO storage_quota_events
              (user_id,category,operation,delta_bytes,resource_type,resource_id,idempotency_key,metadata_json,created_at)
              VALUES($1,$2,'reconcile',$3,'quota',$2,$4,$5::jsonb,CURRENT_TIMESTAMP)
              ON CONFLICT(user_id,idempotency_key) DO NOTHING`,
            [ownerId, category, delta, `reconcile:${ownerId}:${category}:${updated.rows[0]!.last_reconciled_at}`, JSON.stringify({ measured_bytes: measured[category] })])
          }
        }
        await client.query('COMMIT')
        transaction = false
      } catch (error) {
        if (transaction) await rollback(client)
        throw error
      } finally { client.release() }
    },
  }
}

export { measureDirectory as measureStorageQuotaDirectory }

interface QuotaRow extends QueryResultRow {
  used_bytes: number | string
}

export async function lockQuota(client: PoolClient, ownerId: string): Promise<number> {
  const result = await client.query<QuotaRow>(
    `SELECT used_bytes FROM storage_quota_ledgers
     WHERE user_id=$1 AND category='file_library' AND status='active' FOR UPDATE`, [ownerId],
  )
  const row = result.rows[0]
  if (!row) throw new CoreError('busy', '存储配额账本尚未就绪，请稍后重试')
  return Number(row.used_bytes)
}

async function measureReconciliationDirectory(storageRoot: string, root: string, excluded: ReadonlySet<string>): Promise<number> {
  let total = 0
  let current = storageRoot
  for (const part of path.relative(storageRoot, root).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink() || !info.isDirectory()) return 0
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES') return 0
      throw error
    }
  }
  const visit = async (directory: string): Promise<void> => {
    let entries
    try { entries = await readdir(directory, { withFileTypes: true }) }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES') return
      throw error
    }
    for (const entry of entries) {
      const target = path.join(directory, entry.name)
      if (excluded.has(target)) continue
      let info
      try { info = await lstat(target) }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES') continue
        throw error
      }
      if (info.isSymbolicLink()) continue
      if (info.isDirectory()) await visit(target)
      else if (info.isFile()) total += info.size
    }
  }
  await visit(root)
  return total
}

export async function reconcileLocalUsage(
  client: PoolClient,
  storageRoot: string,
  ownerId: string,
  usedBytes: number,
  excluded: ReadonlySet<string> = new Set(),
): Promise<number> {
  const root = await realpath(storageRoot)
  const roots = [
    path.join(root, ownerId, 'workspace'),
    path.join(root, ownerId, '个人文件'),
    path.join(root, ownerId, '项目文件'),
    path.join(root, ownerId, 'trash'),
    path.join(root, ownerId.replaceAll('-', ''), '.data-portability', 'imported'),
  ]
  const sizes = await Promise.all(roots.map((directory) => measureReconciliationDirectory(root, directory, excluded)))
  const measured = sizes.reduce((sum, size) => sum + size, 0)
  const delta = measured - usedBytes
  if (delta !== 0) {
    await client.query(
      `INSERT INTO storage_quota_events
         (user_id,category,operation,delta_bytes,resource_type,resource_id,idempotency_key,metadata_json,created_at)
       VALUES ($1,'file_library','reconcile',$2,'quota','file_library',$3,$4::jsonb,CURRENT_TIMESTAMP)`,
      [ownerId, delta, `trash-reconcile:${ownerId}:${randomUUID()}`, JSON.stringify({ measured_bytes: measured })],
    )
  }
  await client.query(
    `UPDATE storage_quota_ledgers SET used_bytes=$2,last_reconciled_at=CURRENT_TIMESTAMP,
       updated_at=CURRENT_TIMESTAMP WHERE user_id=$1 AND category='file_library' AND status='active'`,
    [ownerId, measured],
  )
  return measured
}

export async function releaseTrashQuota(
  client: PoolClient,
  ownerId: string,
  fileId: number,
  sizeBytes: number,
  usedBytes: number,
): Promise<number> {
  const released = Math.min(Math.max(0, sizeBytes), Math.max(0, usedBytes))
  if (released <= 0) return usedBytes
  await client.query(
    `INSERT INTO storage_quota_events
       (user_id,category,operation,delta_bytes,resource_type,resource_id,idempotency_key,metadata_json,created_at)
     VALUES ($1,'file_library','trash_permanent_delete',$2,'file',$3,$4,NULL,CURRENT_TIMESTAMP)`,
    [ownerId, -released, String(fileId), `trash-permanent-delete:${fileId}`],
  )
  await client.query(
    `UPDATE storage_quota_ledgers SET used_bytes=$3,updated_at=CURRENT_TIMESTAMP
     WHERE user_id=$1 AND category=$2 AND status='active'`,
    [ownerId, 'file_library', usedBytes - released],
  )
  return usedBytes - released
}
