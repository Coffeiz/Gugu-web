import type { Fields, ProjectRecord } from '@gugu/core'
import type { Pool, PoolClient } from 'pg'
import { withPostgresTransaction } from '../../adapters/database/postgres-transaction.js'
import { recordForwardUndoOperation } from '../undo/record.js'
import { projectTimestamp } from './store.js'
import type { ProjectUpdatedEvent, ProjectUpdateRuntime, ProjectUpdateTransaction, ProjectUpdateUndoRecord } from '@gugu/core/project-update'
import { chmod, chown, lstat, mkdir, readdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { isPathWithin } from '../../shared/path-safety.js'
import { moveProjectFileNoReplace } from './lifecycle/storage.js'
import { runBestEffort } from '../../shared/best-effort.js'

type EventPublisher = (event: ProjectUpdatedEvent) => Promise<void>

type DirectoryRenamer = (ownerId: string, oldPrefix: string, newPrefix: string, beforeMove?: (from: string, to: string) => Promise<void>, onMoved?: () => void) => Promise<void>

const columns = `id, user_id::text AS user_id, name, summary, contact_name AS client, status,
  start_date, deadline, color, progress, stages_json, current_stage, priority, version, archived,
  done_at::text AS done_at, created_at::text AS created_at, updated_at::text AS updated_at,
  deleted_at::text AS deleted_at`

function project(row: Record<string, unknown>): ProjectRecord {
  return {
    id: Number(row.id),
    user_id: String(row.user_id),
    name: String(row.name),
    summary: row.summary == null ? null : String(row.summary),
    client: row.client == null ? null : String(row.client),
    status: String(row.status),
    start_date: row.start_date == null ? null : String(row.start_date),
    deadline: row.deadline == null ? null : String(row.deadline),
    color: String(row.color),
    progress: Number(row.progress),
    stages_json: String(row.stages_json),
    current_stage: row.current_stage == null ? null : String(row.current_stage),
    priority: row.priority == null ? null : String(row.priority),
    version: Number(row.version),
    archived: Boolean(row.archived),
    done_at: projectTimestamp(row.done_at),
    created_at: projectTimestamp(row.created_at) ?? '',
    updated_at: projectTimestamp(row.updated_at) ?? '',
    deleted_at: projectTimestamp(row.deleted_at),
  }
}

const fieldColumns: Record<string, string> = {
  name: 'name',
  summary: 'summary',
  client: 'contact_name',
  status: 'status',
  start_date: 'start_date',
  deadline: 'deadline',
  color: 'color',
  progress: 'progress',
  stages_json: 'stages_json',
  current_stage: 'current_stage',
  archived: 'archived',
  priority: 'priority',
}

function transactionAdapter(client: PoolClient): ProjectUpdateTransaction {
  return {
    async getOwned(ownerId, projectId) {
      const result = await client.query<Record<string, unknown>>(
        `SELECT ${columns} FROM projects WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL FOR UPDATE`,
        [projectId, ownerId],
      )
      return result.rows[0] ? project(result.rows[0]) : null
    },

    async updateIfVersion(ownerId, projectId, version, fields: Fields) {
      const assignments: string[] = []
      const values: unknown[] = [projectId, ownerId, version]
      for (const [field, column] of Object.entries(fieldColumns)) {
        if (!(field in fields)) continue
        values.push(fields[field])
        assignments.push(`${column} = $${values.length}`)
      }
      if ('status' in fields) {
        assignments.push(fields.status === 'done'
          ? 'done_at = COALESCE(done_at, CURRENT_TIMESTAMP)'
          : 'done_at = NULL')
      }
      if (assignments.length === 0) return null
      assignments.push('version = version + 1', 'updated_at = CURRENT_TIMESTAMP')
      const result = await client.query<Record<string, unknown>>(
        `UPDATE projects SET ${assignments.join(', ')}
         WHERE id = $1 AND user_id = $2 AND version = $3 AND deleted_at IS NULL
         RETURNING ${columns}`,
        values,
      )
      return result.rows[0] ? project(result.rows[0]) : null
    },

    async recordUndo(record: ProjectUpdateUndoRecord) {
      const context = record.contextId.trim().slice(0, 128)
      if (!context) return
      await recordForwardUndoOperation(client, { ...record, contextId: context })
    },
  }
}

/** PostgreSQL update adapter. Project and Undo writes share one transaction. */
export function createPostgresProjectUpdateRuntime(
  pool: Pool,
  renameProjectDirectory: DirectoryRenamer,
  publishProjectUpdated: EventPublisher,
  readFileCount: (ownerId: string, projectId: number) => Promise<number>,
): ProjectUpdateRuntime {
  return {
    async transaction<T>(work: (tx: ProjectUpdateTransaction) => Promise<T>): Promise<T> {
      return withPostgresTransaction(pool, (client) => work(transactionAdapter(client)))
    },
    renameProjectDirectory: (owner, oldPrefix, newPrefix, onMoved) => renameProjectDirectory(owner, oldPrefix, newPrefix, undefined, onMoved),
    async getFileCount(ownerId, projectId) {
      return readFileCount(ownerId, projectId)
    },
    publishProjectUpdated,
  }
}

function keySegments(key: string): string[] {
  if (typeof key !== 'string' || key.length === 0 || key.includes('\0') || key.includes('\\') || key.startsWith('/'))
    throw new Error('项目目录前缀必须是安全相对路径')
  const segments = key.split('/')
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..'))
    throw new Error('项目目录前缀必须是安全相对路径')
  return segments
}

function targetPath(root: string, key: string): string {
  const target = path.resolve(root, ...keySegments(key))
  if (!isPathWithin(root, target)) throw new Error('项目目录路径超出存储根目录')
  return target
}

async function assertNoSymlinkComponents(root: string, target: string): Promise<void> {
  if (!isPathWithin(root, target)) throw new Error('项目目录路径超出存储根目录')
  const relative = path.relative(root, target)
  if (!relative) return
  let current = root
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment)
    let info
    try {
      info = await lstat(current)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return
      throw error
    }
    if (info.isSymbolicLink()) throw new Error('项目目录路径不能经过符号链接')
    if (current !== target && !info.isDirectory()) return
  }
}

