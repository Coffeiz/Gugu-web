import { lstat, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { isPathWithin } from '../../shared/path-safety.js'
import type { FileUndoStorage } from '../undo/persistence/core-operations.js'

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
