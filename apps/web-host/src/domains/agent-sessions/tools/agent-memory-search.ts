import { createMemorySearch, createSqlMemoryScopeStateReader, type AuthorizedMemoryScope, type MemorySearchScope, type MemorySearchSnapshot } from '@gugu/core/agent'
import type { RunIdentity } from '@gugu/core/agent'
import type { SqlDataRuntime } from '@gugu/core/data'
import type { ProviderTransport } from '@gugu/core/providers'
import type { RagQueryEmbeddingSettings } from '@gugu/core/agent'
import type { MemorySearchPort } from '@gugu/core/tools'
import { createLocalAgentMemoryRagStore } from './agent-rag-memory-store.js'
import { createOwnerAgentRagVectorResolver } from './agent-rag-vectors.js'

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
}): MemorySearchPort {
  if (!options.storageRoot.trim() || typeof options.authorize !== 'function' || typeof options.snapshot !== 'function') {
    throw new TypeError('Web 记忆搜索依赖未就绪')
  }
  const storage = createLocalAgentMemoryRagStore(options.storageRoot)
  const resolveVectors = options.embedding ? createOwnerAgentRagVectorResolver({ root: options.storageRoot,
    resolveEmbedding: options.embedding.resolve, createTransport: options.embedding.createTransport }) : null
  const search = createMemorySearch({
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
