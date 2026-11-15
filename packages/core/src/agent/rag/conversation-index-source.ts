import { sql, type Kysely } from 'kysely'
import { dataContext } from '../../contracts/index.js'
import { buildSourceDocuments } from './index-builder.js'
import type { RagRebuildSource } from './rebuild-worker.js'

type SessionRow={id:number|string;user_id:string;title:string|null;summary:string|null;source:string|null;bot_id:string|null;chat_id:string|null;chat_type:string|null;updated_at:unknown;baseline_message_seq:number|string|null}
type MessageRow={id:number|string;session_id:number|string;conversation_seq:number|string;history_anchor_seq:number|string|null;role:string;content:string|null;created_at:unknown;sent_at:unknown}
const iso=(value:unknown):string=>{
 if(value instanceof Date)return value.toISOString().replace(/Z$/u,'+00:00')
 if(typeof value!=='string')return ''
 return value.replace(' ','T').replace(/([+-]\d{2})$/u,'$1:00')
}
const timestamp=(backend:'postgres'|'sqlite',column:string)=>backend==='postgres'
 ?sql`to_char(${sql.raw(column)} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US') || '+00:00'`
 :sql`CAST(${sql.raw(column)} AS TEXT)`
const sessionScope=(session:SessionRow)=>session.chat_type==='group'&&session.chat_id
 ?{scope_type:'group',scope_id:String(session.chat_id),platform:session.source||'',bot_id:session.bot_id||'',group_id:session.chat_id}
 :{scope_type:'owner',scope_id:''}
const contextLine=(row:MessageRow):string=>{
 const content=String(row.content||'').trim()
 return (row.role==='user'||row.role==='assistant')&&content?`${row.role}：${Array.from(content).slice(0,600).join('')}`:''
}

/** 将 Python index_builder 的会话记录投影复用到持久索引 Worker。 */
export function createConversationRagSource(db:Kysely<any>,backend:'postgres'|'sqlite'):RagRebuildSource {
 return async(rawOwner,sourceId,signal)=>{
  signal?.throwIfAborted()
  const owner=dataContext(rawOwner).ownerId,ownerKey=backend==='sqlite'?owner.replaceAll('-',''):owner
  if(sourceId!==null&&!/^(?:[1-9]\d*|[1-9]\d*:summary)$/u.test(sourceId))throw new Error('RAG 对话来源标识无效')
  const summaryId=sourceId?.endsWith(':summary')?sourceId:null
  const singleSession=summaryId?summaryId.slice(0,-8):null
  const numericId=singleSession??(sourceId===null?null:sourceId)
  if(numericId!==null&&!Number.isSafeInteger(Number(numericId)))throw new Error('RAG 对话来源标识无效')
  let sessions:SessionRow[]
  if(singleSession!==null){
   const result=await sql<SessionRow>`SELECT id,user_id,title,summary,source,bot_id,chat_id,chat_type,${timestamp(backend,'updated_at')} AS updated_at,baseline_message_seq FROM conversation_sessions WHERE user_id=${ownerKey} AND id=${Number(singleSession)}`.execute(db)
   sessions=result.rows
  }else if(sourceId!==null){
   const result=await sql<SessionRow>`SELECT s.id,s.user_id,s.title,s.summary,s.source,s.bot_id,s.chat_id,s.chat_type,${timestamp(backend,'s.updated_at')} AS updated_at,s.baseline_message_seq FROM conversation_messages m JOIN conversation_sessions s ON s.id=m.session_id WHERE s.user_id=${ownerKey} AND m.id=${Number(sourceId)}`.execute(db)
   sessions=result.rows
  }else{
   const result=await sql<SessionRow>`SELECT id,user_id,title,summary,source,bot_id,chat_id,chat_type,${timestamp(backend,'updated_at')} AS updated_at,baseline_message_seq FROM conversation_sessions WHERE user_id=${ownerKey} ORDER BY updated_at DESC,id DESC`.execute(db)
   sessions=result.rows
  }
  if(!sessions.length)return []
  signal?.throwIfAborted()
  const ids=sessions.map(session=>Number(session.id))
  const rows=await sql<MessageRow>`SELECT id,session_id,conversation_seq,history_anchor_seq,role,content,${timestamp(backend,'created_at')} AS created_at,${timestamp(backend,'sent_at')} AS sent_at FROM conversation_messages WHERE session_id IN (${sql.join(ids)}) ORDER BY session_id ASC,COALESCE(history_anchor_seq,conversation_seq),CASE WHEN history_anchor_seq IS NOT NULL THEN 0 ELSE 1 END,conversation_seq`.execute(db)
  signal?.throwIfAborted()
  const bySession=new Map<string,MessageRow[]>()
  for(const row of rows.rows){const key=String(row.session_id),list=bySession.get(key)||[];list.push(row);bySession.set(key,list)}
  const records=[]
  for(const session of sessions){
   // 群会话缺少可信 chat_id 时无法形成可授权 scope，绝不能降级为 owner 内容。
   if(session.chat_type==='group'&&!session.chat_id)continue
   const sid=String(session.id),scope=sessionScope(session)
   if((sourceId===null||summaryId!==null)&&(session.summary||'').trim())records.push({id:`${sid}:summary`,kind:'summary' as const,session_id:sid,title:session.title||'',summary:session.summary||'',session_source:session.source||'',session_updated_at:iso(session.updated_at),version_parts:[sid,iso(session.updated_at),session.summary||''],updated_at:iso(session.updated_at),scope})
   const baseline=Number(session.baseline_message_seq||0)
   const eligible=(bySession.get(sid)||[]).filter(row=>Number(row.history_anchor_seq||row.conversation_seq)>baseline&&(row.role==='user'||row.role==='assistant')&&String(row.content||'').trim())
   for(let i=0;i<eligible.length;i++){
    const row=eligible[i]!,id=String(row.id)
    if(summaryId!==null||sourceId!==null&&sourceId!==id)continue
    const before=i?contextLine(eligible[i-1]!):'',after=i+1<eligible.length?contextLine(eligible[i+1]!):''
    records.push({id,kind:'message' as const,session_id:sid,role:row.role,content:row.content||'',title:session.title||'',session_source:session.source||'',session_updated_at:iso(session.updated_at),context_before:before,context_after:after,version_parts:[id,iso(row.created_at),row.content||'',before,after],updated_at:iso(row.sent_at)||iso(row.created_at),scope})
   }
  }
  signal?.throwIfAborted()
  return buildSourceDocuments({conversations:records})
 }
}
