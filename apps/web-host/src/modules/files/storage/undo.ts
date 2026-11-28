import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { isPathWithin } from '../../../shared/path-safety.js'
import type { FileUndoStorage } from '../../undo/service.js'
import { removeLocalTree } from '@gugu/fs/node'
import { normalizeFileOwnerId } from '../store.js'

async function safePath(rootPath: string, key: string): Promise<string> {
  const parts = key.split('/')
  if (parts.length < 2 || parts.some(part => !part || part === '.' || part === '..' || part.includes('\\') || part.includes('\0')))
    throw new Error('文件撤销路径无效')
  const root = await realpath(rootPath)
  let cursor = root
  for (const part of parts) {
    cursor = path.resolve(cursor, part)
    if (!isPathWithin(root, cursor)) throw new Error('文件撤销路径无效')
    try { if ((await lstat(cursor)).isSymbolicLink()) throw new Error('文件撤销路径无效') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  return cursor
}

export function createLocalFileUndoStorage(storageRoot: string): FileUndoStorage {
  return {
    async read(key) {
      const target = await safePath(storageRoot, key)
      try { return new Uint8Array(await readFile(target)) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
    },
    async move(fromKey, toKey) {
      const source = await safePath(storageRoot, fromKey)
      const target = await safePath(storageRoot, toKey)
      const sourceBytes = await readFile(source).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      })
      const targetBytes = await readFile(target).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      })
      if (sourceBytes === null) {
        if (targetBytes !== null) return
        throw new Error('文件撤销正文不存在，无法迁移')
      }
      if (targetBytes !== null) {
        if (!sourceBytes.equals(targetBytes)) throw new Error('文件撤销正文迁移目标冲突')
        await rm(source)
        return
      }
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
      await rename(source, target)
    },
    async replace(key, bytes) {
      const target = await safePath(storageRoot, key)
      const previous = await readFile(target).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('文件正文不存在，无法撤销')
        throw error
      })
      const directory = path.dirname(target)
      const stageDirectory = await mkdtemp(path.join(directory, '.undo-stage-'))
      const staged = path.join(stageDirectory, 'content')
      const backup = path.join(stageDirectory, 'before')
      let moved = false
      try {
        await writeFile(staged, bytes, { flag: 'wx', mode: 0o600 })
        await rename(target, backup)
        moved = true
        await rename(staged, target)
      } catch (error) {
        if (moved) await rename(backup, target).catch(() => undefined)
        await rm(stageDirectory, { recursive: true, force: true }).catch(() => undefined)
        throw error
      }
      let active = true
      return {
        async rollback() {
          if (!active) return
          await rm(target, { force: true })
          await rename(backup, target)
          active = false
          await rm(stageDirectory, { recursive: true, force: true })
        },
        async finalize() {
          if (!active) return
          active = false
          await rm(stageDirectory, { recursive: true, force: true })
        },
      }
    },
  }
}

/** 只删除一个经过 owner 和 Undo 操作路径验证的正文 artifact 目录。 */
export function createLocalUndoRetentionStorage(storageRoot: string): {
  removePrefix(ownerId: string, prefix: string): Promise<number>
} {
  return {
    async removePrefix(rawOwnerId, prefix) {
      const ownerId = normalizeFileOwnerId(rawOwnerId)
      const parts = prefix.split('/')
      if (parts.length !== 3 || parts[0] !== ownerId || parts[1] !== '.undo' || !/^op-[0-9a-f]{32}$/.test(parts[2]!))
        throw new Error('文件撤销清理路径无效')
      return removeLocalTree(storageRoot, prefix)
    },
  }
}
