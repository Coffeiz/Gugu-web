export interface ChatAttachmentDraftClearPorts {
  /** 在一次事务中删除当前 owner 的 draft 行并返回可能重复的 storage_key。 */
  deleteDraftRows(ownerId: string): Promise<string[]>
  /** 返回是否无其他附件引用该 key；数据库锁和物理删除由 Host 适配器负责。 */
  removeUnreferenced(ownerId: string, storageKey: string): Promise<boolean>
  /** 清理旧 Redis 草稿，并对其中的存储 key 使用相同引用清理端口。 */
  clearLegacy(ownerId: string, removeStorage: (storageKey: string) => Promise<boolean>): Promise<number>
}

/** Python clear_staged 顺序：先提交 DB 草稿删除，再清理字节和旧 Redis 元数据。 */
export function createChatAttachmentDraftClearer(ports: ChatAttachmentDraftClearPorts) {
  return async (ownerId: string): Promise<{ deleted: number }> => {
    const storageKeys = new Set(await ports.deleteDraftRows(ownerId))
    let deleted = 0
    for (const storageKey of storageKeys) {
      if (await ports.removeUnreferenced(ownerId, storageKey)) deleted += 1
    }
    deleted += await ports.clearLegacy(ownerId, storageKey => ports.removeUnreferenced(ownerId, storageKey))
    return { deleted }
  }
}
