import { canvasNoteDisplayTitle } from './note-create.js'
import { recommendedCanvasSides } from './canvas-layout.js'
import { strip } from '../shared/values.js'
import { normalizeGlobalSearchQueries } from '../search/query.js'
import { sql, type Kysely, type Selectable } from 'kysely'
import { dataContext } from '../contracts/index.js'
import { utc } from '../data/codec.js'
import type { Backend } from '../data/repositories.js'
import type { Database, MindNodeTable } from '../data/schema.js'

const iso = (value: unknown) => new Date(utc(value instanceof Date ? value.toISOString() : value).replace(' ', 'T')).toISOString().replace(/Z$/, '+00:00')
function object(value: unknown): Record<string, unknown> { if (typeof value === 'string') { try { value = JSON.parse(value || '{}') } catch { value = {} } } return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
export function mindNodeReadResponse(row: Selectable<MindNodeTable>) { return { id: Number(row.id), kind: row.kind, title: row.title, contentMd: row.content_md ?? '', color: row.color, capturedAt: iso(row.captured_at), version: Number(row.version), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), deletedAt: row.deleted_at === null ? null : iso(row.deleted_at), refType: row.ref_type, refId: row.ref_id === null ? null : Number(row.ref_id), refSnapshot: row.ref_snapshot === null ? null : object(row.ref_snapshot) } }
/** 面向可信 owner 的画布读取；未找到画布返回 null。 */
export function createSqlMindCanvasReader(db: Kysely<Database>, backend: Backend) {
  function ownerId(raw: string) { const owner = dataContext(raw).ownerId; return backend === 'sqlite' ? owner.replaceAll('-', '') : owner }
  async function findCanvas(owner: string, id: number) { return db.selectFrom('mind_maps').selectAll().where('id', '=', id).where('user_id', '=', owner).where('deleted_at', 'is', null).executeTakeFirst() }
  return {
    ...createAgentCanvasQueries(db,backend),
    /** RAG 重建专用投影：同一查询绑定 owner、存活画布/节点/项，并支持稳定分页。 */
    async listForRag(raw: string, options: { itemId?: number; afterId?: number; limit: number; signal?: AbortSignal }) {
      options.signal?.throwIfAborted()
      const owner = ownerId(raw)
      const itemUpdated = backend === 'postgres'
        ? sql<string>`to_char(i.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US') || '+00:00'`
        : sql<string>`i.updated_at`
      let query = db.selectFrom('mind_canvas_items as i')
        .innerJoin('mind_maps as m', join => join.onRef('m.id', '=', 'i.canvas_id').onRef('m.user_id', '=', 'i.user_id'))
        .innerJoin('mind_nodes as n', join => join.onRef('n.id', '=', 'i.node_id').onRef('n.user_id', '=', 'i.user_id'))
        .select(['i.id', 'i.canvas_id', 'i.node_id', 'i.data_json', 'm.title as canvas_title', 'm.project_id',
          'n.title as node_title', 'n.kind as node_type', 'n.content_plain', 'n.content_md', 'n.version as node_version'])
        .select(itemUpdated.as('item_updated_at'))
        .where('i.user_id', '=', owner).where('m.user_id', '=', owner).where('n.user_id', '=', owner)
        .where('i.deleted_at', 'is', null).where('m.deleted_at', 'is', null).where('n.deleted_at', 'is', null)
      if (options.itemId !== undefined) query = query.where('i.id', '=', options.itemId)
      if (options.afterId !== undefined) query = query.where('i.id', '>', options.afterId)
      const rows = await query.orderBy('i.id', 'asc').limit(options.limit).execute()
      options.signal?.throwIfAborted()
      return rows.map(row => ({ ...row, item_updated_at: utc(row.item_updated_at).replace(' ', 'T').replace(/Z$/, '+00:00') }))
    },
    /** Agent 分页查询不使用 Web 列表的 200 条截断；计数只依据画布项。 */
    async listAgentCanvases(raw: string, options: { projectId?: number | null; limit: number; offset: number; signal?: AbortSignal }) {
      options.signal?.throwIfAborted()
      const owner = ownerId(raw)
      let base = db.selectFrom('mind_maps').where('user_id', '=', owner).where('deleted_at', 'is', null)
      if (options.projectId != null) base = base.where('project_id', '=', options.projectId)
      const totalRow = await base.select(db.fn.countAll().as('total')).executeTakeFirstOrThrow()
      options.signal?.throwIfAborted()
      let page = base.selectAll().select(sql<string>`${backend === 'postgres' ? sql`to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US')` : sql`updated_at`}`.as('agent_updated_at'))
      const rows = await page.orderBy('mind_maps.updated_at', 'desc').orderBy('mind_maps.id', 'desc').limit(options.limit).offset(options.offset).execute()
      options.signal?.throwIfAborted()
      const counts = rows.length ? await db.selectFrom('mind_canvas_items').select(['canvas_id', db.fn.countAll().as('count')]).where('user_id', '=', owner).where('deleted_at', 'is', null).where('canvas_id', 'in', rows.map(row => Number(row.id))).groupBy('canvas_id').execute() : []
      options.signal?.throwIfAborted()
      const byCanvas = new Map(counts.map(row => [Number(row.canvas_id), Number(row.count)]))
      return { total: Number(totalRow.total), offset: options.offset, limit: options.limit, canvases: rows.map(row => ({
        canvas_id: Number(row.id), title: row.title, project_id: row.project_id === null ? null : Number(row.project_id),
        updated_at: utc(row.agent_updated_at).replace(' ', 'T').replace(/Z$/, '+00:00'), node_count: byCanvas.get(Number(row.id)) ?? 0, view: canvasViewSummary(row.data_json),
      })) }
    },
    async listCanvases(raw: string, projectId: number | null) {
      const owner = ownerId(raw)
      let query = db.selectFrom('mind_maps').selectAll().where('user_id', '=', owner).where('deleted_at', 'is', null)
      if (projectId !== null) query = query.where('project_id', '=', projectId)
      const rows = await query.orderBy('updated_at', 'desc').orderBy('id', 'desc').limit(200).execute()
      return rows.map(row => ({ id: Number(row.id), title: row.title, projectId: row.project_id === null ? null : Number(row.project_id), data: object(row.data_json), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) }))
    },
    async listItems(raw: string, canvasId: number) {
      const owner = ownerId(raw)
      if (!await findCanvas(owner, canvasId)) return null
      const items = await db.selectFrom('mind_canvas_items').selectAll().where('user_id', '=', owner).where('canvas_id', '=', canvasId).where('deleted_at', 'is', null).orderBy('z').orderBy('id').execute()
      if (!items.length) return []
      const nodes = await db.selectFrom('mind_nodes').selectAll().where('id', 'in', items.map(item => Number(item.node_id))).where('user_id', '=', owner).where('deleted_at', 'is', null).execute()
      const byNode = new Map(nodes.map(node => [Number(node.id), node]))
      const ids = [...new Set(nodes.filter(node => node.ref_type === 'event' && node.ref_id !== null).map(node => Number(node.ref_id)))]
      const eventRows = ids.length ? (await sql<{ id: number; date: string; time: string | null; end_time: string | null; description: string | null }>`SELECT id,date,time,end_time,description FROM calendar_events WHERE user_id=${owner} AND deleted_at IS NULL AND id IN (${sql.join(ids)})`.execute(db)).rows : []
      const events = new Map(eventRows.map(event => [Number(event.id), { date: String(event.date), time: event.time, endTime: event.end_time, description: event.description }]))
      return items.flatMap(item => { const node = byNode.get(Number(item.node_id)); if (!node) return []; return [{ id: Number(item.id), canvasId: Number(item.canvas_id), nodeId: Number(item.node_id), x: Number(item.x), y: Number(item.y), w: item.w === null ? null : Number(item.w), h: item.h === null ? null : Number(item.h), z: Number(item.z), collapsed: Boolean(item.collapsed), data: object(item.data_json), refData: node.ref_type === 'event' && node.ref_id !== null ? events.get(Number(node.ref_id)) ?? null : null, node: mindNodeReadResponse(node), createdAt: iso(item.created_at), updatedAt: iso(item.updated_at) }] })
    },
    async listRelations(raw: string, canvasId: number) {
      const owner = ownerId(raw), canvas = await findCanvas(owner, canvasId)
      if (!canvas) return null
      const detachedRaw = object(canvas.data_json).detachedRelationIds
      const detached = new Set(Array.isArray(detachedRaw) ? detachedRaw.filter((id): id is number => Number.isSafeInteger(id)) : [])
      const items = await db.selectFrom('mind_canvas_items').select('node_id').where('user_id', '=', owner).where('canvas_id', '=', canvasId).execute()
      const ids = new Set(items.map(item => Number(item.node_id)))
      const relations = await db.selectFrom('mind_relations').selectAll().where('user_id', '=', owner).where('canvas_id', '=', canvasId).where('deleted_at', 'is', null).orderBy('id').execute()
      return relations.filter(row => !detached.has(Number(row.id)) && ids.has(Number(row.src_node_id)) && ids.has(Number(row.dst_node_id))).map(row => ({ id: Number(row.id), canvasId: row.canvas_id === null ? null : Number(row.canvas_id), srcNodeId: Number(row.src_node_id), dstNodeId: Number(row.dst_node_id), relType: row.rel_type, origin: row.origin, status: row.status, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) }))
    },
    async canvasLocation(raw: string, nodeId: number) {
      const owner = ownerId(raw)
      const result = await db.selectFrom('mind_canvas_items as ci').innerJoin('mind_nodes as n', 'n.id', 'ci.node_id').innerJoin('mind_maps as mm', 'mm.id', 'ci.canvas_id').select('ci.canvas_id').where('n.id', '=', nodeId).where('n.user_id', '=', owner).where('n.kind', '=', 'canvas_note').where('n.deleted_at', 'is', null).where('ci.user_id', '=', owner).where('ci.deleted_at', 'is', null).where('mm.user_id', '=', owner).where('mm.deleted_at', 'is', null).executeTakeFirst()
      return result ? Number(result.canvas_id) : null
    },
  }
}

