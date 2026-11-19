import { removeLocalTree } from '@gugu/fs/node'
import { normalizeFileOwnerId } from './file-owner.js'

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
