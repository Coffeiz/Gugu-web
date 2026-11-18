import { createHash } from 'node:crypto'
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { CoreError } from '@gugu/core'
import { nextFolderCopyName, planFolderCopyTree } from '@gugu/core/files/folder-copy'
import type { FolderCopyPlanNode, FolderCopyTreeNode } from '@gugu/core/files/folder-copy'
import type { Pool, PoolClient, QueryResultRow } from 'pg'
import type { WriteRequestMetadata } from '../../app.js'
import { isPathWithin } from '../../adapters/path-safety.js'
import { isOwnedFileStorageKey } from '../../domains/files/file-owner.js'
import { createPostgresFolderPathMirrorPlanner } from '../../domains/files/folder-path-planner.js'
import { updateFileStorageQuota } from '../../domains/files/persistence/storage-quota.js'
import { lockFileSyncPath, recordCanonicalFileChange } from '../../domains/files/persistence/file-sync-canonical-change.js'
import type { FolderCopyInput, FolderCopyOperations } from './folder-copy.js'

type Row = QueryResultRow & Record<string, any>
type FolderMutation = Awaited<ReturnType<ReturnType<typeof createPostgresFolderPathMirrorPlanner>>>

async function safePath(rootPath: string, ownerId: string, key: string): Promise<string> {
  const segments = key.split('/')
  if (!isOwnedFileStorageKey(ownerId, key) || segments.some((part) => !part || part === '.' || part === '..' || part.includes('\\') || part.includes('\0')))
    throw new CoreError('not_found', '文件不存在')
  const root = await realpath(rootPath)
  let target = root
  for (const segment of segments) {
    target = path.resolve(target, segment)
    if (!isPathWithin(root, target)) throw new CoreError('not_found', '文件不存在')
    try {
      if ((await lstat(target)).isSymbolicLink()) throw new CoreError('not_found', '文件不存在')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
    }
  }
  return target
}

