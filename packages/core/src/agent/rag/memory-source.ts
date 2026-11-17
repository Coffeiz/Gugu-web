import { createHash } from 'node:crypto'
import type { RagDocument } from './contracts.js'
import { prepareMemory, type AuthorizedMemoryScope, type MemoryRagScopeStatePort, type MemoryRagStorageReader } from './memory-loader.js'
import type { RagRebuildSource } from './rebuild-worker.js'

/**
 * 把 1.7.7 的 owner 与 IM memory 文件投影到 2.0 正式 RAG 索引。
 * Scope 枚举必须由 Host 按 owner 从可信授权来源构造；此处不接受工具/模型参数。
 */
export function createMemoryRagSource(options: {
  storage: MemoryRagStorageReader
  scopeState: MemoryRagScopeStatePort
  scopes(ownerId: string, signal?: AbortSignal): Promise<readonly AuthorizedMemoryScope[]>
}): RagRebuildSource {
  return async (ownerId, _sourceId, signal): Promise<readonly RagDocument[]> => {
    signal?.throwIfAborted()
    const scoped = await options.scopes(ownerId, signal)
    signal?.throwIfAborted()
    const scopes: AuthorizedMemoryScope[] = [
      { ownerId, type: 'owner', id: ownerId },
      ...scoped,
    ]
    const prepared = await prepareMemory({
      ownerId,
      scopes,
      sourceFilter: 'all',
      snapshotRevision: '',
      snapshotText: '',
      vectorVersion: '',
      signal,
    }, options.scopeState, options.storage)
    signal?.throwIfAborted()
    return prepared.documents.map(document => {
      // SQL 的持久索引键不含 scope 列。旧 Memory index 可在 owner/group/member scope
      // 中出现相同 source_id、version、chunk；为避免不同 scope 覆写同一行，派生索引键需命名空间化。
      const scopeKey = [document.scope_type, document.platform, document.bot_id, document.group_id, document.scope_id].join('\x1f')
      const scopeHash = createHash('sha256').update(scopeKey, 'utf8').digest('hex').slice(0, 24)
      const sourceId = String(document.source_id || '')
      const parentId = String(document.parent_id || document.id)
      const namespacedParent = `${parentId}:scope:${scopeHash}`
      return {
        ...document,
        id: `memory:${namespacedParent}:${document.chunk_index || 0}`,
        source_id: `scope:${scopeHash}:${sourceId}`,
        parent_id: namespacedParent,
        metadata: {
          ...document.metadata,
          memory_source_id: sourceId,
          memory_parent_id: parentId,
          memory_scope_hash: scopeHash,
        },
      }
    })
  }
}
