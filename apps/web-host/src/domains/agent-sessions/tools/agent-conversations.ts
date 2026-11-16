import type { Pool } from 'pg'
import type { ConversationReadPort,ConversationSearchPort,ConversationSearchHit } from '@gugu/core/tools'
import type { SqlDataRuntime } from '@gugu/core/data'
import { createPostgresAgentConversationTextReader,createSqlAgentConversationSearchSources } from '@gugu/core/agent-sessions'
import { configureRagJieba,createSqlRagConversationSearch,type RagJieba } from '@gugu/core/agent'
import { getAgentRagJieba } from './agent-rag-jieba.js'

/** 复用会话历史读取服务；owner 仅来自可信运行身份。 */
export function createAgentConversationReadPort(pool:Pick<Pool,'query'|'connect'>):ConversationReadPort {
 const read=createPostgresAgentConversationTextReader(pool)
 return {read:(identity,sessionId,limit,signal)=>read(identity.ownerId,sessionId,limit,signal)}
}

type AgentConversationRagSearch={search(ownerId:string,queries:string[],mode:'OR'|'AND',limit:number,signal:AbortSignal):Promise<ConversationSearchHit[]>}
/** RAG 必须由 Host 显式装配；近期列表和命中归属复用共享会话领域查询。 */
export function createAgentConversationSearchPort(core:Pick<SqlDataRuntime,'db'|'backend'>,rag:AgentConversationRagSearch):ConversationSearchPort {
 const source=createSqlAgentConversationSearchSources(core.db,core.backend)
 return {recent:(identity,limit,signal)=>source.recent(identity.ownerId,limit,signal),
  search:(identity,queries,mode,limit,signal)=>rag.search(identity.ownerId,queries,mode,limit,signal),
  resolve:(identity,hit,signal)=>source.resolve(identity.ownerId,hit,signal)}
}

/** 只有 Host 已提供正式分词器后才启用 Core RAG 会话搜索。 */
export function createCoreAgentConversationSearchPort(core:Pick<SqlDataRuntime,'db'|'backend'>,jieba:RagJieba=getAgentRagJieba()):ConversationSearchPort {
 configureRagJieba(jieba)
 return createAgentConversationSearchPort(core,{search:createSqlRagConversationSearch(core.db,core.backend)})
}