function safeSegment(value: string): string {
  const result = value.replace(/[\\/:*?"<>|]/g, '_')
  if (!result || result === '.' || result === '..') throw new CoreError('invalid_request', '文件夹路径无效')
  return result
}

async function folderPath(client: PoolClient, ownerId: string, folderId: number, projectId: number | null, workspaceId: number | null): Promise<string[]> {
  const result = await client.query<Row>(
    `WITH RECURSIVE chain AS (
       SELECT id,parent_id,name,project_id,workspace_directory_id,0 depth FROM folders
       WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL
       UNION ALL
       SELECT parent.id,parent.parent_id,parent.name,parent.project_id,parent.workspace_directory_id,chain.depth+1
       FROM folders parent JOIN chain ON chain.parent_id=parent.id
       WHERE parent.user_id=$2 AND parent.deleted_at IS NULL AND chain.depth<64
     ) SELECT * FROM chain ORDER BY depth DESC`, [folderId, ownerId],
  )
  if (!result.rows.length || result.rows[0]!.parent_id !== null
    || result.rows.some((row) => Number(row.project_id ?? 0) !== Number(projectId ?? 0)
      || Number(row.workspace_directory_id ?? 0) !== Number(workspaceId ?? 0)))
    throw new CoreError('not_found', '目标文件夹不存在，或不属于目标空间')
  return result.rows.map((row) => safeSegment(String(row.name)))
}

async function targetBase(client: PoolClient, ownerId: string, projectId: number | null, workspaceId: number | null): Promise<string[]> {
  if (projectId !== null && workspaceId !== null) throw new CoreError('invalid_request', '项目与 Workspace 目录不能同时指定')
  if (projectId !== null) {
    const result = await client.query<Row>(
      `SELECT name,COALESCE(to_char(NULLIF(start_date::text,'')::date,'YYYY'),to_char(created_at,'YYYY')) year,
         COALESCE(to_char(NULLIF(start_date::text,'')::date,'MM'),to_char(created_at,'MM')) month
       FROM projects WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`, [projectId, ownerId],
    )
    const row = result.rows[0]
    if (!row) throw new CoreError('not_found', '目标项目不存在')
    return [ownerId, '项目文件', String(row.year), String(row.month), `${safeSegment(String(row.name))} #${projectId}`]
  }
  if (workspaceId !== null) {
    const result = await client.query<Row>(
      'SELECT directory_name FROM workspace_directories WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL', [workspaceId, ownerId],
    )
    const name = result.rows[0]?.directory_name
    if (!name) throw new CoreError('not_found', 'Workspace 不存在')
    return [ownerId, 'workspace', safeSegment(String(name))]
  }
  return [ownerId, '个人文件']
}

async function copyPhysicalFile(root: string, ownerId: string, fromKey: string, toKey: string): Promise<{ path: string; fingerprint: string }> {
  const source = await safePath(root, ownerId, fromKey)
  const destination = await safePath(root, ownerId, toKey)
  const sourceInfo = await lstat(source)
  if (sourceInfo.isSymbolicLink() || !sourceInfo.isFile()) throw new CoreError('not_found', '文件不存在')
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
  const stageDirectory = await mkdtemp(path.join(path.dirname(destination), '.folder-copy-'))
  const staged = path.join(stageDirectory, 'content')
  let applied = false
  try {
    await copyFile(source, staged)
    await rename(staged, destination)
    applied = true
    return { path: destination, fingerprint: createHash('sha256').update(await readFile(destination)).digest('hex') }
  } catch (error) {
    if (applied) await rm(destination, { force: true }).catch(() => undefined)
    throw error
  } finally {
    await rm(stageDirectory, { recursive: true, force: true })
  }
}

interface CopyPlan {
  sourceId: number
  sourceRoot: Row
  sourceTree: FolderCopyTreeNode[]
  folders: FolderCopyPlanNode[]
  targetParent: number | null
  projectId: number | null
  workspaceId: number | null
  base: string[]
  targetPath: string[]
  rootName: string
  occupiedRootNames: Set<string>
}

async function resolveCopyPlan(client: PoolClient, ownerId: string, sourceId: number, input: FolderCopyInput): Promise<CopyPlan> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext('gugu-folder-tree'))", [ownerId])
  const sourceResult = await client.query<Row>(
    'SELECT id,parent_id,name,project_id,workspace_directory_id FROM folders WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL FOR UPDATE',
    [sourceId, ownerId],
  )
  const sourceRoot = sourceResult.rows[0]
  if (!sourceRoot) throw new CoreError('not_found', '文件夹不存在')
  const projectId = input.projectId ?? (sourceRoot.project_id === null ? null : Number(sourceRoot.project_id))
  const workspaceId = input.workspaceDirectoryId ?? (sourceRoot.workspace_directory_id === null ? null : Number(sourceRoot.workspace_directory_id))
  const base = await targetBase(client, ownerId, projectId, workspaceId)
  if (input.parentId !== null) {
    const parent = await client.query<Row>(
      'SELECT project_id,workspace_directory_id FROM folders WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL',
      [input.parentId, ownerId],
    )
    if (!parent.rows[0]) throw new CoreError('not_found', '目标文件夹不存在')
    if (Number(parent.rows[0]!.project_id ?? 0) !== Number(projectId ?? 0)
      || Number(parent.rows[0]!.workspace_directory_id ?? 0) !== Number(workspaceId ?? 0))
      throw new CoreError('invalid_request', '目标文件夹不属于目标空间')
  }
  const treeResult = await client.query<Row>(
    `WITH RECURSIVE tree AS (
       SELECT id,parent_id,name,project_id,workspace_directory_id FROM folders
       WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL
       UNION ALL
       SELECT child.id,child.parent_id,child.name,child.project_id,child.workspace_directory_id
       FROM folders child JOIN tree ON child.parent_id=tree.id
       WHERE child.user_id=$2 AND child.deleted_at IS NULL
     ) SELECT * FROM tree`, [sourceId, ownerId],
  )
  const sourceTree = treeResult.rows.map((row) => ({
    id: Number(row.id), parentId: row.parent_id === null ? null : Number(row.parent_id), name: String(row.name),
  }))
  const folders = planFolderCopyTree(sourceId, sourceTree, input.parentId)
  const targetPath = input.parentId === null ? [] : await folderPath(client, ownerId, input.parentId, projectId, workspaceId)
  const siblings = await client.query<Row>(
    'SELECT name FROM folders WHERE user_id=$1 AND project_id IS NOT DISTINCT FROM $2 AND workspace_directory_id IS NOT DISTINCT FROM $3 AND parent_id IS NOT DISTINCT FROM $4 AND deleted_at IS NULL',
    [ownerId, projectId, workspaceId, input.parentId],
  )
  const occupiedNames = new Set(siblings.rows.map((row) => String(row.name)))
  const rootName = nextFolderCopyName(String(sourceRoot.name), (candidate) => occupiedNames.has(candidate))
  return {
    sourceId, sourceRoot, sourceTree, folders, targetParent: input.parentId,
    projectId, workspaceId, base, targetPath, rootName, occupiedRootNames: occupiedNames,
  }
}

