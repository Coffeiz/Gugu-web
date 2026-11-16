import { safeKey, trashKey, withConflictName, projectOriginalStorageKey, type OriginalProjectFileKey } from '@gugu/core/project-file-paths'
export { projectOriginalStorageKey, projectFileTrashKey, createProjectTrashOriginalStorageKeyResolver } from '@gugu/core/project-file-paths'
export type { OriginalProjectFileKey, ProjectTrashPathMetadataReader } from '@gugu/core/project-file-paths'
import { chmod, chown, lstat, mkdir, realpath, rename, stat } from 'node:fs/promises'
import path from 'node:path'
import type {
  ProjectTrashFile,
  ProjectTrashFolder,
  ProjectTrashStorage,
} from '../application/project-trash.js'
import { ProjectTrashStoragePathError } from '../application/project-trash.js'
import { isPathWithin } from '../../../adapters/path-safety.js'

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

/** LocalStorageBackend 语义：物理 rename、(n) 冲突名、越界/symlink fail-closed。 */
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
    await rename(oldPath, newPath)
    try {
      await checkedPath(root, ownerId, newKey, false)
      await verifyRealFileWithin(root, newPath)
    } catch (error) {
      try {
        await rename(newPath, oldPath)
      } catch {
        throw new ProjectTrashStoragePathError('文件移动后无法恢复原路径')
      }
      throw error
    }
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