async function assertRealpathWithin(root: string, target: string): Promise<void> {
  const resolved = await realpath(target)
  if (!isPathWithin(root, resolved)) throw new Error('项目目录路径超出存储根目录')
}

async function assertTreeContainsNoSymlinks(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const child = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) throw new Error('项目目录树不能包含符号链接')
    if (entry.isDirectory()) await assertTreeContainsNoSymlinks(child)
  }
}

async function inheritGroupAccess(target: string, directory: boolean): Promise<void> {
  try {
    const parent = await stat(path.dirname(target))
    const current = await lstat(target)
    await chown(target, current.uid, parent.gid)
    const mode = current.mode & 0o7777
    await chmod(target, mode | (directory ? 0o070 : 0o060))
  } catch {
    // Python 的 _inherit_storage_access 同样把属主/权限修复作为尽力而为步骤。
  }
}

async function applyGroupAccessToTree(directory: string): Promise<void> {
  await inheritGroupAccess(directory, true)
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const child = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) throw new Error('项目目录树不能包含符号链接')
    if (entry.isDirectory()) await applyGroupAccessToTree(child)
    else await inheritGroupAccess(child, false)
  }
}

/** 保留 Local 路径约束；平台缺少原子不覆盖目录移动能力时拒绝。 */
export async function renameLocalProjectDirectory(
  storageRoot: string,
  oldPrefix: string,
  newPrefix: string,
  beforeMove?: (from: string, to: string) => Promise<void>,
  onMoved?: () => void,
): Promise<void> {
  const absoluteRoot = path.resolve(storageRoot)
  // Validate both keys before checking existence so an absent source cannot hide traversal input.
  keySegments(oldPrefix)
  keySegments(newPrefix)

  let root: string
  try {
    root = await realpath(absoluteRoot)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  const oldPath = targetPath(root, oldPrefix)
  const newPath = targetPath(root, newPrefix)
  if (oldPath === newPath) return
  if (!isPathWithin(root, oldPath) || !isPathWithin(root, newPath))
    throw new Error('项目目录路径超出存储根目录')
  await assertNoSymlinkComponents(root, oldPath)
  await assertNoSymlinkComponents(root, newPath)

  let sourceInfo
  try {
    sourceInfo = await lstat(oldPath)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return
    throw error
  }
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink())
    throw new Error('项目目录源必须是存储根目录内的真实目录')
  await assertTreeContainsNoSymlinks(oldPath)

  const parent = path.dirname(newPath)
  await assertNoSymlinkComponents(root, parent)
  await mkdir(parent, { recursive: true })
  await assertNoSymlinkComponents(root, parent)
  await assertRealpathWithin(root, parent)
  if (beforeMove) {
    try { await lstat(newPath); throw new Error('项目目录目标已存在') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    await beforeMove(oldPrefix, newPrefix)
  }
  // 当前 Node 无目录 rename-noreplace 原语；安全移动端口会拒绝，保留源目录。
  await moveProjectFileNoReplace(oldPath, newPath, async () => {
    await assertNoSymlinkComponents(root, oldPath)
    await assertNoSymlinkComponents(root, newPath)
    await assertRealpathWithin(root, oldPath)
    await assertRealpathWithin(root, parent)
  })
  onMoved?.()
  await assertNoSymlinkComponents(root, newPath)
  await assertRealpathWithin(root, newPath)
  await assertTreeContainsNoSymlinks(newPath)
  await applyGroupAccessToTree(newPath)
}

/** Host callback factory; root must be the configured local storage root. */
export function createLocalProjectDirectoryRenamer(storageRoot: string) {
  return async (ownerId: string, oldPrefix: string, newPrefix: string, beforeMove?: (from: string, to: string) => Promise<void>, onMoved?: () => void): Promise<void> => {
    if (keySegments(oldPrefix)[0] !== ownerId || keySegments(newPrefix)[0] !== ownerId)
      throw new Error('项目目录前缀与 owner 不匹配')
    await renameLocalProjectDirectory(storageRoot, oldPrefix, newPrefix, beforeMove, onMoved)
  }
}

export type ProjectPostCommitResource = 'projects' | 'files' | 'calendar' | 'scheduled_tasks'

export type ProjectPostCommitOperation = 'create' | 'update' | 'delete'

export interface ProjectPostCommitPublication {
  userId: string
  resource: ProjectPostCommitResource
  operation: ProjectPostCommitOperation
  entityId?: number | string
  entityIds?: Array<number | string>
  origin: string | null
  payload?: Record<string, unknown>
}

export interface ProjectPostCommitEffects {
  bumpContextRevision(ownerId: string, resource: ProjectPostCommitResource): Promise<unknown>
  publishResourceChanged(publication: ProjectPostCommitPublication): Promise<unknown>
}

export type ProjectPostCommitFailureReporter = (operation: string, errorCode?: string) => void

const ragSourceByResource: Partial<Record<ProjectPostCommitResource, 'project' | 'calendar' | 'scheduled_task'>> = {
  projects: 'project',
  calendar: 'calendar',
  scheduled_tasks: 'scheduled_task',
}

/** 项目 create/update/trash 的 Redis revision、持久 RAG 队列与 live event 提交后处理。 */
export function createProjectPostCommitPublisher(
  pool: Pool,
  effects: ProjectPostCommitEffects,
  reportFailure: ProjectPostCommitFailureReporter = (operation) => {
    console.error(`gugu-webui ${operation} failed`)
  },
): (publication: ProjectPostCommitPublication) => Promise<void> {
  return async (publication) => {
    await runBestEffort('project context revision', () =>
      effects.bumpContextRevision(publication.userId, publication.resource), reportFailure)

    const sourceType = ragSourceByResource[publication.resource]
    const sourceIds = (publication.entityIds ?? (publication.entityId === undefined ? [] : [publication.entityId]))
      .map(String)
      .filter((id) => id.length > 0)
    if (sourceType) {
      for (const sourceId of sourceIds) {
        await runBestEffort('project RAG index enqueue', async () => {
          await pool.query(
            `INSERT INTO rag_index_jobs (
               user_id, source_type, source_id, version, operation, status,
               generation, completed_generation, attempts, next_attempt_at,
               lease_until, last_started_at, last_succeeded_at, last_error_code,
               pending_source_ids, created_at, updated_at
             ) VALUES (
               $1, $2, $3::varchar, '', $4, 'queued',
               1, 0, 0, CURRENT_TIMESTAMP,
               NULL, NULL, NULL, NULL,
               json_build_array($3::varchar), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
             )
             ON CONFLICT (user_id, source_type) DO UPDATE SET
               source_id = CASE WHEN rag_index_jobs.source_id = '' AND rag_index_jobs.status IN ('queued','running','retrying') THEN '' ELSE EXCLUDED.source_id END,
               version = EXCLUDED.version,
               operation = EXCLUDED.operation,
               status = 'queued',
               generation = rag_index_jobs.generation + 1,
               next_attempt_at = CURRENT_TIMESTAMP,
               lease_until = NULL,
               last_error_code = NULL,
               pending_source_ids = CASE WHEN rag_index_jobs.source_id = '' AND rag_index_jobs.status IN ('queued','running','retrying') THEN '[]'::json ELSE (
                 SELECT COALESCE(json_agg(ordered.id ORDER BY ordered.first_ordinal), '[]'::json)
                 FROM (
                   SELECT candidates.id, MIN(candidates.ordinal) AS first_ordinal
                   FROM (
                     SELECT value AS id, ordinality AS ordinal
                     FROM jsonb_array_elements_text(
                       COALESCE(rag_index_jobs.pending_source_ids::jsonb, '[]'::jsonb)
                     ) WITH ORDINALITY
                     UNION ALL
                     SELECT EXCLUDED.source_id AS id, 2147483647 AS ordinal
                   ) AS candidates
                   GROUP BY candidates.id
                 ) AS ordered
               ) END,
               updated_at = CURRENT_TIMESTAMP`,
            [publication.userId, sourceType, sourceId, publication.operation],
          )
        }, reportFailure)
      }
    }

    await runBestEffort('project resource notification', () =>
      effects.publishResourceChanged(publication), reportFailure)
  }
}
