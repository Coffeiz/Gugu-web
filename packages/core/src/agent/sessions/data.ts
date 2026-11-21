import { Kysely, PostgresDialect, sql } from 'kysely'
import type { Pool } from 'pg'
import { CoreError, dataContext } from '../../contracts/index.js'
import type { AgentSessionRepository } from './application.js'
import { asciiDecimalDigits, decimalDigitPattern } from '../../shared/unicode-decimal.js'

// 桌面历史、跳转和引用正文使用同一条展示消息条件，查询统一使用 m 作为消息别名。
export const desktopDisplayMessage = sql`m.role IN ('user','assistant')
  AND (m.content_json IS NULL OR m.role='user') AND m.canonical_batch_id IS NULL`

/** SQL 只访问指定 owner；SQLite 的 owner 存储采用 Core 既有的无连字符格式。 */
export function createSqlAgentSessionRepository(db: Kysely<any>, backend: 'postgres' | 'sqlite'): AgentSessionRepository {
  const ownerKey = (owner: string) => backend === 'sqlite' ? owner.replaceAll('-', '') : owner
  async function guarded<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation() }
    catch (error) {
      const e = error as { code?: string; message?: string }
      if (backend === 'sqlite' && e.code === 'SQLITE_ERROR' && /no such table: (?:conversation_sessions|conversation_messages)/.test(e.message ?? '')) throw new CoreError('schema_upgrade_required', 'Agent 会话数据表尚未初始化')
      throw error
    }
  }
  return {
    rename: (ownerId, sessionId, title) => guarded(async () => {
      const locked = backend === 'sqlite' ? 1 : true, owner = ownerKey(ownerId)
      const result = await sql<{ id: number; title: string; title_locked: boolean | number }>`UPDATE conversation_sessions SET title=${title},title_locked=${locked} WHERE id=${sessionId} AND user_id=${owner} RETURNING id,title,title_locked`.execute(db)
      const row = result.rows[0]
      return row ? { id: Number(row.id), title: row.title, title_locked: Boolean(row.title_locked) } : null
    }),
    locate: (ownerId, messageId) => guarded(async () => {
      const owner = ownerKey(ownerId)
      const visible = backend === 'sqlite'
        ? sql`(s.source IS NULL OR s.source='web') AND ${desktopDisplayMessage}`
        : sql`m.content_json IS NULL AND m.role <> 'summary'`
      const result = await sql<{ id: number; session_id: number }>`SELECT m.id, m.session_id
        FROM conversation_messages m JOIN conversation_sessions s ON s.id=m.session_id
        WHERE m.id=${messageId} AND s.user_id=${owner} AND ${visible}`.execute(db)
      const row = result.rows[0]
      return row ? { id: Number(row.id), sessionId: Number(row.session_id) } : null
    }),
  }
}

/** 复用 Host 的 PG 连接池；池的关闭仍由 Host 管理。 */
export function createPostgresAgentSessionRepository(pool: Pick<Pool, 'query' | 'connect'>): AgentSessionRepository {
  return createSqlAgentSessionRepository(new Kysely<any>({ dialect: new PostgresDialect({ pool: pool as Pool }) }), 'postgres')
}

/** 同一查询校验归属，取最近的普通正文；供 Web 与桌面共用。 */
export function createSqlAgentConversationTextReader(db:Kysely<any>,backend:'postgres'|'sqlite') {
 return async (rawOwner:string,sessionId:number,limit:number,signal?:AbortSignal)=>{
  signal?.throwIfAborted()
  if(!Number.isSafeInteger(sessionId)||sessionId<1)return null
  if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new CoreError('invalid_request','消息数量无效')
  const normalized=dataContext(rawOwner).ownerId,owner=backend==='sqlite'?normalized.replaceAll('-',''):normalized
  const result=await sql<{session_id:number;title:string;source:string|null;role:string|null;content:string|null}>`
   SELECT s.id AS session_id,s.title,s.source,m.role,m.content FROM conversation_sessions s
   LEFT JOIN (SELECT session_id,role,content,conversation_seq,ROW_NUMBER() OVER (ORDER BY conversation_seq DESC) AS seq_rank
     FROM conversation_messages WHERE session_id=${sessionId} AND content_json IS NULL) m ON m.session_id=s.id AND m.seq_rank<=${limit}
   WHERE s.user_id=${owner} AND s.id=${sessionId} ORDER BY m.conversation_seq ASC`.execute(db)
  signal?.throwIfAborted()
  if(!result.rows.length)return null
  const session=result.rows[0]!
  return {session_id:Number(session.session_id),title:session.title,source:session.source,
   messages:result.rows.filter(row=>row.content).map(row=>({role:row.role==='user'?'你':'咕咕',content:[...row.content!].slice(0,1200).join('')}))}
 }
}
export function createPostgresAgentConversationTextReader(pool:Pick<Pool,'query'|'connect'>) {
 return createSqlAgentConversationTextReader(new Kysely<any>({dialect:new PostgresDialect({pool:pool as Pool})}),'postgres')
}

