import type { ConversationSearchPort, ConversationSearchHit } from '../tools/conversations.js'
import type { AgentObservationPort } from '../observation.js'
import type { RunIdentity } from '../models.js'
import type { SqlDataRuntime } from '../../data/runtime.js'
import { createSqlAgentConversationSearchSources } from './data.js'
import { configureRagJieba, type RagJieba } from '../rag/tokenizer.js'
import { createSqlRagConversationSearch } from '../rag/conversation-source.js'
import { getAgentRagJieba } from '../rag/node-jieba.js'

interface AgentConversationRagSearch {
  search(ownerId: string, queries: string[], mode: 'OR' | 'AND', limit: number, signal: AbortSignal): Promise<ConversationSearchHit[]>
}

/** RAG 由宿主显式装配，近期会话和命中归属使用共享领域查询。 */
export function createAgentConversationSearchPort(core: Pick<SqlDataRuntime, 'db' | 'backend'>,
  rag: AgentConversationRagSearch): ConversationSearchPort {
  const source = createSqlAgentConversationSearchSources(core.db, core.backend)
  return {
    recent: (identity, limit, signal) => source.recent(identity.ownerId, limit, signal),
    search: (identity, queries, mode, limit, signal) => rag.search(identity.ownerId, queries, mode, limit, signal),
    resolve: (identity, hit, signal) => source.resolve(identity.ownerId, hit, signal),
  }
}

export function createCoreAgentConversationSearchPort(core: Pick<SqlDataRuntime, 'db' | 'backend'>,
  jieba: RagJieba = getAgentRagJieba(), trace?: { identity: RunIdentity; observation?: AgentObservationPort }): ConversationSearchPort {
  configureRagJieba(jieba)
  return createAgentConversationSearchPort(core, { search: createSqlRagConversationSearch(core.db, core.backend, trace) })
}
