import { CoreError, dataContext } from '@gugu/core'
import type { Pool, PoolClient, QueryResultRow } from 'pg'
import { access, rename, rm, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { WorkspaceDirectoryCard, WorkspaceDirectoryOperations } from '../workspace-directories.js'

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
  storageBackend: 'local' | 'oss'
  localPath: string
  /** 创建目录或修复已有目录权限，必须使用 Host 的沙盒 ACL 事实源。 */
  prepareDirectoryAcl(directoryPath: string): Promise<void>
  /** 对 DB 中仍标记打开的 PTY 做 terminate(force=true)；运行时不存在时应安全无操作。 */
  terminateActivePty(terminalId: string): Promise<void>
  now?: () => Date
}

const reservedRoots = new Set(['workspace', 'shell', '个人文件', '项目文件', '思维', '素材板'])
const invalidName = /[\\/:*?"<>|]/

function ownerId(raw: string): string {
  try { return dataContext(raw).ownerId } catch {
    throw new CoreError('invalid_request', '用户 ID 无效')
  }
}

function directoryId(value: number): number {
  if (!Number.isSafeInteger(value))
    throw new CoreError('invalid_request', 'Workspace ID 无效')
  return value
}

function normalizeName(value: string): string {
  const name = value.trim()
  if (!name) throw new CoreError('invalid_request', '名称不能为空')
  if (Array.from(name).length > 200) throw new CoreError('invalid_request', '名称长度不能超过 200 个字符')
  if (invalidName.test(name)) throw new CoreError('invalid_request', '名称不能包含以下字符：\\ / : * ? " < > |')
  return name
}

function validateDisplayName(name: string): void {
  const safeName = name.replace(/[\\/:*?"<>|]/g, '_')
  if (reservedRoots.has(safeName) || name.toLowerCase() === 'default')
    throw new CoreError('conflict', 'Workspace 名称与系统目录冲突')
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
  const fromWorkspace = relative(expected, resolvedRoot)
  if (!fromWorkspace || fromWorkspace === '..' || fromWorkspace.startsWith(`..${sep}`) || isAbsolute(fromWorkspace))
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

async function ensureDefaultDirectory(
  client: SqlExecutor,
  user: string,
  runtime: WorkspaceDirectoryRuntime,
): Promise<DirectoryRow> {
  let result = await client.query<DirectoryRow>(
    `SELECT id, user_id::text, name, directory_name, is_default, is_system
     FROM workspace_directories WHERE user_id = $1 AND directory_name = 'default'
       AND deleted_at IS NULL FOR UPDATE`,
    [user],
  )
  let row = result.rows[0]
  if (!row) {
    result = await client.query<DirectoryRow>(
      `INSERT INTO workspace_directories
         (user_id, name, directory_name, is_default, is_system, created_at, updated_at)
       VALUES ($1, '默认工作区', 'default', TRUE, TRUE, now(), now())
       ON CONFLICT (user_id, directory_name) WHERE deleted_at IS NULL DO NOTHING
       RETURNING id, user_id::text, name, directory_name, is_default, is_system`,
      [user],
    )
    row = result.rows[0]
    if (!row) {
      result = await client.query<DirectoryRow>(
        `SELECT id, user_id::text, name, directory_name, is_default, is_system
         FROM workspace_directories WHERE user_id = $1 AND directory_name = 'default'
           AND deleted_at IS NULL FOR UPDATE`,
        [user],
      )
      row = result.rows[0]
    }
  }
  if (!row) throw new Error('默认 Workspace 创建后未返回记录')
  await ensureWorkspaceBinding(client, user, row)
  await runtime.prepareDirectoryAcl(await workspaceRoot(runtime, user, row.directory_name))
  return row
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
  preview: boolean,
): Promise<Map<number, DirectoryCounts>> {
  const counts = new Map<number, DirectoryCounts>()
  if (!rows.length) return counts
  const ids = rows.map((row) => Number(row.id))
  const files = await client.query<CountRow>(
    `SELECT workspace_directory_id AS directory_id, COUNT(id)::text AS count FROM files
     WHERE user_id = $1 AND workspace_directory_id = ANY($2::integer[]) AND deleted_at IS NULL
     ${preview ? '' : "AND space = 'workspace' AND folder_id IS NULL"}
     GROUP BY workspace_directory_id`, [user, ids],
  )
  const folders = await client.query<CountRow>(
    `SELECT workspace_directory_id AS directory_id, COUNT(id)::text AS count FROM folders
     WHERE user_id = $1 AND workspace_directory_id = ANY($2::integer[]) AND deleted_at IS NULL
     ${preview ? '' : 'AND parent_id IS NULL'}
     GROUP BY workspace_directory_id`, [user, ids],
  )
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
  for (const id of ids) counts.set(id, {
    file_count: 0, folder_count: 0, bound_session_count: 0, bound_task_count: 0,
  })
  for (const [result, key] of [
    [files, 'file_count'], [folders, 'folder_count'],
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
  preview = false,
): Promise<WorkspaceDirectoryCard[]> {
  const counts = await countsForDirectories(client, user, rows, preview)
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

async function cardById(client: SqlExecutor, user: string, id: number): Promise<WorkspaceDirectoryCard> {
  const row = await getDirectory(client, user, id)
  return (await cards(client, user, [row]))[0]!
}

function conflictOnUnique(error: unknown): boolean {
  const pgError = error as { code?: unknown; constraint?: unknown }
  return pgError?.code === '23505' && typeof pgError.constraint === 'string'
    && ['uq_workspace_directory_name', 'uq_workspace_directory_display_name'].includes(pgError.constraint)
}

async function inTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await work(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    if (conflictOnUnique(error)) throw new CoreError('conflict', 'Workspace 已存在')
    throw error
  } finally {
    client.release()
  }
}

/** PostgreSQL 与本地存储端口；事务/PTY/磁盘次序与 Python workspace_directories_router 一致。 */
export function createPostgresWorkspaceDirectoryOperations(
  pool: Pool,
  runtime: WorkspaceDirectoryRuntime,
): WorkspaceDirectoryOperations {
  return {
    async list(rawOwnerId) {
      const user = ownerId(rawOwnerId)
      const result = await pool.query<DirectoryRow>(
        `SELECT id, user_id::text, name, directory_name, is_default, is_system
         FROM workspace_directories WHERE user_id = $1 AND deleted_at IS NULL
         ORDER BY is_default DESC, name`, [user],
      )
      const resultCards = await cards(pool, user, result.rows)
      if (runtime.storageBackend === 'local') {
        for (const row of result.rows) {
          const path = await workspaceRoot(runtime, user, row.directory_name)
          if (await existingPath(path)) await runtime.prepareDirectoryAcl(path)
        }
      }
      return resultCards
    },

    async create(rawOwnerId, rawName) {
      const user = ownerId(rawOwnerId)
      if (runtime.storageBackend !== 'local')
        throw new CoreError('conflict', '当前存储后端不支持本地 Workspace')
      const name = normalizeName(rawName)
      return inTransaction(pool, async (client) => {
        await lockOwner(client, user)
        await ensureDefaultDirectory(client, user, runtime)
        validateDisplayName(name)
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
        return cardById(client, user, Number(row.id))
      })
    },

    async update(rawOwnerId, rawId, rawName) {
      const user = ownerId(rawOwnerId)
      const id = directoryId(rawId)
      const name = normalizeName(rawName)
      return inTransaction(pool, async (client) => {
        await lockOwner(client, user)
        const row = await getDirectory(client, user, id, true)
        if (row.is_system) throw new CoreError('conflict', '默认 Workspace 不可重命名')
        validateDisplayName(name)
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
        return cardById(client, user, id)
      })
    },

    async previewDelete(rawOwnerId, rawId) {
      const user = ownerId(rawOwnerId)
      const id = directoryId(rawId)
      const row = await getDirectory(pool, user, id)
      if (row.is_default || row.is_system)
        throw new CoreError('conflict', '默认 Workspace 不可删除')
      return (await cards(pool, user, [row], true))[0]!
    },

    async delete(rawOwnerId, rawId) {
      const user = ownerId(rawOwnerId)
      const id = directoryId(rawId)
      if (runtime.storageBackend !== 'local')
        throw new CoreError('conflict', '当前存储后端不支持本地 Workspace')
      let root = ''
      await inTransaction(pool, async (client) => {
        await lockOwner(client, user)
        const directory = await getDirectory(client, user, id, true)
        if (directory.is_default || directory.is_system)
          throw new CoreError('conflict', '默认 Workspace 不可删除')
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
          await client.query(
            `UPDATE scheduled_tasks SET workspace_id = NULL, enabled = FALSE
             WHERE user_id = $1 AND workspace_id = ANY($2::integer[])`, [user, bindingIds],
          )
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
          `UPDATE files SET deleted_at = $3, updated_at = $3
           WHERE user_id = $1 AND workspace_directory_id = $2 AND deleted_at IS NULL`, [user, id, now],
        )
        await client.query(
          `UPDATE folders SET deleted_at = $3, updated_at = $3, version = version + 1
           WHERE user_id = $1 AND workspace_directory_id = $2 AND deleted_at IS NULL`, [user, id, now],
        )
        await client.query(
          `UPDATE workspace_directories SET deleted_at = $3, updated_at = $3
           WHERE id = $1 AND user_id = $2`, [id, user, now],
        )
        // PTY 必须在 DB commit 前关停；若关停失败，inTransaction 回滚所有授权与绑定变更。
        for (const terminalId of terminalIds) await runtime.terminateActivePty(terminalId)
      })

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
