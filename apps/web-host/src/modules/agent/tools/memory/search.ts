import { configureRagJieba, createMemorySearch, createSqlMemoryScopeStateReader, type AuthorizedMemoryScope, type MemorySearchScope, type MemorySearchSnapshot } from '@gugu/core/agent/rag'
import type { AgentObservationPort, RunIdentity } from '@gugu/core/agent'
import type { SqlDataRuntime } from '@gugu/core/data'
import type { ProviderTransport } from '@gugu/core/providers'
import type { RagQueryEmbeddingSettings } from '@gugu/core/agent/rag'
import type { MemorySearchPort } from '@gugu/core/tools'
import type { Pool } from 'pg'
import { createLocalAgentMemoryRagStore } from '../../rag/memory.js'
import { getAgentRagJieba } from '../../rag/jieba.js'
import { createOwnerAgentRagVectorResolver } from '../../rag/vectors.js'
import { createPostgresAgentImMemoryContextReader, createPostgresAgentMemoryScopeResolver } from './scopes.js'

type WebOwnerMemorySearchOptions = Parameters<typeof createWebOwnerMemorySearchPort>[1]

/** Web 请求没有 IM 群身份；scope 解析与快照都必须由可信 Run 装配提供。 */
export function createWebOwnerMemorySearchPort(core: Pick<SqlDataRuntime, 'db'>, options: {
  storageRoot: string
  authorize(identity: RunIdentity, signal: AbortSignal, scopes?: readonly AuthorizedMemoryScope[]): Promise<boolean>
  snapshot(identity: RunIdentity, signal: AbortSignal): Promise<MemorySearchSnapshot>
  /** 仅接受可信 Host 解析器；未提供时保持 Web owner-only 的 Python 语义。 */
  resolveScopes?(identity: RunIdentity, requested: MemorySearchScope, signal: AbortSignal): Promise<AuthorizedMemoryScope[]>
  /** BYOK 解析和受控 transport 均由 Host 提供；省略时显式使用词法检索。 */
  embedding?: {
    resolve(ownerId: string, signal?: AbortSignal): Promise<RagQueryEmbeddingSettings | null>
    createTransport(settings: RagQueryEmbeddingSettings): ProviderTransport
  }
  observation?: AgentObservationPort
}): MemorySearchPort {
  if (!options.storageRoot.trim() || typeof options.authorize !== 'function' || typeof options.snapshot !== 'function') {
    throw new TypeError('Web 记忆搜索依赖未就绪')
  }
  // memory 和 conversation 搜索共享同一个 1.7.7 Jieba 实例；不能依赖别的端口先被装配。
  configureRagJieba(getAgentRagJieba())
  const storage = createLocalAgentMemoryRagStore(options.storageRoot)
  const resolveVectors = options.embedding ? createOwnerAgentRagVectorResolver({ root: options.storageRoot,
    resolveEmbedding: options.embedding.resolve, createTransport: options.embedding.createTransport }) : null
  const search = createMemorySearch({
    observation: options.observation,
    async resolveScopes(identity, requested, signal) {
      if (options.resolveScopes) return options.resolveScopes(identity, requested, signal)
      // Python 在非 IM 请求上将任何允许的 scope 选择收敛到 owner；Web 身份没有群上下文。
      return [{ ownerId: identity.ownerId, type: 'owner', id: identity.ownerId }]
    },
    authorize(identity, scopes, signal) {
      return scopes.length > 0 && scopes.every(scope => scope.ownerId.toLowerCase() === identity.ownerId.toLowerCase())
        ? options.authorize(identity, signal, scopes) : Promise.resolve(false)
    },
    snapshot: options.snapshot,
    storage: () => storage,
    scopeState: { getMemoryScopeState: createSqlMemoryScopeStateReader(core.db) },
    ...(resolveVectors ? { vectors: async (identity: RunIdentity, signal: AbortSignal) => {
      const resolved = await resolveVectors(identity.ownerId, signal)
      return resolved ? { version: resolved.version,
        embed: (query: string, embedSignal: AbortSignal) => resolved.embed(identity.ownerId, query, embedSignal) } : null
    } } : {}),
  })
  return { search }
}

/** PostgreSQL Host 组合：当前 IM 身份来自 owner/session/active-run 持久上下文，scope 再由 owner cursor 限定。 */
export function createPostgresAgentMemorySearchPort(core: Pick<SqlDataRuntime, 'db'>, pool: Pick<Pool, 'query'>,
  options: Omit<WebOwnerMemorySearchOptions, 'resolveScopes'>): MemorySearchPort {
  const context = createPostgresAgentImMemoryContextReader(pool)
  const resolveScopes = createPostgresAgentMemoryScopeResolver(core.db, { context })
  return createWebOwnerMemorySearchPort(core, { ...options, resolveScopes })
}
