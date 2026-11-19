import { safeKey, trashKey, withConflictName, projectOriginalStorageKey, type OriginalProjectFileKey, type ProjectTrashPathMetadataReader } from '@gugu/core/project-file-paths'
import { chmod, chown, lstat, mkdir, realpath, stat, link, unlink } from 'node:fs/promises'
import path from 'node:path'
import { type ProjectTrashFile, type ProjectTrashFolder, type ProjectTrashStorage, ProjectTrashStoragePathError } from '@gugu/core/project-trash'
import { isPathWithin } from '../../../shared/path-safety.js'
import type { Pool } from 'pg'

export { projectOriginalStorageKey, projectFileTrashKey, createProjectTrashOriginalStorageKeyResolver } from '@gugu/core/project-file-paths'

export type { OriginalProjectFileKey, ProjectTrashPathMetadataReader } from '@gugu/core/project-file-paths'

export async function checkedPath(root: string, ownerId: string, key: string, allowMissing = true): Promise<string> {
  const segments = safeKey(ownerId, key)
  const target = path.resolve(root, ...segments)
  if (!isPathWithin(root, target)) throw new ProjectTrashStoragePathError('文件存储路径超出配置根目录')
  let current = root
  for (const segment of segments) {
    current = path.join(current, segment)
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink()) throw new ProjectTrashStoragePathError('文件存储路径不能经过符号链接')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (allowMissing && (code === 'ENOENT' || code === 'ENOTDIR')) break
      throw error
    }
  }
  return target
}

async function verifyRealFileWithin(root: string, target: string): Promise<void> {
  const resolved = await realpath(target)
  if (!isPathWithin(root, resolved)) throw new ProjectTrashStoragePathError('文件存储路径超出配置根目录')
}

async function inheritGroupAccess(filePath: string): Promise<void> {
  try {
    const parent = await stat(path.dirname(filePath))
    const current = await lstat(filePath)
    await chown(filePath, current.uid, parent.gid)
    await chmod(filePath, (current.mode & 0o7777) | 0o060)
  } catch { /* 与 Python 存储一致：文件移动成功优先，权限修复为 best-effort */ }
}

/** 保留 Local 冲突命名与缺文件语义，物理移动和补偿必须原子拒绝覆盖。 */
export function createLocalProjectTrashStorage(
  storageRoot: string,
  originalKeyFor: OriginalProjectFileKey = projectOriginalStorageKey,
): ProjectTrashStorage {
  const absoluteRoot = path.resolve(storageRoot)

  async function rootPath(): Promise<string> {
    const root = await realpath(absoluteRoot)
    if (!isPathWithin(root, root)) throw new ProjectTrashStoragePathError('存储根目录无效')
    return root
  }

  async function findAvailableKey(root: string, ownerId: string, baseKey: string, displayName: string, ext: string) {
    let candidate = baseKey
    let name = displayName
    for (let index = 1; ; index += 1) {
      const absolute = await checkedPath(root, ownerId, candidate)
      try {
        await lstat(absolute)
        const next = withConflictName(baseKey, displayName, ext, index)
        candidate = next.key
        name = next.name
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT' || code === 'ENOTDIR') return { key: candidate, name }
        throw error
      }
    }
  }

  async function move(oldKey: string, newKey: string, ownerId: string, beforeMove?: (from: string, to: string) => Promise<void>): Promise<() => Promise<void>> {
    const root = await rootPath()
    const oldPath = await checkedPath(root, ownerId, oldKey, false)
    const newPath = await checkedPath(root, ownerId, newKey)
    const newParent = path.dirname(newPath)
    await mkdir(newParent, { recursive: true })
    await checkedPath(root, ownerId, newKey)
    if (beforeMove) await beforeMove(oldKey, newKey)
    await moveProjectFileNoReplace(oldPath, newPath, async () => {
      await checkedPath(root, ownerId, oldKey, false)
      await checkedPath(root, ownerId, newKey)
      await verifyRealFileWithin(root, oldPath)
      await verifyRealFileWithin(root, newParent)
    })
    await inheritGroupAccess(newPath)
    let rolledBack = false
    return async () => {
      if (rolledBack) return
      await move(newKey, oldKey, ownerId)
      rolledBack = true
    }
  }

  return {
    async moveToTrash(ownerId, file, beforeMove) {
      const root = await rootPath()
      const baseKey = trashKey(ownerId, file)
      if (file.storage_key === baseKey) return { storageKey: file.storage_key }
      const available = await findAvailableKey(root, ownerId, baseKey, file.display_name, file.ext)
      let journaled = false
      try {
        const rollback = await move(file.storage_key, available.key, ownerId, beforeMove && (async (from, to) => { await beforeMove(from, to); journaled = true }))
        return { storageKey: available.key, rollback }
      } catch (error) {
        const missing = ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')
        if ((beforeMove && (journaled || !missing)) || error instanceof ProjectTrashStoragePathError) throw error
        // Python 捕获 storage.rename_file 异常，继续提交墓碑并保留原 key。
        return { storageKey: file.storage_key }
      }
    },
    async restoreFromTrash(ownerId, file, project, folders, beforeMove) {
      const baseKey = await originalKeyFor(ownerId, file, project, folders)
      safeKey(ownerId, baseKey)
      let available: { key: string; name: string }
      let root: string | null
      try {
        root = await rootPath()
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        root = null
      }
      if (!root) {
        available = { key: baseKey, name: file.display_name }
      } else if (file.storage_key === baseKey) {
        available = { key: baseKey, name: file.display_name }
      } else {
        available = await findAvailableKey(root, ownerId, baseKey, file.display_name, file.ext)
      }
      let rollback: (() => Promise<void>) | undefined
      let journaled = false
      try {
        if (file.storage_key !== available.key) rollback = await move(file.storage_key, available.key, ownerId, beforeMove && (async (from, to) => { await beforeMove(from, to); journaled = true }))
      } catch (error) {
        const missing = ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')
        if ((beforeMove && (journaled || !missing)) || error instanceof ProjectTrashStoragePathError) throw error
        /* 与 restore_file_storage 一致：物理源缺失时也复原预期 DB 路径 */
      }
      return { storageKey: available.key, displayName: available.name, rollback }
    },
  }
}

