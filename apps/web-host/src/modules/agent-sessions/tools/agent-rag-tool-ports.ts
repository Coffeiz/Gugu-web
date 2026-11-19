import type { SqlDataRuntime } from '@gugu/core/data'
import type { RunIdentity } from '@gugu/core/agent'
import type { AuthorizedMemoryScope, MemorySearchSnapshot, RagQueryEmbeddingSettings } from '@gugu/core/agent/rag'
import type { ProviderTransport } from '@gugu/core/providers'
import type { ConversationSearchPort, MemorySearchPort } from '@gugu/core/tools'
import { createWebOwnerMemorySearchPort } from './agent-memory-search.js'
import { createCoreAgentConversationSearchPort } from './agent-conversations.js'

/**
 * Web Agent Run 共用的 RAG 工具端口。
 * owner/session、持久存储根、scope 快照和凭据解析必须由可信 Host 注入；
 * Web 请求没有 IM 群身份，memory scope 固定收敛为 owner，工具参数不能决定授权范围。
 */
export interface WebAgentRagToolPortOptions {
  core: Pick<SqlDataRuntime, 'db' | 'backend'>
  storageRoot: string
  authorizeMemory(identity: RunIdentity, signal: AbortSignal, scopes?: readonly AuthorizedMemoryScope[]): Promise<boolean>
  snapshot(identity: RunIdentity, signal: AbortSignal): Promise<MemorySearchSnapshot>
  /** 缺少 BYOK 凭据时保留 Python 的词法检索路径。 */
  embedding?: {
    resolve(ownerId: string, signal?: AbortSignal): Promise<RagQueryEmbeddingSettings | null>
    createTransport(settings: RagQueryEmbeddingSettings): ProviderTransport
  }
}

export interface WebAgentRagToolPorts {
  conversationSearch: ConversationSearchPort
  memorySearch: MemorySearchPort
}

/** 同时装配会话事实表搜索和 Python Web owner-only memory 搜索，供可信 Web Run 的 registry 使用。 */
export function createWebAgentRagToolPorts(options: WebAgentRagToolPortOptions): WebAgentRagToolPorts {
  if (!options.storageRoot.trim()) throw new TypeError('Web Agent RAG 存储根未装配')
  if (typeof options.authorizeMemory !== 'function' || typeof options.snapshot !== 'function')
    throw new TypeError('Web Agent RAG 授权或快照端口未装配')

  return {
    conversationSearch: createCoreAgentConversationSearchPort(options.core),
    memorySearch: createWebOwnerMemorySearchPort(options.core, {
      storageRoot: options.storageRoot,
      authorize: options.authorizeMemory,
      snapshot: options.snapshot,
      ...(options.embedding ? { embedding: options.embedding } : {}),
    }),
  }
}

