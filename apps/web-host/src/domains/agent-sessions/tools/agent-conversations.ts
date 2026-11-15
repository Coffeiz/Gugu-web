import type { Pool } from 'pg'
import type { ConversationReadPort,ConversationSearchPort,ConversationSearchHit } from '@gugu/core/tools'
import type { SqlDataRuntime } from '@gugu/core/data'
import { createPostgresAgentConversationTextReader,createSqlAgentConversationSearchSources } from '@gugu/core/agent-sessions'
import { configureRagJieba,createScopedRagSearch,createSqlRagConversationSearch,createSqlRagPersistentIndexReader,type RagJieba } from '@gugu/core/agent'
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

/** 基于持久 RAG 索引的历史对话搜索；与 Python `search_conversations` 一样固定使用 BM25。 */
export function createIndexedAgentConversationSearchPort(core:Pick<SqlDataRuntime,'db'|'backend'>,options:{jieba?:RagJieba}={}):ConversationSearchPort {
 configureRagJieba(options.jieba??getAgentRagJieba())
 const index=createSqlRagPersistentIndexReader(core.db,core.backend)
 const sources=createSqlAgentConversationSearchSources(core.db,core.backend)
 const scope={scope_type:'owner',scope_id:''} as const
 return {
  recent:(identity,limit,signal)=>sources.recent(identity.ownerId,limit,signal),
  async search(identity,queries,mode,limit,signal){
   signal.throwIfAborted()
   if(mode!=='OR'&&mode!=='AND')throw new Error('历史对话检索模式无效')
   const terms=[...new Set(queries.map(term=>term.trim()).filter(Boolean))]
   if(!terms.length)return []
   const search=createScopedRagSearch({index,authorize:async(owner,requested)=>Boolean(owner.trim())&&requested.scope_type==='owner'&&requested.scope_id===''})
   // Python search_conversations 的 UnifiedRecallService 将候选上限固定为 20；
   // 工具层虽会为跨消息去重请求 4 倍候选，RAG 本身仍须保留这个旧上限。
   const result=await search(identity.ownerId,scope,terms.join(' '),{sourceTypes:['conversation'],limit:Math.max(1,Math.min(limit,20))},signal)
   signal.throwIfAborted()
   const documents=result.results.map(item=>item.document)
   const details=await sources.details(identity.ownerId,documents.map(document=>Number(document.metadata?.session_id)).filter(Number.isSafeInteger),signal)
   signal.throwIfAborted()
   const matches=documents.flatMap(document=>{
    const metadata=document.metadata??{}
    if(metadata.kind!=='message')return []
    const text=String(document.content??'').trim(),lower=text.toLocaleLowerCase()
    const found=terms.map(term=>lower.includes(term.toLocaleLowerCase()))
    if(mode==='AND'?!found.every(Boolean):!found.some(Boolean))return []
    const sessionId=Number(metadata.session_id),messageId=Number(metadata.message_id)
    if(!Number.isSafeInteger(sessionId)||sessionId<1||!Number.isSafeInteger(messageId)||messageId<1)return []
    const session=details.get(sessionId)
    if(!session)return []
    return [{session_id:sessionId,message_id:messageId,source_id:String(messageId),title:session.title,
     summary:session.summary,session_source:session.source||'web',session_updated_at:session.updated_at,
     role:String(metadata.role||''),text:[session.title,session.summary,text].filter(Boolean).join('\n')}]
   })
   return matches
  },
  resolve:(identity,hit,signal)=>sources.resolve(identity.ownerId,hit,signal),
 }
}
