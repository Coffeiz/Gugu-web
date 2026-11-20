import { sql, type Kysely } from 'kysely'
import { dataContext } from '../../contracts/index.js'
import { normalizeGlobalSearchQueries } from '../../search/query.js'
import { rankCandidates } from './ranking/rank-candidates.js'
import type { RagRankCandidate } from './contracts.js'
import type { RunIdentity } from '../models.js'
import type { AgentObservationPort } from '../observation.js'
import { recordAgentObservation } from '../observation.js'

type Row={message_id:number;session_id:number;role:string;content:string;title:string|null;summary:string|null;session_source:string|null;session_updated_at:unknown;match_count:number;created_at:unknown}
function time(value:unknown):string { return value instanceof Date?value.toISOString():typeof value==='string'?value:'' }
function escapeLike(value:string):string { return value.replaceAll('\\','\\\\').replaceAll('%','\\%').replaceAll('_','\\_') }

/** 与 Python 会话 adapter 一样，从事实表覆盖压缩水位之前仍保留的历史。 */
export function createSqlRagConversationSource(db:Kysely<any>,backend:'postgres'|'sqlite') {
 return async (rawOwner:string,scope:{scope_type:string},queries:readonly string[],mode:'OR'|'AND',limit:number,signal?:AbortSignal)=>{
  signal?.throwIfAborted()
  if(scope.scope_type!=='owner')throw new Error('历史对话检索范围无效')
  if(mode!=='OR'&&mode!=='AND')throw new Error('历史对话检索模式无效')
  if(!Number.isSafeInteger(limit)||limit<1)throw new Error('历史对话检索数量无效')
  const owner=dataContext(rawOwner).ownerId,ownerKey=backend==='sqlite'?owner.replaceAll('-',''):owner
  const terms=normalizeGlobalSearchQueries('',queries)
  if(!terms.length)return []
  const hits=sql`(${sql.join(terms.map(term=>sql`CASE WHEN lower(m.content) LIKE lower(${'%'+escapeLike(term)+'%'}) ESCAPE ${'\\'} THEN 1 ELSE 0 END`),sql` + `)})`
  const condition=mode==='AND'?sql`${hits}=${terms.length}`:sql`${hits}>0`
  const result=await sql<Row>`WITH candidates AS (
   SELECT m.id AS message_id,m.session_id,m.role,m.content,m.created_at,s.title,s.summary,s.source AS session_source,s.updated_at AS session_updated_at,
    ${hits} AS match_count,ROW_NUMBER() OVER (PARTITION BY s.id ORDER BY ${hits} DESC,m.conversation_seq DESC) AS session_rank
   FROM conversation_messages m JOIN conversation_sessions s ON s.id=m.session_id
   WHERE s.user_id=${ownerKey} AND (s.chat_type IS NULL OR s.chat_type<>'group') AND m.role IN ('user','assistant') AND m.content IS NOT NULL AND m.content<>'' AND ${condition}
  ) SELECT * FROM candidates WHERE session_rank=1 ORDER BY match_count DESC,created_at DESC,message_id DESC LIMIT ${Math.min(limit,50)}`.execute(db)
  signal?.throwIfAborted()
  return result.rows.map(row=>({session_id:Number(row.session_id),message_id:Number(row.message_id),source_id:String(row.message_id),
   title:row.title||'未命名对话',summary:row.summary||'',session_source:row.session_source||'web',session_updated_at:time(row.session_updated_at),
   role:row.role,text:row.content,created_at:time(row.created_at),score:Number(row.match_count)/terms.length}))
 }
}

