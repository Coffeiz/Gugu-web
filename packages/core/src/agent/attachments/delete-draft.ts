import { CoreError } from '../../contracts/index.js'

export interface ChatAttachmentDraftDeletePorts {
  /** 原子删除当前 owner 的 draft 行；attached 返回 already-used，缺少/越权行返回 null。 */
  removeDraft(ownerId: string, attachmentId: string): Promise<{ storageKey: string } | 'already-used' | null>
  /** 删除已无数据库引用的存储对象；平台适配器负责并发锁与物理安全。 */
  removeUnreferenced(ownerId: string, storageKey: string): Promise<boolean>
}

/** Python delete_draft_attachment 用例：先提交草稿行删除，再清理未引用字节。 */
export function createChatAttachmentDraftDeleter(ports: ChatAttachmentDraftDeletePorts) {
  return async (ownerId: string, attachmentId: string): Promise<{ deleted: true }> => {
    const result = await ports.removeDraft(ownerId, attachmentId)
    if (result === null) throw new CoreError('not_found', '附件不存在')
    if (result === 'already-used') throw new CoreError('conflict', '附件已被使用，无法删除')
    await ports.removeUnreferenced(ownerId, result.storageKey)
    return { deleted: true }
  }
}