/** 历史搜索共用的近期会话与旧消息 ID 定位；不会访问其他 owner 的会话。 */
export function createSqlAgentConversationSearchSources(db:Kysely<any>,backend:'postgres'|'sqlite') {
 const key=(raw:string)=>{const owner=dataContext(raw).ownerId;return backend==='sqlite'?owner.replaceAll('-',''):owner}
 function positive(value:unknown):number|null{
  let number:number
  if(typeof value==='number'&&Number.isFinite(value))number=Math.trunc(value)
  else if(typeof value==='boolean')number=Number(value)
  else if(typeof value==='string'&&new RegExp(`^[+-]?${decimalDigitPattern}+$`,'u').test(value.trim()))number=Number(asciiDecimalDigits(value.trim()))
  else return null
  return Number.isSafeInteger(number)&&number>0?number:null
 }
 return {
  async recent(rawOwner:string,limit:number,signal?:AbortSignal){
   signal?.throwIfAborted();const owner=key(rawOwner)
   if(!Number.isSafeInteger(limit)||limit<1||limit>20)throw new CoreError('invalid_request','会话数量无效')
   const time=backend==='postgres'?sql`to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI')`:sql`substr(updated_at,1,16)`
   const result=await sql<{session_id:number;title:string;summary:string|null;source:string|null;updated_at:string}>`SELECT id AS session_id,title,summary,source,${time} AS updated_at FROM conversation_sessions WHERE user_id=${owner} ORDER BY conversation_sessions.updated_at DESC LIMIT ${limit}`.execute(db)
   signal?.throwIfAborted();return result.rows.map(row=>({...row,session_id:Number(row.session_id),summary:row.summary||''}))
  },
  async resolve(rawOwner:string,hit:{session_id?:unknown;message_id?:unknown;source_id?:unknown},signal?:AbortSignal){
   signal?.throwIfAborted();const owner=key(rawOwner)
   const owned=async(id:number)=>!!(await sql`SELECT 1 FROM conversation_sessions WHERE user_id=${owner} AND id=${id}`.execute(db)).rows.length
   const direct=positive(hit.session_id)
   if(direct){const ok=await owned(direct);signal?.throwIfAborted();return ok?direct:null}
   let message=positive(hit.message_id),source=positive(hit.source_id)
   if(!message&&source){if(await owned(source)){signal?.throwIfAborted();return source}message=source}
   if(!message){signal?.throwIfAborted();return null}
   const result=await sql<{session_id:number}>`SELECT m.session_id FROM conversation_messages m JOIN conversation_sessions s ON s.id=m.session_id WHERE m.id=${message} AND s.user_id=${owner}`.execute(db)
   signal?.throwIfAborted();return result.rows[0]?Number(result.rows[0].session_id):null
  },
  async details(rawOwner:string,sessionIds:readonly number[],signal?:AbortSignal){
   signal?.throwIfAborted();const owner=key(rawOwner),ids=[...new Set(sessionIds)]
   if(ids.some(id=>!Number.isSafeInteger(id)||id<1)||ids.length>50)throw new CoreError('invalid_request','会话范围无效')
   if(!ids.length)return new Map<number,{title:string;summary:string;source:string|null;updated_at:string}>()
   const updated=backend==='postgres'?sql`to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US') || '+00:00'`:sql`CAST(updated_at AS TEXT)`
   const result=await sql<{id:number;title:string|null;summary:string|null;source:string|null;updated_at:string}>`
    SELECT id,title,summary,source,${updated} AS updated_at FROM conversation_sessions
    WHERE user_id=${owner} AND id IN (${sql.join(ids)})
   `.execute(db)
   signal?.throwIfAborted()
   return new Map(result.rows.map(row=>[Number(row.id),{title:row.title||'未命名对话',summary:row.summary||'',source:row.source,updated_at:String(row.updated_at||'')}]))
  },
 }
}
