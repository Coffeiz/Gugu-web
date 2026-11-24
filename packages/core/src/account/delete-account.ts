import { CoreError, dataContext } from '../contracts/index.js'

export interface AccountDeletionPorts {
  accountExists(ownerId: string): Promise<boolean>
  removeThumbnails(ownerId: string): Promise<void>
  removeStoragePrefixes(ownerId: string): Promise<number>
  clearEphemeralData(ownerId: string): Promise<void>
  deleteDatabaseUser(ownerId: string): Promise<boolean>
  publishAuthStateChanged(ownerId: string): Promise<unknown>
  onStorageCleanupFailure(error: unknown, ownerId: string): void
}

/** Shared account deletion ordering and failure semantics for self-service and admin routes. */
export function createAccountDeleter(ports: AccountDeletionPorts) {
  return async (rawOwnerId: string): Promise<number> => {
    const ownerId = dataContext(rawOwnerId).ownerId
    if (!await ports.accountExists(ownerId)) throw new CoreError('not_found', '用户不存在')

    await ports.removeThumbnails(ownerId)

    let storageObjectsRemoved: number
    try {
      storageObjectsRemoved = await ports.removeStoragePrefixes(ownerId)
    } catch (error) {
      ports.onStorageCleanupFailure(error, ownerId)
      storageObjectsRemoved = -1
    }

    try {
      await ports.clearEphemeralData(ownerId)
    } catch {
      // Python 兼容语义：Redis / 暂存清理失败不阻止数据库级联删除。
    }

    if (!await ports.deleteDatabaseUser(ownerId))
      throw new CoreError('not_found', '用户不存在')

    await ports.publishAuthStateChanged(ownerId)
    return storageObjectsRemoved
  }
}
