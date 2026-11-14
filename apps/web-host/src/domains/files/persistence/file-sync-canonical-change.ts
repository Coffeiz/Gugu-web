import { createHash, randomUUID } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import path from 'node:path'
import type { PoolClient, QueryResultRow } from 'pg'
import { isPathWithin } from '../../../adapters/path-safety.js'

type BindingRow = QueryResultRow & {
  id: number | string
  workspace_id: number | string | null
  mode: string
  root_path: string
  revision: number | string
  gap_revision: number | string
  root_fingerprint: string
}

type WorkspaceRow = QueryResultRow & {
  kind: 'project' | 'directory' | 'folder'
  folder_id: number | string | null
  project_id: number | string | null
  directory_id: number | string | null
}

const LOCK_NAMESPACE = 'filesync-path'
const invalidPathChars = /[\\/:*?"<>|]/g

function pathName(value: string): string {
  const safe = value.replace(invalidPathChars, '_')
  if (!safe || safe === '.' || safe === '..') throw new Error('invalid path segment')
  return safe
}

function fileSyncPathLockKey(ownerId: string, storageKey: string): string {
  const digest = createHash('sha256').update(`${LOCK_NAMESPACE}:${ownerId}:${storageKey}`).digest()
  return digest.readBigInt64BE(0).toString()
}

export async function lockFileSyncPaths(client: PoolClient, ownerId: string, storageKeys: string[]): Promise<void> {
  const lockKeys = [...new Set(storageKeys.map((storageKey) => fileSyncPathLockKey(ownerId, storageKey)))]
    .sort((left, right) => BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0)
  for (const lockKey of lockKeys)
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [lockKey])
}

export async function lockFileSyncPath(client: PoolClient, ownerId: string, storageKey: string): Promise<void> {
  await lockFileSyncPaths(client, ownerId, [storageKey])
}

async function safeDirectory(rootPath: string, ownerId: string, segments: string[]): Promise<string | null> {
  let root: string
  try { root = await realpath(rootPath) } catch { return null }
  let current = root
  const parts = [ownerId, ...segments]
  for (const part of parts) {
    if (!part || part === '.' || part === '..' || part.includes('/') || part.includes('\\') || part.includes('\0'))
      return null
    current = path.join(current, part)
    let stat
    try { stat = await lstat(current) } catch { return null }
    if (stat.isSymbolicLink() || !stat.isDirectory()) return null
  }
  return await realpath(current)
}

function normalizeRelative(value: string): string | null {
  const normalized = value.replaceAll('\\', '/')
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized) || normalized.includes('\0'))
    return null
  const parts = normalized.split('/').filter((part) => part && part !== '.')
  if (!parts.length || parts.some((part) => part === '..')) return null
  return parts.join('/')
}

async function projectSegments(
  client: PoolClient,
  ownerId: string,
  projectId: number | string,
): Promise<string[] | null> {
  const result = await client.query<{ name: string; start_date: string | null; created_at: Date | string }>(
    `SELECT name,to_char(start_date,'YYYY-MM-DD') AS start_date,created_at FROM projects
     WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`, [projectId, ownerId],
  )
  const project = result.rows[0]
  if (!project) return null
  const rawDate = project.start_date || project.created_at
  const date = rawDate instanceof Date ? rawDate.toISOString().slice(0, 10) : String(rawDate).slice(0, 10)
  const match = /^(\d{4})-(\d{2})/.exec(date)
  if (!match) return null
  return ['项目文件', match[1]!, match[2]!, `${pathName(project.name)} #${Number(projectId)}`]
}

