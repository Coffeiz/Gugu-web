import { CoreError, dataContext } from '../../contracts/index.js'

export interface AgentSessionDeleteRepository {
  /** 原子删除会话相关数据库记录；仅返回提交后可尝试回收的附件 key。 */
  delete(ownerId: string, sessionId: number): Promise<{ storageKeys: string[] } | null>
}

export interface AgentSessionDeletePorts {
  removeIfUnreferenced(ownerId: string, storageKey: string): Promise<boolean>
  clearReflection(ownerId: string, sessionId: number): Promise<void>
}

/** 只在删除事务成功提交后调用；保留旧Web/Python清理语义。 */
export async function cleanupDeletedAgentSession(ownerId: string, sessionId: number, storageKeys: readonly string[], ports: AgentSessionDeletePorts): Promise<void> {
  for (const key of new Set(storageKeys)) {
    try { await ports.removeIfUnreferenced(ownerId, key) } catch { /* 已提交；由安全网重试。 */ }
  }
  try { await ports.clearReflection(ownerId, sessionId) } catch { /* 已提交；不回滚删除。 */ }
}

/** Python 的两阶段清理：数据库删除成功后，逐个 best-effort 回收附件与 Redis 反思缓冲。 */
export function createAgentSessionDeleter(repository: AgentSessionDeleteRepository, ports: AgentSessionDeletePorts) {
  return async (rawOwnerId: string, sessionId: number): Promise<boolean> => {
    const ownerId = dataContext(rawOwnerId).ownerId
    if (!Number.isSafeInteger(sessionId) || sessionId < 1) throw new CoreError('invalid_request', '会话 ID 无效')
    const deleted = await repository.delete(ownerId, sessionId)
    if (!deleted) return false
    await cleanupDeletedAgentSession(ownerId, sessionId, deleted.storageKeys, ports)
    return true
  }
}
