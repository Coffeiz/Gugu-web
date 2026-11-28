import { MindNoteContentError, replaceUniqueMindText } from './note-content.js'
import { noteColorValue, type NoteColorKey } from './note-colors.js'
import { createMindCanvasRelationCreate, type MindRelationCreateRuntime } from './relation-create.js'
import { createSqlMindCanvasRelationCreateRuntime } from './relation-create-sql.js'
import { recommendedCanvasSides } from './canvas-layout.js'
import type { CanvasItemAddRuntime } from './canvas-item-add.js'
import { applyCanvasPlacements, resolveCanvasEditPosition, type CanvasPlacementIntent, type ResolveCanvasFileReference } from './canvas-placement.js'
import { createMindCanvasUpdate } from './canvas-update.js'
import { createSqlMindCanvasUpdateRuntime } from './canvas-update-sql.js'
import { parseCanvasData } from './canvas-layout.js'
import type { MindRefNodeChangedEvent } from './ref-node-create.js'
import type { MindCanvasUpdateRuntime } from './canvas-update.js'
import type { Transaction } from 'kysely'
import { dataContext } from '../contracts/index.js'
import type { Database } from '../data/schema.js'
import type { Backend } from '../data/repositories.js'
import { strip } from '../shared/values.js'
import { agentCanvasNodeSummary, agentCanvasNodeFields } from './canvas-read.js'
import { createSqlMindCanvasItemUpdateRuntime } from './canvas-item-update-sql.js'
import { createSqlMindCanvasItemRemoveRuntime } from './canvas-item-remove-sql.js'
import { MindCanvasItemMutationError } from './canvas-item-remove.js'
import { createSqlMindCanvasNoteRuntime } from './canvas-note-sql.js'
import { MindCanvasNoteMutationError, type MindCanvasNoteMutationEvent } from './canvas-note.js'
import { MindRefNodeCreateError } from './ref-node-create.js'
import { MindCanvasRelationMutationError } from './relation-delete-global.js'
import type { CanvasItemUpdateRuntime } from './canvas-item-update.js'
import type { MindCanvasItemRemoveRuntime } from './canvas-item-remove.js'

export interface CanvasLayoutEdit { item_id: number; x?: number; y?: number; z?: number; collapsed?: boolean; width?: number; height?: number; position?: CanvasBatchOperation['position'] }
export interface CanvasNoteEdit {
  node_id: number
  title?: string
  content?: string
  color?: NoteColorKey
  expected_version?: number
  find_replace?: { find: string; replace: string }
}
export interface CanvasBatchOperation {
  kind: 'create_note'|'add_node'|'update_item'|'remove_item'|'delete_note'|'connect'
  ref_type?: 'project'|'file'|'event'; ref_id?: number | string; node_id?: number
  item_id?: number; source_node_id?: number; target_node_id?: number
  source_side?: 'left'|'right'; target_side?: 'left'|'right'
  title?: string; content?: string; color?: NoteColorKey
  x?: number; y?: number; width?: number; height?: number; z?: number; collapsed?: boolean
  position?: import('./canvas-layout.js').CanvasPosition
  [key:string]:unknown
}
export interface CanvasBatchIntent { canvas_id:number; request_id:string; operations:CanvasBatchOperation[] }
export type CanvasEditIntent = CanvasPlacementIntent
  | {action:'delete_note';canvas_id:number;node_ids:number[];batched:boolean}
  | {action:'connect';canvas_id:number;source_node_id:number;target_node_id:number;source_side?:'left'|'right';target_side?:'left'|'right';allow_custom_anchor?:boolean;batched:false}
  | {action:'anchor';canvas_id:number;relation_id:number;source_side:'left'|'right';target_side:'left'|'right';batched:false}
  | { action:'layout'; canvas_id:number; entries:CanvasLayoutEdit[]; batched:boolean }
  | { action:'remove'; canvas_id:number; item_ids:number[]; batched:boolean }
  | { action:'note'; entries:CanvasNoteEdit[]; batched:boolean }