async function insertCopiedFolder(client: PoolClient, values: unknown[]): Promise<Row | null> {
  await client.query('SAVEPOINT folder_copy_insert')
  try {
    const result = await client.query<Row>(
      `INSERT INTO folders(user_id,project_id,workspace_directory_id,parent_id,name,search_romaji,version,deleted_at,created_at,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,1,NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) RETURNING id`, values,
    )
    await client.query('RELEASE SAVEPOINT folder_copy_insert')
    return result.rows[0] ?? null
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT folder_copy_insert')
    await client.query('RELEASE SAVEPOINT folder_copy_insert')
    if (error && typeof error === 'object' && 'code' in error && error.code === '23505'
      && 'constraint' in error && error.constraint === 'uq_folders_active_scope_name') return null
    throw error
  }
}

async function createCopiedFolders(
  client: PoolClient,
  ownerId: string,
  plan: CopyPlan,
  buildSearchRomaji: (name: string) => string,
  planPathMutation: ReturnType<typeof createPostgresFolderPathMirrorPlanner>,
  pathMutations: FolderMutation[],
): Promise<Map<number, number>> {
  const ids = new Map<number, number>()
  for (const item of plan.folders) {
    const parentId = item.parentSourceId === null ? plan.targetParent : ids.get(item.parentSourceId)!
    let name = item.sourceId === plan.sourceId ? plan.rootName : item.name
    let inserted: Row | null = null
    while (!inserted) {
      inserted = await insertCopiedFolder(client, [ownerId, plan.projectId, plan.workspaceId, parentId, name, buildSearchRomaji(name)])
      if (inserted) break
      if (item.sourceId !== plan.sourceId) throw new CoreError('conflict', '同名文件夹已存在')
      plan.occupiedRootNames.add(name)
      name = nextFolderCopyName(String(plan.sourceRoot.name), (candidate) => plan.occupiedRootNames.has(candidate))
      plan.rootName = name
    }
    const folderId = Number(inserted.id)
    ids.set(item.sourceId, folderId)
    const mutation = await planPathMutation(client, ownerId, folderId, 'create', null)
    pathMutations.push(mutation)
    await mutation.apply()
  }
  return ids
}

interface CopyTreeFilesContext {
  ownerId: string
  plan: CopyPlan
  folderIds: Map<number, number>
  storageRoot: string
  fileSyncEnabled: boolean
  copiedNames: Map<number, string>
  sourceById: Map<number, FolderCopyTreeNode>
}

