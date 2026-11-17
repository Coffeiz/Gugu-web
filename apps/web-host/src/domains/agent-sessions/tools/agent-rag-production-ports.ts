import type { SqlDataRuntime } from '@gugu/core/data'
import type { CanonicalRunPreparationPorts, RunIdentity } from '@gugu/core/agent'
import type { ProviderTransport } from '@gugu/core/providers'
import type { RagQueryEmbeddingSettings } from '@gugu/core/agent'
import type { Pool } from 'pg'
import type { AgentDispatchLease } from '../persistence/agent-run-dispatch-postgres.js'
import type { createAgentToolRegistry } from './agent-tool-registry.js'
import { createAgentToolRegistry as createRegistry } from './agent-tool-registry.js'
import type { AgentToolRegistryOptions } from './agent-tool-registry.js'
import { createWebAgentRagToolPorts } from './agent-rag-tool-ports.js'
import { bindAgentConversationSearchOwner } from './agent-conversations.js'
import { createPostgresWebAgentMemorySnapshotReader, createWebAgentMemoryAuthorizer } from './agent-rag-run-context.js'

/**
 * 为单个已验证 Web lease 组合生产 RAG 查询端口。授权仍以同一 registry 的
 * capabilities 为准，快照来自同一 owner/session/run 的正式 PostgreSQL 会话行。
 */
export function createWebAgentProductionRagToolPorts(options: {
  core: Pick<SqlDataRuntime, 'db' | 'backend'>
  pool: Pick<Pool, 'query'>
  storageRoot: string
  lease: AgentDispatchLease
  registry: Pick<ReturnType<typeof createAgentToolRegistry>, 'capabilities'>
  preparation: Pick<CanonicalRunPreparationPorts, 'configuration'>
  embedding?: {
    resolve(ownerId: string, signal?: AbortSignal): Promise<RagQueryEmbeddingSettings | null>
    createTransport(settings: RagQueryEmbeddingSettings): ProviderTransport
  }
}) {
  const authorizeMemory = createWebAgentMemoryAuthorizer(options.pool, options.lease, options.registry, options.preparation)
  const snapshot = createPostgresWebAgentMemorySnapshotReader(options.pool, options.lease)
  const ports = createWebAgentRagToolPorts({
    core: options.core,
    storageRoot: options.storageRoot,
    authorizeMemory: (identity: RunIdentity, signal, scopes) => authorizeMemory(identity, signal, scopes),
    snapshot,
    ...(options.embedding ? { embedding: options.embedding } : {}),
  })
  return {
    ...ports,
    conversationSearch: bindAgentConversationSearchOwner(ports.conversationSearch, options.lease.identity.ownerId),
  }
}

/**
 * 构建同一实例授权的生产工具注册器。memory scope 校验需要重新读取实际
 * registry grant，因此这里用延迟闭包引用最终注册器，避免 Host 手工拼装时
 * 意外把授权检查接到另一份配置或仅有 search_memory 的替代注册器。
 */
export function createWebAgentProductionToolRegistry(options: Omit<AgentToolRegistryOptions, 'conversationSearch' | 'memorySearch'> & {
  pool: Pick<Pool, 'query'>
  storageRoot: string
  lease: AgentDispatchLease
  preparation: Pick<CanonicalRunPreparationPorts, 'configuration'>
  embedding?: {
    resolve(ownerId: string, signal?: AbortSignal): Promise<RagQueryEmbeddingSettings | null>
    createTransport(settings: RagQueryEmbeddingSettings): ProviderTransport
  }
}) {
  let registry: ReturnType<typeof createAgentToolRegistry> | undefined
  const rag = createWebAgentProductionRagToolPorts({
    core: options.core,
    pool: options.pool,
    storageRoot: options.storageRoot,
    lease: options.lease,
    preparation: options.preparation,
    registry: {
      capabilities(identity) {
        if (!registry) throw new Error('Agent 工具注册器尚未完成装配')
        return registry.capabilities(identity)
      },
    },
    ...(options.embedding ? { embedding: options.embedding } : {}),
  })
  registry = createRegistry({ ...options, ...rag })
  return registry
}
