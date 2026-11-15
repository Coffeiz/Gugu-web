import { sql, type Kysely, type Transaction, type Selectable } from 'kysely'
import { dataContext } from '../contracts/index.js'
import type { Backend } from '../data/repositories.js'
import { strip } from '../shared/values.js'
import { utc } from '../data/codec.js'
import { asciiDecimalDigits, decimalDigitPattern } from '../shared/unicode-decimal.js'
import { normalizeGlobalSearchQueries } from '../search/query.js'
import type { Database, MindNodeTable, MindRelationTable } from '../data/schema.js'
import { mindNodeReadResponse } from './canvas-read.js'

/** 仅返回可信 owner 的活动时间流便签。分页校验由入口负责。 */
export function createSqlMindNoteReader(db: Kysely<Database>, backend: Backend) {
  function ownerId(raw: string) { const owner = dataContext(raw).ownerId; return backend === 'sqlite' ? owner.replaceAll('-', '') : owner }
  return {
    async list(raw: string, limit: number, offset: number) {
      const rows = await db.selectFrom('mind_nodes').selectAll().where('user_id', '=', ownerId(raw)).where('kind', '=', 'note').where('deleted_at', 'is', null).orderBy(sql`date(captured_at)`, 'desc').orderBy('created_at', 'desc').orderBy('id', 'desc').limit(limit).offset(offset).execute()
      return rows.map(mindNodeReadResponse)
    },
    async get(raw: string, noteId: number) {
      const row = await db.selectFrom('mind_nodes').selectAll().where('id', '=', noteId).where('user_id', '=', ownerId(raw)).where('kind', '=', 'note').where('deleted_at', 'is', null).executeTakeFirst()
      return row ? mindNodeReadResponse(row) : null
    },
    /** 供可信索引重建读取；覆盖 Python 的 note/suggestion，包含分词版本所需字段。 */
    async listForRag(raw:string, id:number|null, signal?:AbortSignal) {
      signal?.throwIfAborted()
      const owner=ownerId(raw)
      const updated=backend==='postgres'?sql<string>`to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US') || '+00:00'`:sql<string>`updated_at`
      let query=db.selectFrom('mind_nodes').select(['id','kind','title','content_md','content_plain','indexed_hash','version']).select(updated.as('updated_at'))
        .where('user_id','=',owner).where('kind','in',['note','suggestion']).where('deleted_at','is',null)
      if(id!==null)query=query.where('id','=',id)
      try{return await query.orderBy('updated_at','desc').orderBy('id','desc').execute()}
      finally{signal?.throwIfAborted()}
    },
  }
}

/** Agent读取保留正文、来源和精确时间；与Web的note-only列表使用不同投影。 */
export interface AgentMindSearch { query?:string; q?:string; queries?:string[]; mode?:'OR'|'AND'; limit?:number; include_content?:boolean }
type NodeRow = Selectable<MindNodeTable>
type RelationRow = Selectable<MindRelationTable>
type Reference = {ref_type:string;ref_id:number;label:string|null}