async function workspaceSegments(
  client: PoolClient,
  ownerId: string,
  workspaceId: number | string,
): Promise<string[] | null> {
  const result = await client.query<WorkspaceRow>(
    `SELECT kind,folder_id,project_id,directory_id FROM workspaces
     WHERE id=$1 AND user_id=$2 AND enabled IS TRUE`, [workspaceId, ownerId],
  )
  const workspace = result.rows[0]
  if (!workspace) return null

  if (workspace.kind === 'project' && workspace.project_id != null)
    return projectSegments(client, ownerId, workspace.project_id)

  if (workspace.kind === 'directory' && workspace.directory_id != null) {
    const directory = await client.query<{ directory_name: string }>(
      `SELECT directory_name FROM workspace_directories
       WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`, [workspace.directory_id, ownerId],
    )
    const name = directory.rows[0]?.directory_name
    return name ? ['workspace', pathName(name)] : null
  }

  if (workspace.kind !== 'folder' || workspace.folder_id == null) return null
  const folders = await client.query<{
    id: number | string
    parent_id: number | string | null
    name: string
    project_id: number | string | null
    workspace_directory_id: number | string | null
  } & QueryResultRow>(
    `WITH RECURSIVE chain AS (
       SELECT id,parent_id,name,project_id,workspace_directory_id,0 AS depth
       FROM folders WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL
       UNION ALL
       SELECT parent.id,parent.parent_id,parent.name,parent.project_id,parent.workspace_directory_id,chain.depth+1
       FROM folders parent JOIN chain ON chain.parent_id=parent.id
       WHERE parent.user_id=$2 AND parent.deleted_at IS NULL AND chain.depth < 64
     ) SELECT id,parent_id,name,project_id,workspace_directory_id,depth FROM chain ORDER BY depth DESC`,
    [workspace.folder_id, ownerId],
  )
  if (!folders.rows.length) return null
  const leaf = folders.rows.at(-1)!
  if (folders.rows[0]!.parent_id !== null || String(leaf.id) !== String(workspace.folder_id)) return null
  if (folders.rows.some((folder) => String(folder.project_id ?? '') !== String(leaf.project_id ?? '')
    || String(folder.workspace_directory_id ?? '') !== String(leaf.workspace_directory_id ?? ''))) return null
  const folderNames = folders.rows.map((folder) => pathName(folder.name))
  if (leaf.project_id != null) {
    const base = await projectSegments(client, ownerId, leaf.project_id)
    return base ? [...base, ...folderNames] : null
  }
  if (leaf.workspace_directory_id != null) {
    const directory = await client.query<{ directory_name: string }>(
      `SELECT directory_name FROM workspace_directories
       WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`, [leaf.workspace_directory_id, ownerId],
    )
    const name = directory.rows[0]?.directory_name
    return name ? ['workspace', pathName(name), ...folderNames] : null
  }
  return ['个人文件', ...folderNames]
}

async function bindingRoot(
  client: PoolClient,
  rootPath: string,
  ownerId: string,
  binding: BindingRow,
): Promise<string | null> {
  let segments: string[]
  if (binding.workspace_id != null) {
    const resolved = await workspaceSegments(client, ownerId, binding.workspace_id)
    if (!resolved) return null
    segments = resolved
  } else {
    const raw = binding.root_path || '.'
    if (raw === '.' || raw === './') segments = []
    else {
      const normalized = normalizeRelative(raw)
      if (normalized === null) return null
      segments = normalized.split('/')
    }
  }
  return safeDirectory(rootPath, ownerId, segments)
}