/** Python 数值判断包含 bool，保留其视图投影语义。 */
export function canvasViewSummary(raw: unknown) {
  const data = object(raw)
  const selectNumbers = (source: Record<string, unknown>, keys: string[]) => {
    const entries = keys.filter(key => typeof source[key] === 'number' || typeof source[key] === 'boolean').map(key => [key, source[key]])
    return entries.length ? Object.fromEntries(entries) : null
  }
  return { camera: selectNumbers(data, ['x', 'y', 'scale']), viewport: selectNumbers(object(data.viewport), ['width', 'height']), last_viewed_at: typeof data.last_viewed_at === 'string' ? data.last_viewed_at : null }
}

export interface AgentCanvasOptions {canvas_id:number;include_nodes?:boolean;include_relations?:boolean;include_content?:boolean;limit?:number;offset?:number;query?:string;q?:string;queries?:string[];types?:string[];mode?:'OR'|'AND'}
type CanvasRow=Record<string,unknown>
export function agentCanvasNodeFields(row: CanvasRow) {
 return {node_id:Number(row.id),kind:row.kind,title:row.kind==='canvas_note'?canvasNoteDisplayTitle(row):row.title,ref_type:row.ref_type,ref_id:row.ref_type==='file'?object(row.ref_snapshot).fileReferenceId??null:row.ref_id,
  preview:[...strip(String(row.content_plain??''))].slice(0,240).join('')}
}
export function agentCanvasNodeSummary(row:CanvasRow,content=false){
 const defaults:Record<string,[number,number]>={canvas_note:[240,140],project:[240,120],file:[156,140],event:[220,96]}
 const [w,h]=defaults[row.kind==='canvas_note'?'canvas_note':String(row.ref_type)]??defaults.event!
 return {...agentCanvasNodeFields(row),item_id:Number(row.item_id),
  position:{x:Number(row.x),y:Number(row.y)},size:{w:row.w,h:row.h},
  layout:{effective_size:{w:row.w==null?w:Number(row.w),h:row.h==null?h:Number(row.h)},default_size:{w,h},
   size_source:row.w!=null||row.h!=null?'explicit':'default',recommended_gap:150,recommended_center_distance:750},
  collapsed:Boolean(row.collapsed),z:Number(row.z),...(content?{content_md:row.content_md,content_plain:row.content_plain}:{})}
}
function anchor(data:Record<string,unknown>,id:number){
 if(data.relationAnchors!==undefined&&(data.relationAnchors===null||typeof data.relationAnchors!=='object'||Array.isArray(data.relationAnchors)))throw new Error('画布关系端点数据无效')
 const raw=object(data.relationAnchors)[String(id)],saved=object(raw)
 return ['left','right'].includes(String(saved.srcSide))&&['left','right'].includes(String(saved.dstSide))
  ?{source_side:String(saved.srcSide),target_side:String(saved.dstSide)}:null
}
function audit(relation:CanvasRow,nodes:Map<number,ReturnType<typeof agentCanvasNodeSummary>>,data:Record<string,unknown>){
 const id=Number(relation.id),sourceId=Number(relation.src_node_id),targetId=Number(relation.dst_node_id)
 const current=anchor(data,id),base={relation_id:id,source_node_id:sourceId,target_node_id:targetId,current:current??{source_side:null,target_side:null}}
 const source=nodes.get(sourceId),target=nodes.get(targetId)
 if(!source||!target)return {...base,status:'incomplete',reason:'关系两端没有同时出现在本次快照中'}
 const sx=source.position.x,tx=target.position.x,sw=source.layout.effective_size.w,tw=target.layout.effective_size.w
 const sides=recommendedCanvasSides({x:sx,w:sw},{x:tx,w:tw})
 const recommended={source_side:sides[0]!,target_side:sides[1]!}
 const status=!current?'implicit':current.source_side===recommended.source_side&&current.target_side===recommended.target_side?'aligned':'custom'
 return {...base,source:{node_id:sourceId,center:{x:sx+sw/2,y:source.position.y+source.layout.effective_size.h/2}},
  target:{node_id:targetId,center:{x:tx+tw/2,y:target.position.y+target.layout.effective_size.h/2}},recommended,status,
  ...(status==='custom'?{reason:'当前端点与按卡片水平投影计算的默认端点不同，可能是有意的回环布局'}:{})}
}
/** Agent完整快照与搜索；关系独立分页，搜索保留Python limit+1探测和已删项历史语义。 */
export function createAgentCanvasQueries(db:Kysely<Database>,backend:Backend){
 const owner=(raw:string)=>{const id=dataContext(raw).ownerId;return backend==='sqlite'?id.replaceAll('-',''):id}
 function rows(user:string,id:number,liveItems:boolean){
  let query=db.selectFrom('mind_canvas_items as i').innerJoin('mind_nodes as n','n.id','i.node_id')
   .selectAll('n').select(['i.id as item_id','i.x','i.y','i.w','i.h','i.z','i.collapsed'])
   .where('i.canvas_id','=',id).where('i.user_id','=',user).where('n.user_id','=',user).where('n.deleted_at','is',null)
  if(liveItems)query=query.where('i.deleted_at','is',null)
  return query
 }
 async function canvas(user:string,id:number){
  const stamp=(field:string)=>sql.raw<string>(backend==='postgres'?"to_char("+field+" AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US')":field)
  return db.selectFrom('mind_maps').selectAll().select([stamp('created_at').as('agent_created'),stamp('updated_at').as('agent_updated')])
   .where('id','=',id).where('user_id','=',user).where('deleted_at','is',null).executeTakeFirst()
 }
 async function read<T>(signal:AbortSignal|undefined,work:()=>Promise<T>){signal?.throwIfAborted();try{return await work()}finally{signal?.throwIfAborted()}}
 return {
  async getAgentCanvasFocus(raw:string,args:{canvas_id:number;item_id:number},signal?:AbortSignal){
   return read(signal,async()=>{
    const user=owner(raw);if(!await canvas(user,args.canvas_id))return {error:'画布不存在'};signal?.throwIfAborted()
    const item=await rows(user,args.canvas_id,true).clearSelect().select(['n.id','n.kind','n.title','n.content_md','n.content_plain','i.id as item_id'])
     .where('i.id','=',args.item_id).where(eb=>eb.or([eb('n.kind','=','canvas_note'),eb.and([eb('n.kind','=','ref'),eb('n.ref_type','in',['project','file','event'])])])).executeTakeFirst()
    return item?{canvas_id:args.canvas_id,item_id:Number(item.item_id),node_id:Number(item.id),title:item.kind==='canvas_note'?canvasNoteDisplayTitle(item):item.title,
     focus_link:'gugu://focus-canvas/'+args.canvas_id+'/'+item.id}:{error:'画布节点不存在'}
   })
  },
  async getAgentCanvas(raw:string,args:AgentCanvasOptions,signal?:AbortSignal){
   return read(signal,async()=>{
    const user=owner(raw),found=await canvas(user,args.canvas_id);signal?.throwIfAborted()
    if(!found)return {error:'画布不存在'}
    const limit=args.limit??20,offset=args.offset??0,data=object(found.data_json)
    const result:Record<string,unknown>={canvas:{canvas_id:Number(found.id),title:found.title,project_id:found.project_id,
     created_at:utc(found.agent_created).replace(' ','T'),updated_at:utc(found.agent_updated).replace(' ','T'),view:canvasViewSummary(found.data_json)}}
    let visible:CanvasRow[]=[]
    if(args.include_nodes!==false){
     const base=rows(user,args.canvas_id,true).where('n.kind','in',['canvas_note','ref'])
     const count=await base.clearSelect().select(db.fn.countAll().as('total')).executeTakeFirstOrThrow();signal?.throwIfAborted()
     visible=await base.orderBy('i.z').orderBy('i.id').limit(limit).offset(offset).execute();signal?.throwIfAborted()
     result.nodes=visible.map(row=>agentCanvasNodeSummary(row,args.include_content===true))
     result.pagination={offset,limit,total:Number(count.total),next_offset:offset+visible.length<Number(count.total)?offset+limit:null}
     result.truncated=offset+visible.length<Number(count.total)
    }
    if(args.include_relations!==false){
     const ids=db.selectFrom('mind_canvas_items').select('node_id').where('canvas_id','=',args.canvas_id).where('user_id','=',user)
     let query=db.selectFrom('mind_relations').selectAll().where('user_id','=',user).where('canvas_id','=',args.canvas_id)
      .where('src_node_id','in',ids).where('dst_node_id','in',ids).where('deleted_at','is',null)
     const detached=Array.isArray(data.detachedRelationIds)?data.detachedRelationIds.filter((id):id is number=>Number.isSafeInteger(id)):[]
     if(detached.length)query=query.where('id','not in',detached)
     const relations=await query.orderBy('id').execute();signal?.throwIfAborted()
     let geometry=visible
     if(args.include_nodes===false){
      const endpoints=[...new Set(relations.flatMap(row=>[Number(row.src_node_id),Number(row.dst_node_id)]))]
      // 关系模式只查询几何与类型，不读取正文。
      geometry=endpoints.length?await rows(user,args.canvas_id,true).clearSelect().select(['n.id','n.kind','n.ref_type','i.id as item_id','i.x','i.y','i.w','i.h','i.z','i.collapsed'])
       .where('n.kind','in',['canvas_note','ref']).where('n.id','in',endpoints).execute():[]
      signal?.throwIfAborted()
     }
     const byId=new Map(geometry.map(row=>[Number(row.id),agentCanvasNodeSummary(row)]))
     Object.assign(result,{relation_scope:'canvas',relation_audit_scope:args.include_nodes===false?'relation_endpoints':'visible_nodes',relation_count:relations.length,
      relations:relations.map(row=>({relation_id:Number(row.id),source_node_id:Number(row.src_node_id),target_node_id:Number(row.dst_node_id),type:row.rel_type,status:row.status,...anchor(data,Number(row.id))})),
      relation_audit:relations.map(row=>audit(row,byId,data))})
    }
    return result
   })
  },
  async searchAgentCanvas(raw:string,args:AgentCanvasOptions,signal?:AbortSignal){
   return read(signal,async()=>{
    const user=owner(raw);if(!await canvas(user,args.canvas_id))return {error:'画布不存在'};signal?.throwIfAborted()
    const q=strip(args.query||args.q||''),terms=normalizeGlobalSearchQueries(q,args.queries??[]),limit=args.limit??10
    const selected=args.types?.length?args.types:['canvas_note','project','file','event']
    let query=rows(user,args.canvas_id,false).where(eb=>eb.or([
     ...(selected.includes('canvas_note')?[eb('n.kind','=','canvas_note')]:[]),
     ...(selected.some(type=>['project','file','event'].includes(type))?[eb.and([eb('n.kind','=','ref'),eb('n.ref_type','in',selected.filter(type=>['project','file','event'].includes(type)))])]:[]),
    ]))
    if(terms.length)query=query.where(eb=>{
     const conditions=terms.map(term=>eb.or(['n.title','n.content_plain'].map(column=>backend==='postgres'
      ?eb(column as 'n.title','ilike','%'+term+'%')
      :eb(eb.fn<string>('lower',[column as 'n.title']),'like',eb.fn<string>('lower',[eb.val('%'+term+'%')])))))
     return args.mode==='AND'?eb.and(conditions):eb.or(conditions)
    })
    const matches=await query.orderBy('i.z','desc').orderBy('i.id','desc').limit(limit+1).execute()
    return {canvas_id:args.canvas_id,query:q,queries:terms,count:matches.length,matches:matches.slice(0,limit).map(row=>agentCanvasNodeSummary(row,args.include_content===true)),truncated:matches.length>limit}
   })
  },
 }
}