async function uniqueCopiedFilePath(client: PoolClient, context: CopyTreeFilesContext, file: Row): Promise<{ displayName: string; key: string }> {
  const sourceFolderId = Number(file.folder_id)
  const folderChain: number[] = []
  let current: number | null = sourceFolderId
  while (current !== null) {
    folderChain.unshift(current)
    current = context.sourceById.get(current)?.parentId ?? null
  }
  const directory = [
    ...context.plan.base,
    ...context.plan.targetPath,
    ...folderChain.map((id) => safeSegment(context.copiedNames.get(id)!)),
  ].join('/')
  const ext = String(file.ext ?? '').replace(/^\./, '')
  const displayBase = String(file.display_name)
  for (let suffix = 0; suffix < Number.MAX_SAFE_INTEGER; suffix += 1) {
    const displayName = suffix ? `${displayBase}(${suffix})` : displayBase
    const key = `${directory}/${safeSegment(displayName)}${ext ? `.${safeSegment(ext).toLowerCase()}` : ''}`
    await lockFileSyncPath(client, context.ownerId, key)
    const destination = await safePath(context.storageRoot, context.ownerId, key)
    const existsOnDisk = await stat(destination).then(() => true, (error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? false : Promise.reject(error))
    const existsInDatabase = await client.query('SELECT 1 FROM files WHERE user_id=$1 AND storage_key=$2 AND deleted_at IS NULL', [context.ownerId, key])
    if (!existsOnDisk && !existsInDatabase.rowCount) return { displayName, key }
  }
  throw new CoreError('conflict', '无法为文件副本分配名称')
}

async function copyOneTreeFile(client: PoolClient, context: CopyTreeFilesContext, file: Row, copiedFiles: string[]): Promise<void> {
  if (file.storage_backend !== 'local') throw new CoreError('invalid_request', '暂不支持复制非本地存储文件')
  const sourceKey = String(file.storage_key)
  if (!isOwnedFileStorageKey(context.ownerId, sourceKey)) throw new CoreError('not_found', '文件不存在')
  await lockFileSyncPath(client, context.ownerId, sourceKey)
  const destination = await uniqueCopiedFilePath(client, context, file)
  const folderId = context.folderIds.get(Number(file.folder_id))!
  const projectId = context.plan.projectId
  const workspaceId = context.plan.workspaceId
  const inserted = await client.query<Row>(
    `INSERT INTO files(user_id,display_name,ext,storage_key,storage_backend,size,size_bytes,mime_type,space,project_id,folder_id,workspace_directory_id,stage_name,version,created_at,updated_at,deleted_at)
     VALUES($1,$2,$3,$4,'local',$5,$6,$7,$8,$9,$10,$11,$12,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,NULL) RETURNING id`,
    [context.ownerId, destination.displayName, file.ext, destination.key, file.size, file.size_bytes, file.mime_type,
      workspaceId !== null ? 'workspace' : projectId !== null ? 'project' : 'personal', projectId,
      folderId, workspaceId, file.stage_name],
  )
  const fileId = Number(inserted.rows[0]!.id)
  await updateFileStorageQuota(client, context.ownerId, fileId, Number(file.size_bytes ?? 0), 'file_copy', `file-copy:${fileId}`)
  const copied = await copyPhysicalFile(context.storageRoot, context.ownerId, sourceKey, destination.key)
  copiedFiles.push(copied.path)
  await recordCanonicalFileChange(client, {
    ownerId: context.ownerId, storageRoot: context.storageRoot, storageKey: destination.key,
    observedFingerprint: copied.fingerprint, enabled: context.fileSyncEnabled,
  })
}

async function copyTreeFiles(
  client: PoolClient,
  context: Omit<CopyTreeFilesContext, 'copiedNames' | 'sourceById'>,
  copiedFiles: string[],
): Promise<void> {
  const files = await client.query<Row>(
    `SELECT f.* FROM files f WHERE f.user_id=$1 AND f.folder_id=ANY($2::int[]) AND f.deleted_at IS NULL ORDER BY f.id FOR UPDATE`,
    [context.ownerId, context.plan.folders.map((folder) => folder.sourceId)],
  )
  const copyContext: CopyTreeFilesContext = {
    ...context,
    copiedNames: new Map(context.plan.folders.map((folder) => [folder.sourceId, folder.sourceId === context.plan.sourceId ? context.plan.rootName : folder.name])),
    sourceById: new Map(context.plan.sourceTree.map((folder) => [folder.id, folder])),
  }
  for (const file of files.rows) await copyOneTreeFile(client, copyContext, file, copiedFiles)
}

async function folderCopyResult(client: PoolClient, ownerId: string, plan: CopyPlan, folderIds: Map<number, number>) {
  const id = folderIds.get(plan.sourceId)!
  const counts = await client.query<Row>(
    'SELECT count(*)::int AS file_count FROM files WHERE user_id=$1 AND folder_id=$2 AND deleted_at IS NULL', [ownerId, id],
  )
  return {
    id, projectId: plan.projectId, workspaceDirectoryId: plan.workspaceId, parentId: plan.targetParent,
    name: plan.rootName, fileCount: Number(counts.rows[0]?.file_count ?? 0),
    // Python copy_folder 只填写 file_count，FolderResponse 的 folder_count 保持默认 0。
    folderCount: 0, version: 1,
  }
}

export function createPostgresFolderCopyOperations(
  pool: Pool,
  options: {
    storageRoot: string
    fileSyncEnabled: boolean
    buildSearchRomaji(name: string): string
    publishChanged(event: { ownerId: string; origin: string | null; folder: Record<string, unknown> }): Promise<void>
  },
): FolderCopyOperations {
  const planPathMutation = createPostgresFolderPathMirrorPlanner(options.storageRoot, options.buildSearchRomaji)
  return {
    async copy(rawOwnerId: string, sourceId: number, input: FolderCopyInput, metadata: WriteRequestMetadata) {
      const ownerId = /^[0-9a-f-]{36}$/i.test(rawOwnerId) ? rawOwnerId.toLowerCase() : ''
      if (!ownerId || !Number.isSafeInteger(sourceId) || sourceId < 1) throw new CoreError('not_found', '文件夹不存在')
      const pathMutations: FolderMutation[] = []
      const copiedFiles: string[] = []
      const client = await pool.connect()
      let committed = false
      let commitAttempted = false
      try {
        await client.query('BEGIN')
        const plan = await resolveCopyPlan(client, ownerId, sourceId, input)
        const folderIds = await createCopiedFolders(client, ownerId, plan, options.buildSearchRomaji, planPathMutation, pathMutations)
        await copyTreeFiles(client, {
          ownerId, plan, folderIds,
          storageRoot: options.storageRoot,
          fileSyncEnabled: options.fileSyncEnabled,
        }, copiedFiles)
        const result = await folderCopyResult(client, ownerId, plan, folderIds)
        commitAttempted = true
        await client.query('COMMIT')
        committed = true
        client.release()
        await options.publishChanged({ ownerId, origin: metadata.clientId ?? null, folder: result }).catch(() => undefined)
        return result
      } catch (error) {
        if (!commitAttempted) {
          await client.query('ROLLBACK').catch(() => undefined)
          await Promise.all(copiedFiles.map((file) => rm(file, { force: true }).catch(() => undefined)))
          for (const mutation of [...pathMutations].reverse()) await mutation.rollback().catch(() => undefined)
          client.release()
        } else if (!committed) {
          // COMMIT 的应答丢失时数据库结果未知，保留物理副本以免已提交行变成悬空引用。
          client.release(true)
          console.error('文件夹复制提交结果未知，保留文件供核查')
        }
        throw error
      }
    },
  }
}