async function enqueueMirrorOut(client: PoolClient, ownerId: string, binding: BindingRow, revision: number): Promise<void> {
  const existing = await client.query<{ action: string; allow_delete: boolean; status: string }>(
    `SELECT action,allow_delete,status FROM file_sync_reconcile_runs
     WHERE binding_id=$1 AND status IN ('queued','running','cancelling')
     ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [binding.id],
  )
  const active = existing.rows[0]
  if (active) return
  await client.query(
    `INSERT INTO file_sync_reconcile_runs
       (id,user_id,binding_id,action,allow_delete,status,binding_revision,gap_revision,root_fingerprint,result_counts,created_at,updated_at)
     VALUES ($1,$2,$3,'mirror_out',FALSE,'queued',$4,$5,$6,'{}'::jsonb,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    [randomUUID(), ownerId, binding.id, revision, binding.gap_revision, binding.root_fingerprint],
  )
}

/** Best-effort mirror of Python's canonical file update side effects within the current DB transaction. */
export async function recordCanonicalFileChange(
  client: PoolClient,
  options: { ownerId: string; storageRoot: string; storageKey: string; observedFingerprint: string; enabled: boolean },
): Promise<void> {
  if (!options.enabled || !options.storageKey.startsWith(`${options.ownerId}/`)) return
  const ownerRelative = options.storageKey.slice(options.ownerId.length + 1)
  const filePath = await safeDirectoryFile(options.storageRoot, options.ownerId, ownerRelative)
  if (!filePath) return

  let bindingRows: BindingRow[]
  try {
    const bindings = await client.query<BindingRow>(
      `SELECT id,workspace_id,mode,root_path,revision,gap_revision,root_fingerprint
       FROM file_sync_bindings WHERE user_id=$1 AND source='local_directory' AND status='active'
       ORDER BY id`, [options.ownerId],
    )
    bindingRows = bindings.rows
  } catch { return }
  for (const binding of bindingRows) {
    try { await client.query('SAVEPOINT canonical_file_sync_change') } catch { continue }
    try {
      const root = await bindingRoot(client, options.storageRoot, options.ownerId, binding)
      if (!root) {
        await client.query('RELEASE SAVEPOINT canonical_file_sync_change')
        continue
      }
      if (binding.mode === 'mirror_out') {
        const revisionResult = await client.query<{ revision: number | string }>(
          `UPDATE file_sync_bindings SET revision=revision+1,updated_at=CURRENT_TIMESTAMP
           WHERE id=$1 AND user_id=$2 RETURNING revision`, [binding.id, options.ownerId],
        )
        const revision = revisionResult.rows[0]?.revision
        if (revision != null) await enqueueMirrorOut(client, options.ownerId, binding, Number(revision))
        await client.query('RELEASE SAVEPOINT canonical_file_sync_change')
        continue
      }

      if (filePath === root || !isPathWithin(root, filePath)) {
        await client.query('RELEASE SAVEPOINT canonical_file_sync_change')
        continue
      }
      const relative = path.relative(root, filePath)
      const relativePath = normalizeRelative(relative)
      if (!relativePath) {
        await client.query('RELEASE SAVEPOINT canonical_file_sync_change')
        continue
      }
      const idempotencyKey = createHash('sha256')
        .update(`file_api|update|file|${relativePath}|${options.observedFingerprint}`)
        .digest('hex')
      const duplicate = await client.query(
        `SELECT id FROM file_sync_journal WHERE binding_id=$1 AND user_id=$2 AND idempotency_key=$3 LIMIT 1`,
        [binding.id, options.ownerId, idempotencyKey],
      )
      if (!duplicate.rowCount) {
        const revision = await client.query<{ revision: number | string }>(
          `UPDATE file_sync_bindings SET revision=revision+1,updated_at=CURRENT_TIMESTAMP
           WHERE id=$1 AND user_id=$2 RETURNING revision`, [binding.id, options.ownerId],
        )
        const nextRevision = revision.rows[0]?.revision
        if (nextRevision != null) await client.query(
          `INSERT INTO file_sync_journal
             (binding_id,user_id,idempotency_key,source,operation,object_type,relative_path,
              baseline_fingerprint,observed_fingerprint,revision,status,created_at,updated_at)
           VALUES ($1,$2,$3,'file_api','update','file',$4,NULL,$5,$6,'synced',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
          [binding.id, options.ownerId, idempotencyKey, relativePath, options.observedFingerprint, nextRevision],
        )
      }
      await client.query('RELEASE SAVEPOINT canonical_file_sync_change')
    } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT canonical_file_sync_change').catch(() => undefined)
      await client.query('RELEASE SAVEPOINT canonical_file_sync_change').catch(() => undefined)
    }
  }
}

async function safeDirectoryFile(rootPath: string, ownerId: string, relativeFile: string): Promise<string | null> {
  const normalized = normalizeRelative(relativeFile)
  if (!normalized) return null
  const segments = normalized.split('/')
  const fileName = segments.pop()!
  const parent = await safeDirectory(rootPath, ownerId, segments)
  if (!parent) return null
  const candidate = path.join(parent, fileName)
  try {
    const stat = await lstat(candidate)
    if (stat.isSymbolicLink() || !stat.isFile()) return null
    return await realpath(candidate)
  } catch { return null }
}
