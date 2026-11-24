import { CoreError, normalizeWorkspaceDirectoryName, validateWorkspaceDirectoryName } from '@gugu/core'
import { createLocalFileTree } from '@gugu/fs/node'
import { workspaceDirectoryStorageKey } from './roots.js'
import type { Pool, PoolClient, QueryResultRow } from 'pg'
import { normalizeOwnerId } from '../../shared/owner-context.js'
import { withPostgresTransaction } from '../../adapters/database/postgres-transaction.js'
import { enqueueScheduledTaskRagRebuild } from '../scheduled-tasks/store.js'
import { isPathWithin } from '../../shared/path-safety.js'
import { access, rename, rm, realpath } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import type { WorkspaceDirectoryCard, WorkspaceDirectoryOperations } from './routes.js'
import { createWorkspaceFileReads } from './files.js'

type SqlExecutor = Pick<PoolClient, 'query'>

interface DirectoryRow extends QueryResultRow {
  id: number | string
  user_id: string
  name: string
  directory_name: string
  is_default: boolean
  is_system: boolean
}

interface CountRow extends QueryResultRow {
  directory_id: number | string
  count: number | string
}

interface TerminalRow extends QueryResultRow {
  id: string
}

interface DirectoryCounts {
  file_count: number
  folder_count: number
  bound_session_count: number
  bound_task_count: number
}

export interface WorkspaceDirectoryRuntime {
  localPath: string
  /** 创建目录或修复已有目录权限，必须使用 Host 的沙盒 ACL 事实源。 */
  prepareDirectoryAcl(directoryPath: string): Promise<void>
  /** 对 DB 中仍标记打开的 PTY 做 terminate(force=true)；运行时不存在时应安全无操作。 */
  terminateActivePty(terminalId: string): Promise<void>
  now?: () => Date
}

function directoryId(value: number): number {
  if (!Number.isSafeInteger(value))
    throw new CoreError('invalid_request', 'Workspace ID 无效')
  return value
}

function segmentFor(name: string, id: number): string {
  const segment = name.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^[-_ ]+|[-_ ]+$/g, '').slice(0, 48).toLowerCase()
  return segment && segment !== 'default' ? segment : `workspace-${id}`
}

function asInteger(value: number | string, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new Error(`Workspace ${field} count is invalid`)
  return parsed
}

async function resolveNonStrict(path: string): Promise<string> {
  const missing: string[] = []
  let current = path
  while (true) {
    try { return resolve(await realpath(current), ...missing) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(current)
      if (parent === current) throw error
      missing.unshift(basename(current))
      current = parent
    }
  }
}

async function workspaceRoot(runtime: WorkspaceDirectoryRuntime, user: string, segment: string): Promise<string> {
  if (!/^[A-Za-z0-9_-]+$/.test(segment) || segment === '.' || segment === '..')
    throw new CoreError('conflict', 'Workspace 目录名无效')
  const userRoot = await resolveNonStrict(resolve(runtime.localPath, user))
  const expected = resolve(userRoot, 'workspace')
  const root = resolve(expected, segment)
  if (dirname(root) !== expected) throw new CoreError('conflict', 'Workspace 目录不在用户存储根内')
  const resolvedRoot = await resolveNonStrict(root)
  if (resolvedRoot === expected || !isPathWithin(expected, resolvedRoot))
    throw new CoreError('conflict', 'Workspace 目录不在用户存储根内')
  return resolvedRoot
}

