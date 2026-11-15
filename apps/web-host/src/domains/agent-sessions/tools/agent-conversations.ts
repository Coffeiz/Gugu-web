import type { Pool } from 'pg'
import type { ConversationReadPort,ConversationSearchPort,ConversationSearchHit } from '@gugu/core/tools'
import type { SqlDataRuntime } from '@gugu/core/data'
import { createPostgresAgentConversationTextReader,createSqlAgentConversationSearchSources } from '@gugu/core/agent-sessions'

/** 复用会话历史读取服务；owner 仅来自可信运行身份。 */
export function createAgentConversationReadPort(pool:Pick<Pool,'query'|'connect'>):ConversationReadPort {
 const read=createPostgresAgentConversationTextReader(pool)
 return {read:(identity,sessionId,limit,signal)=>read(identity.ownerId,sessionId,limit,signal)}
}

/** RAG 由 Host 显式提供，近期列表和命中归属复用共享会话领域查询。 */
export function createAgentConversationSearchPort(core:SqlDataRuntime,rag:{search(ownerId:string,queries:string[],mode:'OR'|'AND',limit:number,signal:AbortSignal):Promise<ConversationSearchHit[]>}):ConversationSearchPort {
 const source=createSqlAgentConversationSearchSources(core.db,core.backend)
 return {recent:(identity,limit,signal)=>source.recent(identity.ownerId,limit,signal),
  search:(identity,queries,mode,limit,signal)=>rag.search(identity.ownerId,queries,mode,limit,signal),
  resolve:(identity,hit,signal)=>source.resolve(identity.ownerId,hit,signal)}
}