type QueryPool = Pick<Pool, 'query'>

type Row = Record<string, unknown>

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const parsed = value instanceof Date ? value : new Date(String(value))
  if (Number.isNaN(parsed.getTime())) throw new Error('项目文件路径时间无效')
  return parsed.toISOString()
}

export function createPostgresProjectTrashPathMetadataReader(pool: QueryPool): ProjectTrashPathMetadataReader {
  return {
    async getOwnedProject(ownerId, projectId) {
      const result = await pool.query<Row>(
        `SELECT name, start_date::text AS start_date, created_at
         FROM projects WHERE id = $1 AND user_id = $2 LIMIT 1`,
        [projectId, ownerId],
      )
      const row = result.rows[0]
      return row ? {
        name: String(row.name),
        startDate: row.start_date == null ? null : String(row.start_date),
        createdAt: iso(row.created_at) ?? '',
      } : null
    },

    async getOwnedWorkspaceDirectory(ownerId, directoryId) {
      const result = await pool.query<Row>(
        `SELECT directory_name, deleted_at
         FROM workspace_directories WHERE id = $1 AND user_id = $2 LIMIT 1`,
        [directoryId, ownerId],
      )
      const row = result.rows[0]
      return row ? {
        directoryName: String(row.directory_name),
        deletedAt: iso(row.deleted_at),
      } : null
    },

    async getOwnedMindMap(ownerId, mindMapId) {
      const result = await pool.query<Row>(
        `SELECT title FROM mind_maps WHERE id = $1 AND user_id = $2 LIMIT 1`,
        [mindMapId, ownerId],
      )
      return result.rows[0] ? { title: String(result.rows[0].title) } : null
    },

    async resolveOwnedFolderPath(ownerId, folderId, projectId, workspaceDirectoryId) {
      const result = await pool.query<Row>(
        `WITH RECURSIVE chain AS (
           SELECT id, parent_id, name, ARRAY[id]::integer[] AS visited, 0 AS depth
           FROM folders
           WHERE id = $1 AND user_id = $2
             AND project_id IS NOT DISTINCT FROM $3::integer
             AND workspace_directory_id IS NOT DISTINCT FROM $4::integer
           UNION ALL
           SELECT parent.id, parent.parent_id, parent.name,
                  chain.visited || parent.id, chain.depth + 1
           FROM folders AS parent
           JOIN chain ON parent.id = chain.parent_id
           WHERE parent.user_id = $2
             AND parent.project_id IS NOT DISTINCT FROM $3::integer
             AND parent.workspace_directory_id IS NOT DISTINCT FROM $4::integer
             AND NOT parent.id = ANY(chain.visited)
         )
         SELECT name, parent_id
         FROM chain
         ORDER BY depth DESC`,
        [folderId, ownerId, projectId, workspaceDirectoryId],
      )
      const rows = result.rows
      if (!rows.length || rows[0]?.parent_id != null) return null
      return rows.map((row) => String(row.name)).join('/')
    },
  }
}

/** 安全移动失败必须穿过旧 Python 兼容 catch，使业务事务回滚。 */
export class ProjectPathMoveError extends ProjectTrashStoragePathError {
  readonly statusCode: number
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'ProjectPathMoveError'
    this.statusCode = code === 'EEXIST' ? 409 : 503
  }
}

/**
 * link 原子占用不存在的目标，成功后才移除源；绝不回退到可覆盖的 rename。
 * Node 没有目录 rename-noreplace 能力，目录/特殊节点明确拒绝。
 * 两步之间失败或崩溃可能留下两处硬链接，保留数据供 journal 核对，不擅自清理。
 */
export async function moveProjectFileNoReplace(
  source: string, target: string, verifyPaths: () => Promise<void>,
): Promise<void> {
  await verifyPaths()
  const sourceInfo = await lstat(source)
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink())
    throw new ProjectPathMoveError('ENOTSUP', '当前平台无法安全移动目录或特殊节点，已保留源路径')
  try {
    await link(source, target)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'EIO'
    // 未建立目标时，缺失源仍沿用 Python 的普通缺文件语义。
    if (code === 'ENOENT' || code === 'ENOTDIR') throw error
    throw new ProjectPathMoveError(code, code === 'EEXIST'
      ? '移动目标已存在，已保留源和目标'
      : '无法原子占用移动目标，已保留源路径')
  }
  try {
    await verifyPaths()
    const [current, linked] = await Promise.all([lstat(source), lstat(target)])
    if (!current.isFile() || !linked.isFile()
      || current.dev !== sourceInfo.dev || current.ino !== sourceInfo.ino
      || linked.dev !== sourceInfo.dev || linked.ino !== sourceInfo.ino)
      throw new ProjectPathMoveError('ESTALE', '移动路径已变化，保留现有文件供恢复核对')
    await unlink(source)
  } catch (error) {
    if (error instanceof ProjectPathMoveError) throw error
    throw new ProjectPathMoveError((error as NodeJS.ErrnoException).code ?? 'EIO', '移动尚未完成，保留现有文件供恢复核对')
  }
}
