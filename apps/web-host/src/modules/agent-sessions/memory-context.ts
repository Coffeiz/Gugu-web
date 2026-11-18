import { loadAgentMemoryContext } from '@gugu/core/agent/memory/context'
import type { AgentMemoryVectorSearchPort } from '@gugu/core/agent/memory/context'
import type { ContextDataPorts, HistoryIdentity } from '@gugu/core/agent'
import { createLocalAgentMemoryRagStore } from '../../domains/agent-sessions/tools/agent-rag-memory-store.js'

export type AgentMemoryVectorSearchFactory = (ownerId: string) => AgentMemoryVectorSearchPort

/** 将可信会话 owner 绑定到 Core 记忆快照用例；文件根目录只来自 Host 配置。 */
export function createAgentMemoryContextLoader(storageRoot: string, now: () => number = Date.now,
  vectorSearch?: AgentMemoryVectorSearchFactory): ContextDataPorts['loadMemory'] {
  const storage = createLocalAgentMemoryRagStore(storageRoot)
  return async (identity: HistoryIdentity, signal?: AbortSignal, query = '') => {
    signal?.throwIfAborted()
    const context = await loadAgentMemoryContext({ ownerId: identity.ownerId, query, now: now(), storage, signal,
      ...(vectorSearch ? { vectorSearch: vectorSearch(identity.ownerId) } : {}) })
    signal?.throwIfAborted()
    return context
  }
}