async function existingPath(path: string): Promise<boolean> {
  try { await access(path); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function lockOwner(client: SqlExecutor, user: string): Promise<void> {
  const result = await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [user])
  if (result.rowCount !== 1) throw new CoreError('not_found', '用户不存在')
}

async function ensureWorkspaceBinding(client: SqlExecutor, user: string, row: DirectoryRow): Promise<void> {
  const found = await client.query(
    'SELECT id FROM workspaces WHERE user_id = $1 AND directory_id = $2 LIMIT 1',
    [user, row.id],
  )
  if (found.rowCount) return
  await client.query(
    `INSERT INTO workspaces (user_id, name, kind, directory_id, enabled, is_default, created_at, updated_at)
     VALUES ($1, $2, 'directory', $3, TRUE, FALSE, now(), now())`,
    [user, row.name, row.id],
  )
}

async function getDirectory(
  client: SqlExecutor,
  user: string,
  id: number,
  lock = false,
): Promise<DirectoryRow> {
  const result = await client.query<DirectoryRow>(
    `SELECT id, user_id::text, name, directory_name, is_default, is_system
     FROM workspace_directories WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`,
    [id, user],
  )
  const row = result.rows[0]
  if (!row) throw new CoreError('not_found', 'Workspace 不存在')
  return row
}

async function countsForDirectories(
  client: SqlExecutor,
  user: string,
  rows: DirectoryRow[],
  recursive: boolean,
  storageRoot: string,
): Promise<Map<number, DirectoryCounts>> {
  const counts = new Map<number, DirectoryCounts>()
  if (!rows.length) return counts
  const ids = rows.map((row) => Number(row.id))
  const sessions = await client.query<CountRow>(
    `SELECT directory.directory_id, COUNT(session.id)::text AS count
     FROM workspaces AS directory
     JOIN conversation_sessions AS session
       ON session.workspace_id = directory.id AND session.user_id = $1
     WHERE directory.user_id = $1 AND directory.directory_id = ANY($2::integer[])
     GROUP BY directory.directory_id`, [user, ids],
  )
  const tasks = await client.query<CountRow>(
    `SELECT directory.directory_id, COUNT(task.id)::text AS count
     FROM workspaces AS directory
     JOIN scheduled_tasks AS task
       ON task.workspace_id = directory.id AND task.user_id = $1
     WHERE directory.user_id = $1 AND directory.directory_id = ANY($2::integer[])
     GROUP BY directory.directory_id`, [user, ids],
  )
  for (const row of rows) {
    const count = { file_count: 0, folder_count: 0, bound_session_count: 0, bound_task_count: 0 }
    const tree = createLocalFileTree(storageRoot, workspaceDirectoryStorageKey(user, row.directory_name))
    const pending = ['']
    while (pending.length) {
      const entries = await tree.list(pending.pop()!)
      for (const entry of entries ?? []) {
        if (entry.kind === 'file') count.file_count++
        else {
          count.folder_count++
          if (recursive) pending.push(entry.relativePath)
        }
      }
    }
    counts.set(Number(row.id), count)
  }
  for (const [result, key] of [
    [sessions, 'bound_session_count'], [tasks, 'bound_task_count'],
  ] as const) {
    for (const row of result.rows) {
      const value = counts.get(Number(row.directory_id))
      if (value) value[key] = asInteger(row.count, key)
    }
  }
  return counts
}

async function cards(
  client: SqlExecutor,
  user: string,
  rows: DirectoryRow[],
  storageRoot: string,
  preview = false,
): Promise<WorkspaceDirectoryCard[]> {
  const counts = await countsForDirectories(client, user, rows, preview, storageRoot)
  return rows.map((row) => {
    const count = counts.get(Number(row.id)) ?? {
      file_count: 0, folder_count: 0, bound_session_count: 0, bound_task_count: 0,
    }
    return {
      id: Number(row.id),
      name: row.name,
      directory_name: row.directory_name,
      is_default: row.is_default,
      is_system: row.is_system,
      file_count: count.file_count,
      folder_count: count.folder_count,
      bound_session_count: count.bound_session_count,
      bound_task_count: count.bound_task_count,
    }
  })
}

async function cardById(client: SqlExecutor, user: string, id: number, storageRoot: string): Promise<WorkspaceDirectoryCard> {
  const row = await getDirectory(client, user, id)
  return (await cards(client, user, [row], storageRoot))[0]!
}

function conflictOnUnique(error: unknown): boolean {
  const pgError = error as { code?: unknown; constraint?: unknown }
  return pgError?.code === '23505' && typeof pgError.constraint === 'string'
    && ['uq_workspace_directory_name', 'uq_workspace_directory_display_name'].includes(pgError.constraint)
}

function mapTransactionError(error: unknown): unknown {
  return conflictOnUnique(error) ? new CoreError('conflict', 'Workspace 已存在') : error
}

/** PostgreSQL 与本地存储端口；事务/PTY/磁盘次序与 Python workspace_directories_router 一致。 */
export function createPostgresWorkspaceDirectoryOperations(
  pool: Pool,
  runtime: WorkspaceDirectoryRuntime,
): WorkspaceDirectoryOperations {
  return {
    files: process.platform === 'linux' ? createWorkspaceFileReads(pool, runtime.localPath) : undefined,
    async list(rawOwnerId) {
      const user = normalizeOwnerId(rawOwnerId)
      const result = await pool.query<DirectoryRow>(
        `SELECT id, user_id::text, name, directory_name, is_default, is_system
         FROM workspace_directories WHERE user_id = $1 AND deleted_at IS NULL
         ORDER BY is_default DESC, name`, [user],
      )
      const resultCards = await cards(pool, user, result.rows, runtime.localPath)
      for (const row of result.rows) {
        const path = await workspaceRoot(runtime, user, row.directory_name)
        if (await existingPath(path)) await runtime.prepareDirectoryAcl(path)
      }
      return resultCards
    },

    async create(rawOwnerId, rawName) {
      const user = normalizeOwnerId(rawOwnerId)
      const name = normalizeWorkspaceDirectoryName(rawName)
      return withPostgresTransaction(pool, async (client) => {
        await lockOwner(client, user)
        validateWorkspaceDirectoryName(name)
        const duplicate = await client.query(
          `SELECT id FROM workspace_directories
           WHERE user_id = $1 AND name = $2 AND deleted_at IS NULL`, [user, name],
        )
        if (duplicate.rowCount) throw new CoreError('conflict', 'Workspace 已存在')
        const inserted = await client.query<DirectoryRow>(
          `INSERT INTO workspace_directories
             (user_id, name, directory_name, is_default, is_system, created_at, updated_at)
           VALUES ($1, $2, '', FALSE, FALSE, now(), now())
           RETURNING id, user_id::text, name, directory_name, is_default, is_system`,
          [user, name],
        )
        const row = inserted.rows[0]
        if (!row) throw new Error('Workspace 创建后未返回记录')
        const alias = segmentFor(name, Number(row.id))
        const occupied = await client.query(
          `SELECT id FROM workspace_directories
           WHERE user_id = $1 AND directory_name = $2 AND deleted_at IS NULL AND id <> $3`,
          [user, alias, row.id],
        )
        const proposedPath = await workspaceRoot(runtime, user, alias)
        const segment = occupied.rowCount || await existingPath(proposedPath)
          ? `${alias}-${row.id}`
          : alias
        await client.query(
          'UPDATE workspace_directories SET directory_name = $3, updated_at = now() WHERE id = $1 AND user_id = $2',
          [row.id, user, segment],
        )
        row.directory_name = segment
        const root = await workspaceRoot(runtime, user, segment)
        await runtime.prepareDirectoryAcl(root)
        await ensureWorkspaceBinding(client, user, row)
        return cardById(client, user, Number(row.id), runtime.localPath)
      }, mapTransactionError)
    },

    async update(rawOwnerId, rawId, rawName) {
      const user = normalizeOwnerId(rawOwnerId)
      const id = directoryId(rawId)
      const name = normalizeWorkspaceDirectoryName(rawName)
      return withPostgresTransaction(pool, async (client) => {
        await lockOwner(client, user)
        const row = await getDirectory(client, user, id, true)
        if (row.is_system) throw new CoreError('conflict', '默认 Workspace 不可重命名')
        validateWorkspaceDirectoryName(name)
        if (name !== row.name) {
          const duplicate = await client.query(
            `SELECT id FROM workspace_directories
             WHERE user_id = $1 AND name = $2 AND deleted_at IS NULL AND id <> $3`,
            [user, name, id],
          )
          if (duplicate.rowCount) throw new CoreError('conflict', 'Workspace 已存在')
          await client.query(
            `UPDATE workspace_directories SET name = $3, updated_at = now()
             WHERE id = $1 AND user_id = $2`, [id, user, name],
          )
          await client.query(
            `UPDATE workspaces SET name = $3, updated_at = now()
             WHERE user_id = $1 AND directory_id = $2`, [user, id, name],
          )
        }
        return cardById(client, user, id, runtime.localPath)
      }, mapTransactionError)
    },

    async previewDelete(rawOwnerId, rawId) {
      const user = normalizeOwnerId(rawOwnerId)
      const id = directoryId(rawId)
      const row = await getDirectory(pool, user, id)
      if (row.is_default || row.is_system)
        throw new CoreError('conflict', '默认 Workspace 不可删除')
      return (await cards(pool, user, [row], runtime.localPath, true))[0]!
    },

    async delete(rawOwnerId, rawId, expected) {
      const user = normalizeOwnerId(rawOwnerId)
      const id = directoryId(rawId)
      let root = ''
      await withPostgresTransaction(pool, async (client) => {
        await lockOwner(client, user)
        const directory = await getDirectory(client, user, id, true)
        if (directory.is_default || directory.is_system)
          throw new CoreError('conflict', '默认 Workspace 不可删除')
        if (expected) {
          const current = (await cards(client, user, [directory], runtime.localPath, true))[0]
          const identity = (row: WorkspaceDirectoryCard) => [row.id, row.name, row.directory_name, row.is_default, row.is_system,
            row.file_count, row.folder_count, row.bound_session_count, row.bound_task_count]
          if (!current || JSON.stringify(identity(current)) !== JSON.stringify(identity(expected)))
            throw new CoreError('conflict', '工作区目录内容或状态已变化')
        }
        root = await workspaceRoot(runtime, user, directory.directory_name)
        const bindings = await client.query<{ id: number | string } & QueryResultRow>(
          'SELECT id FROM workspaces WHERE user_id = $1 AND directory_id = $2', [user, id],
        )
        const bindingIds = bindings.rows.map(({ id: bindingId }) => Number(bindingId))
        const terminalIds: string[] = []
        if (bindingIds.length) {
          const terminals = await client.query<TerminalRow>(
            `SELECT id::text AS id FROM terminal_sessions
             WHERE owner_id = $1 AND workspace_id = ANY($2::integer[]) AND closed_at IS NULL`,
            [user, bindingIds],
          )
          terminalIds.push(...terminals.rows.map(({ id: terminalId }) => terminalId))
          await client.query(
            `UPDATE conversation_sessions SET workspace_id = NULL
             WHERE user_id = $1 AND workspace_id = ANY($2::integer[])`, [user, bindingIds],
          )
          const changedTasks = await client.query<{ id: number | string } & QueryResultRow>(
            `UPDATE scheduled_tasks SET workspace_id = NULL, enabled = FALSE
             WHERE user_id = $1 AND workspace_id = ANY($2::integer[]) RETURNING id`, [user, bindingIds],
          )
          for (const task of changedTasks.rows) await enqueueScheduledTaskRagRebuild(client, user, Number(task.id))
          const now = runtime.now?.() ?? new Date()
          await client.query(
            `UPDATE terminal_sessions SET status = 'terminated', closed_at = $3, updated_at = $3
             WHERE owner_id = $1 AND workspace_id = ANY($2::integer[]) AND closed_at IS NULL`,
            [user, bindingIds, now],
          )
          await client.query(
            'DELETE FROM workspaces WHERE user_id = $1 AND directory_id = $2', [user, id],
          )
        }
        const now = runtime.now?.() ?? new Date()
        await client.query(
          `UPDATE workspace_directories SET deleted_at = $3, updated_at = $3
           WHERE id = $1 AND user_id = $2`, [id, user, now],
        )
        // PTY 必须在 DB commit 前关停；若关停失败，inTransaction 回滚所有授权与绑定变更。
        for (const terminalId of terminalIds) await runtime.terminateActivePty(terminalId)
      }, mapTransactionError)

      // 只有提交成功才原子移走目录。清理失败会留下墓碑目录供后续回收，不恢复 DB 记录。
      try {
        if (await existingPath(root)) {
          const now = runtime.now?.() ?? new Date()
          const stamp = now.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
          const tombstone = resolve(dirname(root), `.${basename(root)}.deleted-${stamp}`)
          await rename(root, tombstone)
          await rm(tombstone, { recursive: true, force: true })
        }
      } catch {
        // Python API treats post-commit physical cleanup as best-effort.
      }
      return { ok: true, workspaceDirectoryId: id }
    },
  }
}