export type CanvasEditPublication = Parameters<MindRelationCreateRuntime['publishChanged']>[0] | Parameters<CanvasItemAddRuntime['publishChanged']>[0] | Parameters<CanvasItemUpdateRuntime['publishChanged']>[0] | Parameters<MindCanvasItemRemoveRuntime['publishChanged']>[0] | MindCanvasNoteMutationEvent | MindRefNodeChangedEvent | Parameters<MindCanvasUpdateRuntime['publishChanged']>[0]

interface EditContext {
  tx: Transaction<Database>; backend: Backend; owner: string; canonical: string; context: string; signal: AbortSignal; resolveFileReference?: ResolveCanvasFileReference
}
interface EditResult { results: Record<string,unknown>[]; publications: CanvasEditPublication[]; changed: boolean }
async function readItem(ctx:EditContext,id:number,canvasId:number) {
  const row=await ctx.tx.selectFrom('mind_canvas_items as i').innerJoin('mind_nodes as n','n.id','i.node_id').selectAll('n')
    .select(['i.id as item_id','i.x','i.y','i.w','i.h','i.z','i.collapsed']).where('i.id','=',id).where('i.canvas_id','=',canvasId)
    .where('i.user_id','=',ctx.owner).where('n.user_id','=',ctx.owner).where('i.deleted_at','is',null).executeTakeFirst()
  ctx.signal.throwIfAborted()
  if(!row)throw new MindCanvasItemMutationError('画布节点不存在',404)
  return row
}
async function removeItems(ctx:EditContext,intent:Extract<CanvasEditIntent,{action:'remove'}>):Promise<EditResult> {
  const runtime=createSqlMindCanvasItemRemoveRuntime(ctx.tx,ctx.backend,async()=>{},undefined,undefined,{includeDeletedNodes:true})
  const result:EditResult={results:[],publications:[],changed:false}
  for(const id of intent.item_ids) {
    const before=await readItem(ctx,id,intent.canvas_id)
    await runtime.remove(ctx.canonical,intent.canvas_id,id,ctx.context)
    ctx.signal.throwIfAborted()
    result.changed=true
    result.publications.push({ownerId:ctx.canonical,operation:'delete',entityId:id,origin:null,mutationId:null,entity:{id,canvas_id:intent.canvas_id}})
    result.results.push({canvas_id:intent.canvas_id,removed_item_id:id,node_id:Number(before.id),node_preserved:true})
  }
  return result
}
function layoutInput(edit:CanvasLayoutEdit,kind:string) {
  const raw=edit as unknown as Record<string,unknown>,legacyPosition=raw.position
  if ('w' in raw || 'h' in raw || (legacyPosition && typeof legacyPosition==='object' && ('w' in legacyPosition || 'h' in legacyPosition)))
    throw new MindCanvasItemMutationError('请使用 width 和 height 设置画布便签大小',422)
  if(kind!=='canvas_note'&&(edit.width!==undefined||edit.height!==undefined))throw new MindCanvasItemMutationError('只有画布便签支持设置卡片大小',422)
  const {item_id,width,height,position: _anchor,...position}=edit
  return {...position,...(width===undefined?{}:{w:width}),...(height===undefined?{}:{h:height})}
}
async function updateItems(ctx:EditContext,intent:Extract<CanvasEditIntent,{action:'layout'}>):Promise<EditResult> {
  const runtime=createSqlMindCanvasItemUpdateRuntime(ctx.tx,ctx.backend,async()=>{},undefined,undefined,{includeDeletedNodes:true})
  const result:EditResult={results:[],publications:[],changed:false}
  for(const edit of intent.entries) {
    const before=await readItem(ctx,edit.item_id,intent.canvas_id)
    const input=layoutInput(edit,before.kind)
    if(edit.position){
      if(edit.x!==undefined||edit.y!==undefined)throw new MindCanvasItemMutationError('请只提供 x/y 或 position 其中一种位置写法',422)
      if(edit.position.x===undefined&&edit.position.y===undefined&&edit.position.anchor===undefined)
        throw new MindCanvasItemMutationError('position 必须提供 x/y 或 anchor',422)
      const [x,y]=await resolveCanvasEditPosition(ctx,intent.canvas_id,edit.position)
      Object.assign(input,{x,y})
    }
    const updated=await runtime.update(ctx.canonical,intent.canvas_id,edit.item_id,input,ctx.context)
    ctx.signal.throwIfAborted()
    result.changed ||= Object.entries(input).some(([field,value]) => {
      const previous=(before as unknown as Record<string,unknown>)[field]
      if(field==='collapsed')return Boolean(previous)!==Boolean(value)
      if(value===null||previous===null)return previous!==value
      return value!==undefined&&Number(previous)!==Number(value)
    })
    const after=await readItem(ctx,edit.item_id,intent.canvas_id)
    result.publications.push({ownerId:ctx.canonical,operation:'update',entityId:edit.item_id,origin:null,mutationId:null,entity:updated})
    result.results.push({canvas_id:intent.canvas_id,node:agentCanvasNodeSummary(after),updated:true})
  }
  return result
}
async function updateNotes(ctx:EditContext,intent:Extract<CanvasEditIntent,{action:'note'}>):Promise<EditResult> {
  const runtime=createSqlMindCanvasNoteRuntime(ctx.tx,ctx.backend,async()=>{})
  const result:EditResult={results:[],publications:[],changed:false}
  for(const edit of intent.entries) {
    let query=ctx.tx.selectFrom('mind_nodes').selectAll().where('id','=',edit.node_id).where('user_id','=',ctx.owner).where('kind','=','canvas_note').where('deleted_at','is',null)
    if(ctx.backend==='postgres')query=query.forUpdate()
    const before=await query.executeTakeFirst();ctx.signal.throwIfAborted()
    if(!before)throw new MindCanvasNoteMutationError('找不到这条画布便签',404)
    const version = Number(before.version)
    if (edit.expected_version !== undefined && edit.expected_version !== version)
      throw new MindCanvasNoteMutationError('画布便签版本已变化，请重新读取后再修改', 409)
    let content = edit.content
    if (edit.find_replace) {
      try {
        content = replaceUniqueMindText(before.content_md ?? '', edit.find_replace.find, edit.find_replace.replace)
      } catch (error) {
        if (error instanceof MindNoteContentError) throw new MindCanvasNoteMutationError(error.message, 422)
        throw error
      }
    }
    const updated=await runtime.update(ctx.canonical,edit.node_id,{version,
      ...(edit.title===undefined?{}:{title:strip(edit.title)||'新便签'}),...(content===undefined?{}:{contentMd:content}),...(edit.color===undefined?{}:{color:noteColorValue(edit.color)})},ctx.context)
    ctx.signal.throwIfAborted()
    result.changed ||= updated.changed
    const row=await ctx.tx.selectFrom('mind_nodes').selectAll().where('id','=',edit.node_id).where('user_id','=',ctx.owner).executeTakeFirstOrThrow()
    result.results.push({node:agentCanvasNodeFields(row),updated:true})
    result.publications.push({ownerId:ctx.canonical,operation:'update',entityId:edit.node_id,origin:null,mutationId:null,entityKind:'canvas_note',entity:updated.note})
  }
  return result
}
async function deleteNotes(ctx:EditContext,intent:Extract<CanvasEditIntent,{action:'delete_note'}>):Promise<EditResult>{
  const runtime=createSqlMindCanvasNoteRuntime(ctx.tx,ctx.backend,async()=>{})
  const remove=runtime.delete
  if(!remove)throw new MindCanvasNoteMutationError('画布便签删除不可用',422)
  const result:EditResult={results:[],publications:[],changed:false}
  for(const nodeId of intent.node_ids){
    const note=await remove(ctx.canonical,nodeId,ctx.context)
    ctx.signal.throwIfAborted()
    result.changed=true
    result.results.push({deleted_node_id:nodeId,can_restore:true})
    result.publications.push({ownerId:ctx.canonical,operation:'delete',entityId:nodeId,origin:null,mutationId:null,entityKind:'canvas_note',entity:note})
  }
  return result
}
async function updateAnchor(ctx:EditContext,intent:Extract<CanvasEditIntent,{action:'anchor'}>):Promise<EditResult> {
  const relation=await ctx.tx.selectFrom('mind_relations').selectAll().where('id','=',intent.relation_id).where('canvas_id','=',intent.canvas_id).where('user_id','=',ctx.owner).where('deleted_at','is',null).executeTakeFirst()
  ctx.signal.throwIfAborted()
  if(!relation)throw new MindCanvasItemMutationError('关联不存在',404)
  let query=ctx.tx.selectFrom('mind_maps').select('data_json').where('id','=',intent.canvas_id).where('user_id','=',ctx.owner).where('deleted_at','is',null)
  if(ctx.backend==='postgres')query=query.forUpdate()
  const canvas=await query.executeTakeFirst()
  const ids=[Number(relation.src_node_id),Number(relation.dst_node_id)]
  // 旧版端点编辑按画布项存在判断，包含已移除项，不扩大到其他owner。
  const items=await ctx.tx.selectFrom('mind_canvas_items').select('node_id').where('user_id','=',ctx.owner).where('canvas_id','=',intent.canvas_id).where('node_id','in',ids).execute()
  ctx.signal.throwIfAborted()
  if(!canvas||new Set(items.map(row=>Number(row.node_id))).size!==new Set(ids).size)throw new MindCanvasItemMutationError('关联的两个节点必须都位于指定画布',422)
  const data=parseCanvasData(canvas.data_json),raw=data.relationAnchors
  const anchors=raw&&typeof raw==='object'&&!Array.isArray(raw)?raw as Record<string,unknown>:{}
  const previous=savedAnchor(data,intent.relation_id)
  anchors[String(relation.id)]={srcSide:intent.source_side,dstSide:intent.target_side};data.relationAnchors=anchors
  const publications:CanvasEditPublication[]=[]
  const update=createMindCanvasUpdate(createSqlMindCanvasUpdateRuntime(ctx.tx,ctx.backend,async event=>{publications.push(event)}))
  await update(ctx.canonical,intent.canvas_id,{data},{undoContextId:ctx.context,clientId:null})
  ctx.signal.throwIfAborted()
  return {results:[{relation_id:Number(relation.id),source_node_id:ids[0],target_node_id:ids[1],source_side:intent.source_side,target_side:intent.target_side,updated:true}],publications,changed:previous?.source_side!==intent.source_side||previous?.target_side!==intent.target_side}
}
function savedAnchor(data:Record<string,unknown>,id:number) {
  const anchors=data.relationAnchors
  if(anchors!==undefined&&(!anchors||typeof anchors!=='object'||Array.isArray(anchors)))throw new MindCanvasItemMutationError('画布关系端点数据无效',422)
  const raw=(anchors as Record<string,unknown>|undefined)?.[String(id)]
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return null
  const value=raw as Record<string,unknown>
  return ['left','right'].includes(String(value.srcSide))&&['left','right'].includes(String(value.dstSide))?{source_side:value.srcSide,target_side:value.dstSide}:null
}
async function connectItems(ctx:EditContext,intent:Extract<CanvasEditIntent,{action:'connect'}>):Promise<EditResult> {
  if(intent.source_node_id===intent.target_node_id)throw new MindCanvasItemMutationError('节点不能连向自己',422)
  if((intent.source_side===undefined)!==(intent.target_side===undefined))throw new MindCanvasItemMutationError('source_side 和 target_side 必须同时提供',422)
  const ids=[intent.source_node_id,intent.target_node_id]
  const items=await ctx.tx.selectFrom('mind_canvas_items').select(['id','node_id']).where('canvas_id','=',intent.canvas_id).where('user_id','=',ctx.owner).where('node_id','in',ids).where('deleted_at','is',null).execute()
  if(new Set(items.map(row=>Number(row.node_id))).size!==2)throw new MindCanvasItemMutationError('两个节点都必须已经放在同一张画布上',422)
  const nodes=await ctx.tx.selectFrom('mind_nodes').select(['id','kind']).where('id','in',ids).where('user_id','=',ctx.owner).where('deleted_at','is',null).where('kind','in',['canvas_note','ref']).execute()
  if(nodes.length!==2)throw new MindCanvasItemMutationError('只能连接画布便签或业务引用节点',422)
  ctx.signal.throwIfAborted()
  const source=agentCanvasNodeSummary(await readItem(ctx,Number(items.find(row=>Number(row.node_id)===ids[0])!.id),intent.canvas_id))
  const target=agentCanvasNodeSummary(await readItem(ctx,Number(items.find(row=>Number(row.node_id)===ids[1])!.id),intent.canvas_id))
  const sides=recommendedCanvasSides({x:source.position.x,w:source.layout.effective_size.w},{x:target.position.x,w:target.layout.effective_size.w})
  if(intent.source_side!==undefined&&(intent.source_side!==sides[0]||intent.target_side!==sides[1])&&intent.allow_custom_anchor!==true)
    throw new MindCanvasItemMutationError('普通连接的端点与卡片左右位置不一致，请省略 source_side/target_side；只有明确的回环或自定义布局才可传 allow_custom_anchor=true',422)
  const edgeSource=Math.min(intent.source_node_id,intent.target_node_id),edgeTarget=Math.max(intent.source_node_id,intent.target_node_id)
  const existing=await ctx.tx.selectFrom('mind_relations').select(['id','deleted_at']).where('user_id','=',ctx.owner).where('canvas_id','=',intent.canvas_id).where('src_node_id','=',edgeSource).where('dst_node_id','=',edgeTarget).where('rel_type','=','related').where('edge_key','=','').executeTakeFirst()
  ctx.signal.throwIfAborted()
  const publications:CanvasEditPublication[]=[]
  const create=createMindCanvasRelationCreate(createSqlMindCanvasRelationCreateRuntime(ctx.tx,ctx.backend,async event=>{publications.push(event)}))
  const relation=await create(ctx.canonical,{canvas_id:intent.canvas_id,src_node_id:ids[0],dst_node_id:ids[1]},{undoContextId:ctx.context,clientId:null,mutationId:null})
  const canvas=await ctx.tx.selectFrom('mind_maps').select('data_json').where('id','=',intent.canvas_id).where('user_id','=',ctx.owner).executeTakeFirstOrThrow()
  const before=savedAnchor(parseCanvasData(canvas.data_json),relation.id)
  const sourceSide=intent.source_side??sides[0],targetSide=intent.target_side??sides[1]
  const normalized=relation.srcNodeId===ids[0]?[sourceSide,targetSide]:[targetSide,sourceSide]
  const anchor=await updateAnchor(ctx,{action:'anchor',canvas_id:intent.canvas_id,relation_id:relation.id,source_side:normalized[0]!,target_side:normalized[1]!,batched:false})
  publications.push(...anchor.publications)
  const after={source_side:normalized[0]!,target_side:normalized[1]!}
  return {results:[{relation_id:relation.id,source_node_id:relation.srcNodeId,target_node_id:relation.dstNodeId,type:relation.relType,created_or_reused:true,
    changed:before?.source_side!==after.source_side||before?.target_side!==after.target_side,anchor_source:intent.source_side===undefined?'geometry':'explicit',
    verification:{checked_node_ids:ids,checked_relation_id:relation.id,geometry_recommendation:{source_side:sides[0],target_side:sides[1]}},...after}],publications,
    changed:!existing||existing.deleted_at!==null||before?.source_side!==after.source_side||before?.target_side!==after.target_side}
}
/** 批量编辑复用同一外层事务的领域写服务，失败整批回滚；通知由调用方提交后发送。 */
export async function applyCanvasEdits(tx: Transaction<Database>, backend: Backend, rawOwner: string, intent: CanvasEditIntent, context: string, signal: AbortSignal, resolveFileReference?: ResolveCanvasFileReference) {
  const canonical=dataContext(rawOwner).ownerId,owner=backend==='sqlite'?canonical.replaceAll('-',''):canonical
  const ctx:EditContext={tx,backend,owner,canonical,context,signal,resolveFileReference}
  signal.throwIfAborted()
  if(intent.action!=='note'&&intent.action!=='anchor'&&intent.action!=='delete_note') {
    let query=tx.selectFrom('mind_maps').select('id').where('id','=',intent.canvas_id).where('user_id','=',owner).where('deleted_at','is',null)
    if(backend==='postgres')query=query.forUpdate()
    if(!await query.executeTakeFirst())throw new MindCanvasItemMutationError('画布不存在',404)
    signal.throwIfAborted()
  }
  const operations={layout:()=>updateItems(ctx,intent as Extract<CanvasEditIntent,{action:'layout'}>),remove:()=>removeItems(ctx,intent as Extract<CanvasEditIntent,{action:'remove'}>),delete_note:()=>deleteNotes(ctx,intent as Extract<CanvasEditIntent,{action:'delete_note'}>),
    note:()=>updateNotes(ctx,intent as Extract<CanvasEditIntent,{action:'note'}>),connect:()=>connectItems(ctx,intent as Extract<CanvasEditIntent,{action:'connect'}>),anchor:()=>updateAnchor(ctx,intent as Extract<CanvasEditIntent,{action:'anchor'}>),
    create_note:()=>applyCanvasPlacements(ctx,intent as CanvasPlacementIntent),add:()=>applyCanvasPlacements(ctx,intent as CanvasPlacementIntent)}
  const result=await operations[intent.action]()
  signal.throwIfAborted()
  const changed= 'changed' in result ? result.changed : undefined
  const mutated:boolean=typeof changed==='boolean'?changed:result.results.some(row=>row.created===true)
  const value=intent.batched?{...(intent.action==='note'||intent.action==='delete_note'?{}:{canvas_id:intent.canvas_id}),results:result.results,count:result.results.length}:result.results[0]!
  return {value,publications:result.publications,mutated}
}

