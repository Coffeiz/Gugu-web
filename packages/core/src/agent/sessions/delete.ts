import { CoreError, dataContext } from '../../contracts/index.js'

export interface AgentSessionDeleteRepository {
  /** 原子删除会话相关数据库记录；仅返回提交后可尝试回收的附件 key。 */
  delete(ownerId: string, sessionId: number): Promise<{ storageKeys: string[] } | null>
}

export interface AgentSessionDeletePorts {
  removeIfUnreferenced(ownerId: string, storageKey: string): Promise<boolean>
  clearReflection(ownerId: string, sessionId: number): Promise<void>
}

/** Python 的两阶段清理：数据库删除成功后，逐个 best-effort 回收附件与 Redis 反思缓冲。 */
export function createAgentSessionDeleter(repository: AgentSessionDeleteRepository, ports: AgentSessionDeletePorts) {
  return async (rawOwnerId: string, sessionId: number): Promise<boolean> => {
    const ownerId = dataContext(rawOwnerId).ownerId
    if (!Number.isSafeInteger(sessionId) || sessionId < 1) throw new CoreError('invalid_request', '会话 ID 无效')
    const deleted = await repository.delete(ownerId, sessionId)
    if (!deleted) return false
    for (const key of new Set(deleted.storageKeys)) {
      try { await ports.removeIfUnreferenced(ownerId, key) } catch { /* 数据库已提交；物理清理由后续安全网重试。 */ }
    }
    try { await ports.clearReflection(ownerId, sessionId) } catch { /* Redis 清理失败不回滚已提交的会话删除。 */ }
    return true
  }
}