/** Python 会话工具使用事实表候选和统一排序；分词器必须预先由 Host 装配。 */
export function createSqlRagConversationSearch(db:Kysely<any>,backend:'postgres'|'sqlite',trace?:{identity:RunIdentity;observation?:AgentObservationPort}) {
 const source=createSqlRagConversationSource(db,backend)
 let sequence=0
 return async (owner:string,queries:readonly string[],mode:'OR'|'AND',limit:number,signal?:AbortSignal)=>{
  const startedAt=Date.now(),spanId=`${trace?.identity.runId??'conversation-search'}:rag:conversation-search:${++sequence}`
  const record=(status:'success'|'error'|'cancelled',output:Record<string,unknown>,failureReason?:string)=>{
   if(!trace)return
   const endedAt=Date.now()
   recordAgentObservation(trace.observation,{identity:trace.identity,kind:'context',name:'Knowledge RAG recall',spanId,at:endedAt,startedAt,endedAt,
    durationMs:Math.max(0,endedAt-startedAt),status,output,
    attributes:{context_source:'rag_retrieval',rag_mode:'tool',namespace:'conversation',source_type:'conversation',engine:'typescript-bm25',index_version:'conversation-rag-v1',
     scope_type:'owner',injected:false,...(failureReason?{failure_reason:failureReason}:{})}})
  }
  try {
  const terms=normalizeGlobalSearchQueries('',queries)
  if(!terms.length){record('success',{message_count:0,injected:false,reason:'empty_query',scope_hits:[]});return []}
  const hits=await source(owner,{scope_type:'owner'},terms,mode,20,signal)
  const byId=new Map<string,typeof hits[number]>()
  const candidates:RagRankCandidate[]=hits.map((hit,index)=>{
   const parent=`conversation:${hit.session_id}:${hit.message_id}`,version=`${hit.message_id}:${hit.created_at}`
   const id=`conversation:${parent}:${version}:0:${index}`
   byId.set(id,hit)
   return {id,source_type:'conversation',raw_score:hit.score,document:{id,text:[hit.title,hit.summary,hit.text].filter(Boolean).join('\n'),ranking_text:hit.text,content:hit.text,source_type:'conversation',source_id:hit.source_id,title:hit.title,summary:hit.summary,scope_type:'owner',scope_id:'',document_version:version,parent_id:parent,chunk_index:0,chunk_count:1,updated_at:hit.created_at,metadata:{session_id:String(hit.session_id),message_id:hit.message_id,role:hit.role,session_source:hit.session_source,session_updated_at:hit.session_updated_at}}}
  })
  signal?.throwIfAborted()
  const ranked=rankCandidates(terms.join(' '),candidates,{selectionMode:'top_k',limit:Math.max(1,Math.min(limit,20)),maxChars:3000,maxPerSource:3,maxPerParent:3})
  signal?.throwIfAborted()
  const result=ranked.results.map(item=>({...byId.get(item.id)!,text:item.text}))
  record('success',{
   message_count:result.length,injected:false,reason:result.length?'':'no_hits',
   scope_hits:[{scope:'owner',candidate_count:candidates.length,hit_count:result.length}],
   diagnostics:{candidate_count:candidates.length,eligible_count:candidates.length,accepted_count:result.length,
    rejected_duplicate:ranked.diagnostics.rejected_duplicate,rejected_parent:ranked.diagnostics.rejected_parent,
    rejected_source:ranked.diagnostics.rejected_source,rejected_similarity:ranked.diagnostics.rejected_similarity,
    rejected_low_score:ranked.diagnostics.rejected_low_score,rejected_not_preferred:ranked.diagnostics.rejected_not_preferred,
    output_chars:ranked.diagnostics.output_chars,elapsed_ms:ranked.diagnostics.elapsed_ms,top_confidence:ranked.diagnostics.top_confidence,
    threshold:ranked.diagnostics.threshold,preferred_threshold:ranked.diagnostics.preferred_threshold,selection_mode:ranked.diagnostics.selection_mode,
    scoring_version:ranked.diagnostics.scoring_version,rescore_version:ranked.diagnostics.rescore_version??null,
    idf_source:ranked.diagnostics.idf_source??null,contribution_exponent:ranked.diagnostics.contribution_exponent??null,
    rank_details:ranked.results.map((item,index)=>({rank:index+1,source_type:'conversation',source_quality:item.source_quality,
     ...(item.query_match===undefined?{}:{query_match:item.query_match}),confidence:item.confidence,fused_score:item.fused_score,
     normalized_score:item.normalized_score,...(item.rank_score===undefined?{}:{rank_score:item.rank_score}),
     ...(item.query_idf_baseline===undefined?{}:{query_idf_baseline:item.query_idf_baseline}),contributions:item.rank_contributions??[]}))}
  })
  return result
  }catch(error){
   const cancelled=signal?.aborted===true
   record(cancelled?'cancelled':'error',{message_count:0,injected:false,reason:cancelled?'aborted':'retrieval_failed'},cancelled?'aborted':'retrieval_failed')
   throw error
  }
 }
}