/** 批处理按旧 Python 顺序在同一外层事务中复用 Mind 用例；失败由调用方回滚整批。 */
export async function applyCanvasEditBatch(tx:Transaction<Database>,backend:Backend,rawOwner:string,intent:CanvasBatchIntent,context:string,signal:AbortSignal,resolveFileReference?: ResolveCanvasFileReference){
  const publications:CanvasEditPublication[]=[]
  const results:Record<string,unknown>[]=[]
  let mutated=false
  for(let index=0;index<intent.operations.length;index++){
    signal.throwIfAborted()
    const entry=intent.operations[index]!
    try{
      if('w' in entry||'h' in entry)throw new MindCanvasItemMutationError('不能修改画布卡片大小，请使用 width 和 height 设置画布便签大小',422)
      if(entry.position&&('w' in entry.position||'h' in entry.position))throw new MindCanvasItemMutationError('不能在 position 中传入卡片大小，请使用 width/height',422)
      if(entry.kind!=='create_note'&&entry.kind!=='update_item'&&('width' in entry||'height' in entry))throw new MindCanvasItemMutationError('只有画布便签支持设置大小',422)
      let edit:CanvasEditIntent
      switch(entry.kind){
        case 'create_note':
          if(entry.title!==undefined&&(typeof entry.title!=='string'||[...entry.title.trim()].length>300)||entry.content!==undefined&&typeof entry.content!=='string')throw new MindCanvasNoteMutationError('第 '+(index+1)+' 个便签操作格式不正确',422)
          edit={action:'create_note',canvas_id:intent.canvas_id,entries:[{title:entry.title,content:entry.content,color:entry.color,position:entry.position,width:entry.width,height:entry.height}],batched:false};break
        case 'add_node':
          if(!['project','file','event'].includes(String(entry.ref_type)))throw new MindRefNodeCreateError(422,'第 '+(index+1)+' 个放置操作缺少有效引用类型')
          edit={action:'add',canvas_id:intent.canvas_id,entries:[{ref_type:entry.ref_type,ref_id:entry.ref_id,position:entry.position}],batched:false};break
        case 'update_item':
          if(!Number.isSafeInteger(entry.item_id))throw new MindCanvasItemMutationError('第 '+(index+1)+' 个布局操作缺少 item_id',422)
          if(!['x','y','z','collapsed','width','height','position'].some(field=>entry[field]!==undefined))throw new MindCanvasItemMutationError('第 '+(index+1)+' 个布局操作没有修改字段',422)
          edit={action:'layout',canvas_id:intent.canvas_id,entries:[{item_id:entry.item_id!,position:entry.position,x:entry.x,y:entry.y,z:entry.z,collapsed:entry.collapsed,width:entry.width,height:entry.height}],batched:false};break
        case 'remove_item':
          if(!Number.isSafeInteger(entry.item_id))throw new MindCanvasItemMutationError('第 '+(index+1)+' 个移除操作缺少 item_id',422)
          edit={action:'remove',canvas_id:intent.canvas_id,item_ids:[entry.item_id!],batched:false};break
        case 'delete_note':
          if(!Number.isSafeInteger(entry.node_id)||entry.node_id!<=0)throw new MindCanvasNoteMutationError('第 '+(index+1)+' 个删除便签操作必须提供正整数 node_id',422)
          edit={action:'delete_note',canvas_id:intent.canvas_id,node_ids:[entry.node_id!],batched:false};break
        case 'connect':
          if(!Number.isSafeInteger(entry.source_node_id)||!Number.isSafeInteger(entry.target_node_id))throw new MindCanvasRelationMutationError(422,'第 '+(index+1)+' 个连接操作缺少节点')
          if((entry.source_side===undefined)!==(entry.target_side===undefined))throw new MindCanvasRelationMutationError(422,'第 '+(index+1)+' 个连接操作的两端连接点必须同时提供')
          edit={action:'connect',canvas_id:intent.canvas_id,source_node_id:entry.source_node_id!,target_node_id:entry.target_node_id!,source_side:entry.source_side,target_side:entry.target_side,batched:false};break
        default: throw new MindCanvasItemMutationError(`不支持的批量操作 ${(entry as {kind?:string}).kind??'空操作'}`,422)
      }
      const result=await applyCanvasEdits(tx,backend,rawOwner,edit,context,signal,resolveFileReference)
      const value=result.value&&typeof result.value==='object'&&!Array.isArray(result.value)?result.value as Record<string,unknown>:{}
      delete value.canvas_id
      results.push({index,kind:entry.kind,...value})
      publications.push(...result.publications)
      mutated ||= result.mutated
    }catch(error){
      if(error instanceof Error)error.message=`第 ${index+1} 个操作${error.message}`
      throw error
    }
  }
  return {value:{canvas_id:intent.canvas_id,request_id:intent.request_id,operations:results,atomic:true},publications,mutated}
}
