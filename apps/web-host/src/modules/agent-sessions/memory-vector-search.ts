import type { AgentMemoryVectorSearchPort, RagQueryEmbeddingSettings } from '@gugu/core/agent'
import type { ProviderTransport } from '@gugu/core/providers'
import { normalizeOwnerId } from '../../adapters/owner-context.js'
import { createOwnerAgentRagVectorResolver } from '../../domains/agent-sessions/tools/agent-rag-vectors.js'

export interface AgentMemoryVectorEmbeddingPort {
  resolve(ownerId: string, signal?: AbortSignal): Promise<RagQueryEmbeddingSettings | null>
  createTransport(settings: RagQueryEmbeddingSettings): ProviderTransport
}

function parseVectors(raw: string | null): unknown {
  if (!raw?.trim()) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * 将 Python memory snapshot 使用的旧向量文件接到 owner-bound BYOK embedding。
 * 复用 RAG 的固定路径读取、embedding 规则与受控 Provider transport；调用方不能指定 owner 或文件路径。
 */
export function createAgentMemoryVectorSearchFactory(options: {
  storageRoot: string
  embedding: AgentMemoryVectorEmbeddingPort
}) {
  if (!options.storageRoot.trim()) throw new TypeError('Agent 记忆向量存储根目录未配置')
  const resolve = createOwnerAgentRagVectorResolver({
    root: options.storageRoot,
    resolveEmbedding: options.embedding.resolve,
    createTransport: options.embedding.createTransport,
  })

  return (rawOwnerId: string): AgentMemoryVectorSearchPort => {
    const ownerId = normalizeOwnerId(rawOwnerId)
    let resolved: Awaited<ReturnType<typeof resolve>> | null = null
    const assertOwner = (candidate: string) => {
      if (normalizeOwnerId(candidate) !== ownerId) throw new Error('记忆向量 owner 不匹配')
    }
    return {
      async embed(candidateOwnerId, query, signal) {
        assertOwner(candidateOwnerId)
        signal?.throwIfAborted()
        const current = await resolve(ownerId, signal)
        resolved = current
        signal?.throwIfAborted()
        if (!current) return null
        const vector = await current.embed(ownerId, query, signal)
        signal?.throwIfAborted()
        return vector.length ? { vector, modelTag: current.version } : null
      },
      async read(candidateOwnerId, kind, signal) {
        assertOwner(candidateOwnerId)
        if (kind !== 'pattern' && kind !== 'memory') throw new Error('记忆向量类型无效')
        signal?.throwIfAborted()
        if (!resolved) return {}
        const source = await resolved.source(ownerId, signal)
        const raw = await source(kind, signal)
        signal?.throwIfAborted()
        return parseVectors(raw)
      },
    }
  }
}