export interface AgentPlaceableSearchOptions {
  query?: string; q?: string; queries?: string[]; types?: Array<'project' | 'file' | 'event'>
  canvas_id?: number; mode?: 'OR' | 'AND'; limit?: number; offset?: number
}
/** 项目和活动从领域表读取，文件列表由宿主从授权文件树读取。 */
export function createAgentPlaceableSearch(db: Kysely<Database>, backend: Backend,
  searchFiles?: (owner: string, query: string, limit: number, signal: AbortSignal) => Promise<readonly { id: string; label: string }[]>) {
  return async (raw: string, args: AgentPlaceableSearchOptions, signal: AbortSignal) => {
    signal.throwIfAborted()
    const canonical = dataContext(raw).ownerId, owner = backend === 'sqlite' ? canonical.replaceAll('-', '') : canonical
    const terms = normalizeGlobalSearchQueries(strip(args.query || args.q || ''), args.queries ?? [])
    if (!terms.length) return { error: '需要提供搜索关键词 query 或 queries' }
    const selected = args.types?.length ? args.types : ['project', 'file', 'event']
    const offset = args.offset ?? 0, limit = args.limit ?? 10, probe = offset + limit + 1
    if (args.canvas_id !== undefined) {
      const canvas = await db.selectFrom('mind_maps').select('id').where('user_id', '=', owner).where('id', '=', args.canvas_id).where('deleted_at', 'is', null).executeTakeFirst()
      signal.throwIfAborted()
      if (!canvas) return { error: '画布不存在' }
    }
    const refs = await db.selectFrom('mind_nodes').select(['id', 'ref_type', 'ref_id', 'ref_snapshot']).where('user_id', '=', owner).where('kind', '=', 'ref').where('deleted_at', 'is', null).where('ref_type', 'in', selected).execute()
    signal.throwIfAborted()
    // Python 的已放置标记包含项/引用的墓碑，但始终保持双方 owner 一致。
    const items = args.canvas_id === undefined ? [] : await db.selectFrom('mind_canvas_items as i').innerJoin('mind_nodes as n', 'n.id', 'i.node_id')
      .select(['i.id', 'n.ref_type', 'n.ref_id', 'n.ref_snapshot']).where('i.canvas_id', '=', args.canvas_id).where('i.user_id', '=', owner).where('n.user_id', '=', owner).where('n.kind', '=', 'ref').execute()
    signal.throwIfAborted()
    const key = (row: { ref_type: string | null; ref_id: number | null; ref_snapshot: unknown }) =>
      `${row.ref_type}:${row.ref_type === 'file' ? object(row.ref_snapshot).fileReferenceId : row.ref_id}`
    const byRef = new Map(refs.map(row => [key(row), Number(row.id)])), byItem = new Map(items.map(row => [key(row), Number(row.id)]))
    const matches: Record<string, unknown>[] = []
    const sources = [
      { type: 'project', table: 'projects', title: 'name', fields: ['name', 'contact_name'], order: 'updated_at' },
      { type: 'file' },
      { type: 'event', table: 'calendar_events', title: 'title', fields: ['title', 'description', 'contact_name'], order: 'created_at' },
    ] as const
    try {
      for (const source of sources) {
        if (!selected.includes(source.type) || matches.length >= probe) continue
        if (source.type === 'file') {
          if (!searchFiles) continue
          const lists = await Promise.all(terms.map(term => searchFiles(canonical, term, probe, signal)))
          const files = new Map(lists.flat().map(file => [file.id, file]))
          for (const file of files.values()) {
            if (matches.length >= probe) break
            if (args.mode === 'AND' && !lists.every(list => list.some(entry => entry.id === file.id))) continue
            const entryKey = `file:${file.id}`
            matches.push({ kind: 'ref', ref_type: 'file', ref_id: file.id, title: file.label,
              node_id: byRef.get(entryKey) ?? null, already_placed: byItem.has(entryKey), canvas_item_id: byItem.get(entryKey) ?? null })
          }
          continue
        }
        const conditions = terms.map(term => sql`(${sql.join(source.fields.map(column => backend === 'postgres'
          ? sql`${sql.ref(column)} ILIKE ${'%' + term + '%'}`
          : sql`lower(${sql.ref(column)}) LIKE lower(${'%' + term + '%'})`), sql` OR `)})`)
        const result = await sql<{ id: number; title: string }>`SELECT id,${sql.ref(source.title)} AS title FROM ${sql.table(source.table)} WHERE user_id=${owner} AND deleted_at IS NULL AND (${sql.join(conditions, args.mode === 'AND' ? sql` AND ` : sql` OR `)}) ORDER BY ${sql.ref(source.order)} DESC LIMIT ${probe}`.execute(db)
        signal.throwIfAborted()
        for (const row of result.rows) {
          const id = Number(row.id), entryKey = `${source.type}:${id}`
          matches.push({ kind: 'ref', ref_type: source.type, ref_id: id, title: row.title, node_id: byRef.get(entryKey) ?? null, already_placed: byItem.has(entryKey), canvas_item_id: byItem.get(entryKey) ?? null })
        }
      }
      return { queries: terms, count: matches.length, matches: matches.slice(offset, offset + limit), offset, limit, truncated: matches.length > offset + limit }
    } finally { signal.throwIfAborted() }
  }
}