/** Python物理行规则（含CRLF和Unicode分隔符），供引用解析与原始行号共用。 */
function physicalLines(text:string):string[]{
  return text.match(/[^\n\r\v\f\x1c-\x1e\x85\u2028\u2029]*(?:\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]|$)/gu)?.filter(Boolean)??[]
}
function lineText(line:string){return line.replace(/(?:\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029])$/u,'')}
/** 与Python提取器同样忽略围栏、任意长度行内代码、奇数反斜线转义；顺序去重。 */
export function extractMindReferences(markdown:string):Array<{type:string;id:number}>{
  const lines:string[]=[];let fence:string|undefined
  for(const line of physicalLines(markdown)){
    const marker=/^ {0,3}(`{3,}|~{3,})/.exec(line)
    if(fence){
      const closing=/^ {0,3}([~`]+)([\s\S]*)$/u.exec(lineText(line))
      if(closing && closing[1]!.length>=fence.length && [...closing[1]!].every(char=>char===fence![0]) && !strip(closing[2]!))fence=undefined
      continue
    }
    if(marker){fence=marker[1];continue}
    lines.push(line)
  }
  const text=lines.join('').replace(/(?<!`)(?<ticks>`+)(?!`)[\s\S]*?(?<!`)\k<ticks>(?!`)/gu,' ')
  const pattern=new RegExp('\\[\\[(?<type>[a-z_]+):(?<id>'+decimalDigitPattern+'+)\\|(?<label>[^\\]]*)\\]\\]','gu')
  const refs:Array<{type:string;id:number}>=[],seen=new Set<string>()
  for(const match of text.matchAll(pattern)){
    let before=match.index!-1
    while(before>=0&&text[before]==='\\')before--
    if((match.index!-1-before)%2)continue
    const id=Number(asciiDecimalDigits(match.groups!.id!)),type=match.groups!.type!,key=type+':'+id
    if(id>0&&Number.isSafeInteger(id)&&!seen.has(key)){seen.add(key);refs.push({type,id})}
  }
  return refs
}
function summary(node:NodeRow){
  return {node_id:Number(node.id),kind:node.kind,title:node.title,color:node.color,preview:[...strip(node.content_plain)].slice(0,240).join(''),
    captured_at:utc(node.captured_at).replace(' ','T'),source:node.ref_type?{type:node.ref_type,id:node.ref_id}:null}
}
export function agentMindNodeDetail(node:NodeRow){return {...summary(node),content_md:node.content_md,content_plain:node.content_plain,origin:node.origin}}

/** 共享Mind读取：匹配排序不采用全局搜索相关性排名；关系边与正文引用是独立机制。 */
export function createAgentMindReader(db:Kysely<Database>,backend:Backend){
  const ownerId=(raw:string)=>{const normalized=dataContext(raw).ownerId;return backend==='sqlite'?normalized.replaceAll('-',''):normalized}
  function nodes(tx:Transaction<Database>){
    // pg默认Date parser会损失微秒；让SQL返回UTC文本，之后复用严格时间codec。
    const stamp=backend==='postgres'?sql<string>`to_char(captured_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US') || '+00:00'`:sql<string>`captured_at`
    return tx.selectFrom('mind_nodes').selectAll().select(stamp.as('captured_at'))
  }
  async function aggregate(tx:Transaction<Database>,owner:string,matches:NodeRow[],signal?:AbortSignal){
    signal?.throwIfAborted()
    const ids=matches.map(row=>Number(row.id)),empty={related:[] as Record<string,unknown>[],references:new Map<number,Reference[]>()}
    if(!ids.length)return empty
    // 沿用Python当前list_node_relations语义：不根据canvas可见性或关系deleted_at另加筛选，端点必须存活且同owner。
    const relations:RelationRow[]=await tx.selectFrom('mind_relations').selectAll().where('user_id','=',owner)
      .where(eb=>eb.or([eb('src_node_id','in',ids),eb('dst_node_id','in',ids)])).orderBy('created_at','desc').execute()
    const neighborIds=[...new Set(relations.flatMap(row=>[Number(row.src_node_id),Number(row.dst_node_id)]))]
    const neighbors=neighborIds.length?await nodes(tx).where('user_id','=',owner).where('deleted_at','is',null).where('id','in',neighborIds).execute():[]
    const live=new Map(neighbors.map(row=>[Number(row.id),row])),related:Record<string,unknown>[]=[]
    for(const relation of relations){
      for(const id of ids){
        if(id!==Number(relation.src_node_id)&&id!==Number(relation.dst_node_id))continue
        const neighbor=live.get(id===Number(relation.src_node_id)?Number(relation.dst_node_id):Number(relation.src_node_id))
        if(neighbor)related.push({from_node_id:id,relation_id:Number(relation.id),type:relation.rel_type,status:relation.status,origin:relation.origin,note:relation.note,node:summary(neighbor)})
      }
    }
    signal?.throwIfAborted()
    const parsed=new Map(matches.map(row=>[Number(row.id),extractMindReferences(row.content_md)])),cache=new Map<string,Reference>()
    // 固定领域来源，SQL标识符不来自模型；三种来源均先校验owner与墓碑。
    for(const [type,table,label] of [['project','projects','name'],['file','files','display_name'],['event','calendar_events','title']] as const){
      const refIds=[...new Set([...parsed.values()].flatMap(refs=>refs.filter(ref=>ref.type===type).map(ref=>ref.id)))]
      if(!refIds.length)continue
      const rows=(await sql<{id:number;label:string|null}>`SELECT id,${sql.ref(label)} AS label FROM ${sql.table(table)}
        WHERE user_id=${owner} AND deleted_at IS NULL AND id IN (${sql.join(refIds)})`.execute(tx)).rows
      signal?.throwIfAborted()
      for(const row of rows)cache.set(type+':'+row.id,{ref_type:type,ref_id:Number(row.id),label:row.label})
    }
    const references=new Map<number,Reference[]>()
    for(const [id,refs] of parsed)references.set(id,refs.flatMap(ref=>{const value=cache.get(ref.type+':'+ref.id);return value?[value]:[]}))
    return {related,references}
  }
  async function read<T>(raw:string,signal:AbortSignal|undefined,work:(tx:Transaction<Database>,owner:string)=>Promise<T>):Promise<T>{
    signal?.throwIfAborted()
    const owner=ownerId(raw)
    try{return await db.transaction().execute(tx=>work(tx,owner))}finally{signal?.throwIfAborted()}
  }
  return {
    async search(raw:string,args:AgentMindSearch,signal?:AbortSignal){
      const q=strip(args.query||args.q||''),queries=normalizeGlobalSearchQueries(q,args.queries??[])
      if(!queries.length)return {error:'需要提供搜索关键词 query 或 queries'}
      const limit=Math.max(1,Math.min(args.limit??5,10))
      return read(raw,signal,async(tx,owner)=>{
        const op=backend==='postgres'?sql`ILIKE`:sql`LIKE`
        const terms=queries.map(term=>sql`(lower(title) ${op} lower(${'%'+term+'%'}) OR lower(content_plain) ${op} lower(${'%'+term+'%'}))`)
        const condition=sql<boolean>`(${sql.join(terms,args.mode==='AND'?sql` AND `:sql` OR `)})`
        const matches=await nodes(tx).where('user_id','=',owner).where('kind','in',['note','canvas_note']).where('deleted_at','is',null)
          .where(condition).orderBy('mind_nodes.captured_at','desc').limit(limit).execute()
        const {related,references}=await aggregate(tx,owner,matches,signal)
        return {query:q,count:matches.length,matches:matches.map(row=>args.include_content===true?agentMindNodeDetail(row):summary(row)),related,
          references:matches.flatMap(row=>(references.get(Number(row.id))??[]).map(reference=>({from_node_id:Number(row.id),...reference})))}
      })
    },
    async get(raw:string,id:number,signal?:AbortSignal){
      return read(raw,signal,async(tx,owner)=>{
        const node=await nodes(tx).where('user_id','=',owner).where('id','=',id).where('deleted_at','is',null).executeTakeFirst()
        if(!node)return {error:'找不到这条思维节点'}
        const {related,references}=await aggregate(tx,owner,[node],signal)
        return {node:{...agentMindNodeDetail(node),numbered_content:physicalLines(node.content_md).map((line,index)=>`${index+1}: ${lineText(line)}`).join('\n')},
          related:related.map(({from_node_id:_from,...relation})=>relation),references:references.get(Number(node.id))??[]}
      })
    },
  }
}
