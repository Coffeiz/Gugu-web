import { resolveFileLibraryLimit, StorageQuotaScanBusy } from '../../admin/storage.js'
import type { StorageQuotaReconcilePort } from '../../admin/storage.js'
import { lstat, readdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type { Pool, PoolClient, QueryResultRow } from 'pg'
import { isPathWithin } from '../../../adapters/path-safety.js'

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
