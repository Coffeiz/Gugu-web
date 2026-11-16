import { lstat, mkdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import { checkedPath } from '../../projects/persistence/project-trash-storage.js'
import type { ProjectUndoJournalStorage } from './project-journal.js'
import { moveProjectFileNoReplace } from '../../projects/persistence/project-path-move.js'

/** 恢复常规文件；目录恢复在获得不覆盖原子移动能力前保留日志。 */
export function createLocalProjectUndoJournalStorage(storageRoot: string): ProjectUndoJournalStorage {
  return {
    async exists(ownerId, key) {
      try {
        const root = await realpath(storageRoot)
        const target = await checkedPath(root, ownerId, key, false)
        await lstat(target)
        return true
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT' || code === 'ENOTDIR') return false
        throw error
      }
    },
    async move(ownerId, from, to) {
      const root = await realpath(storageRoot)
      const source = await checkedPath(root, ownerId, from, false)
      const target = await checkedPath(root, ownerId, to)
      await mkdir(path.dirname(target), { recursive: true })
      await moveProjectFileNoReplace(source, target, async () => {
        await checkedPath(root, ownerId, from, false)
        await checkedPath(root, ownerId, to)
      })
    },
  }
}
