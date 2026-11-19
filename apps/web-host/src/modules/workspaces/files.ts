import { CoreError } from '@gugu/core'
import { createLocalFileTree, UnsafeLocalPathError } from '@gugu/fs/node'
import { lookup } from 'mime-types'
import type { Pool } from 'pg'
import { normalizeOwnerId } from '../../shared/owner-context.js'
import { readPostgresProjectPathMirrorKey } from '../files/folders/paths.js'
import { createDiskTrash } from '../files/trash/disk.js'
import { personalFileStorageKey, workspaceDirectoryStorageKey } from './roots.js'

export type FileDirectory = number | 'personal' | { projectId: number }

export async function resolveFileDirectoryRoot(pool: Pick<Pool, 'query'>, owner: string, directory: FileDirectory) {
  if (directory === 'personal') return personalFileStorageKey(owner)
  if (typeof directory === 'object')
    return readPostgresProjectPathMirrorKey(pool, owner, directory.projectId)
  const { rows: [row] } = await pool.query<{ directory_name: string }>(
    `SELECT directory_name FROM workspace_directories
     WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`, [directory, owner],
  )
  if (!row) throw new CoreError('not_found', '工作区不存在')
  return workspaceDirectoryStorageKey(owner, row.directory_name)
}

export function createWorkspaceFileReads(pool: Pick<Pool, 'query'>, storageRoot: string) {
  const rootKey = (owner: string, directory: FileDirectory) => resolveFileDirectoryRoot(pool, owner, directory)

  async function tree(ownerId: string, directory: FileDirectory) {
    return createLocalFileTree(storageRoot, await rootKey(normalizeOwnerId(ownerId), directory))
  }

  async function read<T>(operation: () => Promise<T | null>): Promise<T> {
    try {
      const result = await operation()
      if (result !== null) return result
    } catch (error) {
      if (!(error instanceof UnsafeLocalPathError)) throw error
    }
    throw new CoreError('not_found', '文件或目录不存在')
  }

  async function write(operation: () => Promise<unknown>) {
    try {
      if (await operation() !== false) return { ok: true }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EEXIST' || code === 'ENOTEMPTY')
        throw new CoreError('conflict', '目标位置已存在同名文件或文件夹')
      if (code === 'EINVAL' || code === 'EXDEV')
        throw new CoreError('invalid_request', '不能移动到此位置')
      if (!(error instanceof UnsafeLocalPathError) && code !== 'ENOENT') throw error
    }
    throw new CoreError('not_found', '文件或目录不存在')
  }

  const trash = createDiskTrash(storageRoot, rootKey)

  async function checkLegacy(owner: string, root: string, paths: string[]) {
    const keys = paths.map(path => `${root}/${path}`)
    const { rows } = await pool.query(
      `SELECT 1 FROM files WHERE user_id=$1 AND deleted_at IS NULL AND storage_backend='local'
       AND EXISTS (SELECT 1 FROM unnest($2::text[]) AS candidate(key)
         WHERE files.storage_key=candidate.key OR starts_with(files.storage_key,candidate.key || '/')) LIMIT 1`,
      [owner, keys],
    )
    if (rows.length) throw new CoreError('conflict', '此路径关联旧版文件记录，暂不能通过路径修改')
  }

  return {
    async list(ownerId: string, directory: FileDirectory, relativePath: string) {
      const fs = await tree(ownerId, directory)
      const entries = await read(async () => {
        const result = await fs.list(relativePath)
        return result ?? (typeof directory !== 'number' && relativePath === '' ? [] : null)
      })
      return entries.map(entry => ({
        ...entry,
        mimeType: entry.kind === 'file' ? lookup(entry.name) || 'application/octet-stream' : null,
      }))
    },
    async open(ownerId: string, directory: FileDirectory, relativePath: string) {
      const fs = await tree(ownerId, directory)
      const opened = await read(() => fs.open(relativePath))
      const fileName = relativePath.split('/').at(-1)!
      const mimeType = lookup(fileName) || 'application/octet-stream'
      return { ...opened, fileName, mimeType, file: null }
    },
    async mkdir(ownerId: string, directory: FileDirectory, path: string) {
      const fs = await tree(ownerId, directory)
      return write(async () => {
        if (typeof directory !== 'number' && !await fs.ensureRoot()) return false
        return fs.mkdir(path)
      })
    },
    async upload(ownerId: string, directory: FileDirectory, path: string, content: AsyncIterable<Uint8Array>, signal: AbortSignal) {
      const fs = await tree(ownerId, directory)
      return write(async () => {
        if (typeof directory !== 'number' && !await fs.ensureRoot()) return false
        await fs.upload(path, content, signal)
      })
    },
    async move(ownerId: string, directory: FileDirectory, path: string, destination: string) {
      const owner = normalizeOwnerId(ownerId)
      const root = await rootKey(owner, directory)
      if (typeof directory !== 'number') await checkLegacy(owner, root, [path, destination])
      return write(() => createLocalFileTree(storageRoot, root).move(path, destination))
    },
    async copy(ownerId: string, directory: FileDirectory, path: string, destination: string, signal: AbortSignal) {
      const fs = await tree(ownerId, directory)
      return write(() => fs.copy(path, destination, signal))
    },
    async moveToTrash(ownerId: string, directory: FileDirectory, path: string, options?: { expectedRoot: string }) {
      const owner = normalizeOwnerId(ownerId)
      const root = await rootKey(owner, directory)
      if (options && options.expectedRoot !== root) throw new CoreError('conflict', '文件目录授权已变化')
      if (typeof directory !== 'number') await checkLegacy(owner, root, [path])
      return write(() => trash.store(owner, directory, path, createLocalFileTree(storageRoot, root).storageKey(path), new Date().toISOString()))
    },
    listDiskTrash: (ownerId: string) => trash.list(normalizeOwnerId(ownerId)),
    restoreDiskTrash: (ownerId: string, id: string) => write(() => trash.restore(normalizeOwnerId(ownerId), id)),
    purgeDiskTrash: (ownerId: string, id: string) => write(() => trash.purge(normalizeOwnerId(ownerId), id)),
  }
}
