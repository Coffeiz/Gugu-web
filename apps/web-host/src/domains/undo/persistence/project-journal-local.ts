import { link, lstat, mkdir, realpath, unlink } from 'node:fs/promises'
import path from 'node:path'
import { checkedPath } from '../../projects/persistence/project-trash-storage.js'
import type { ProjectUndoJournalStorage } from './project-journal.js'

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
      if (!(await lstat(source)).isFile()) throw new Error('项目撤销目录恢复需要原子不覆盖移动能力')
      await mkdir(path.dirname(target), { recursive: true })
      await checkedPath(root, ownerId, to)
      // link 以排他方式创建目标，不能覆盖已有文件；中途失败保留日志。
      await link(source, target)
      await unlink(source)
    },
  }
}
