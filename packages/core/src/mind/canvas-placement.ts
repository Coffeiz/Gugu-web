import { noteColorValue, type NoteColorKey } from './note-colors.js'
import type { Transaction } from 'kysely'
import type { Database } from '../data/schema.js'
import type { Backend } from '../data/repositories.js'
import { strip } from '../shared/values.js'
import { agentCanvasNodeSummary } from './canvas-read.js'
import { parseCanvasData,resolveCanvasPosition,type CanvasPosition,type CanvasGeometry } from './canvas-layout.js'
import { createSqlMindCanvasItemAddRuntime } from './canvas-item-add-sql.js'
import { createSqlMindRefNodeCreateRuntime } from './ref-node-create-sql.js'
import { createMindRefNodeCreator,type MindRefNodeChangedEvent } from './ref-node-create.js'
import { createSqlMindCanvasNoteRuntime } from './canvas-note-sql.js'
import { MindCanvasItemMutationError } from './canvas-item-remove.js'
import type { CanvasEditPublication } from './canvas-edits.js'

export interface CanvasNewNote {title?:string;content?:string;color?:NoteColorKey;position?:CanvasPosition;width?:number;height?:number}
export interface CanvasReferencePlacement {node_id?:number;ref_type?:'project'|'file'|'event';ref_id?:number|string;position?:CanvasPosition}
export type CanvasPlacementIntent =
 | {action:'create_note';canvas_id:number;entries:CanvasNewNote[];batched:boolean}
 | {action:'add';canvas_id:number;entries:CanvasReferencePlacement[];batched:boolean}
export type ResolveCanvasFileReference = (owner: string, id: string, signal: AbortSignal) => Promise<{ label: string } | null>
interface Context {resolveFileReference?:ResolveCanvasFileReference;tx:Transaction<Database>;backend:Backend;owner:string;canonical:string;context:string;signal:AbortSignal;data:Record<string,unknown>;canvasId:number}
async function position(ctx:Context,p:CanvasPosition|undefined) {
  const base=ctx.tx.selectFrom('mind_canvas_items').select(['x','y','w']).where('user_id','=',ctx.owner).where('canvas_id','=',ctx.canvasId).where('deleted_at','is',null)
  let near:CanvasGeometry|null=null,last:CanvasGeometry|null=null
  if(p?.anchor==='near_node'){
    if(!Number.isSafeInteger(p.near_node_id))throw new MindCanvasItemMutationError('near_node 锚点必须提供 near_node_id',422)
    const row=await base.where('node_id','=',p.near_node_id!).executeTakeFirst();near=row?{x:Number(row.x),y:Number(row.y),w:row.w===null?null:Number(row.w)}:null
  }
  if((p?.anchor??'auto')==='auto'){
    const row=await base.orderBy('x','desc').orderBy('id','desc').limit(1).executeTakeFirst();last=row?{x:Number(row.x),y:Number(row.y),w:row.w===null?null:Number(row.w)}:null
  }
  ctx.signal.throwIfAborted()
  return resolveCanvasPosition(p,ctx.data,last,near)
}
function rejectLegacySize(entry:object) {
  const raw=entry as Record<string,unknown>,p=raw.position
  if('w' in raw||'h' in raw||(p&&typeof p==='object'&&('w' in p||'h' in p)))throw new MindCanvasItemMutationError('请使用 width 和 height 设置画布便签大小',422)
}
async function placedSummary(ctx:Context,itemId:number) {
  const row=await ctx.tx.selectFrom('mind_canvas_items as i').innerJoin('mind_nodes as n','n.id','i.node_id').selectAll('n')
   .select(['i.id as item_id','i.x','i.y','i.w','i.h','i.z','i.collapsed']).where('i.id','=',itemId).where('i.user_id','=',ctx.owner).where('n.user_id','=',ctx.owner).executeTakeFirstOrThrow()
  ctx.signal.throwIfAborted();return agentCanvasNodeSummary(row)
}
async function createNotes(ctx:Context,intent:Extract<CanvasPlacementIntent,{action:'create_note'}>) {
  const runtime=createSqlMindCanvasNoteRuntime(ctx.tx,ctx.backend,async()=>{})
  const results:Record<string,unknown>[]=[],publications:Array<CanvasEditPublication|MindRefNodeChangedEvent>=[]
  for(const entry of intent.entries){
    rejectLegacySize(entry)
    const [x,y]=await position(ctx,entry.position)
    const item=await runtime.create(ctx.canonical,ctx.canvasId,{title:strip(entry.title||'新便签')||'新便签',contentMd:entry.content||'',color:noteColorValue(entry.color??'amber'),x,y,w:entry.width??null,h:entry.height??null,z:0},ctx.context)
    results.push({canvas_id:ctx.canvasId,node:await placedSummary(ctx,item.id),created:true})
    publications.push({ownerId:ctx.canonical,operation:'create',entityId:item.id,origin:null,mutationId:null,entityKind:'canvas_item',entity:item})
  }
  return {results,publications}
}
async function addReferences(ctx:Context,intent:Extract<CanvasPlacementIntent,{action:'add'}>) {
  const publications:Array<CanvasEditPublication|MindRefNodeChangedEvent>=[],results:Record<string,unknown>[]=[]
  const ref=createMindRefNodeCreator(createSqlMindRefNodeCreateRuntime(ctx.tx,ctx.backend,async event=>{publications.push(event)},undefined,undefined,
    ctx.resolveFileReference && ((owner,id)=>ctx.resolveFileReference!(owner,id,ctx.signal))))
  const items=createSqlMindCanvasItemAddRuntime(ctx.tx,ctx.backend,async()=>{})
  for(const entry of intent.entries){
    rejectLegacySize(entry)
    if('width' in entry||'height' in entry)throw new MindCanvasItemMutationError('只有画布便签支持设置卡片大小',422)
    let nodeId=entry.node_id
    if(nodeId!==undefined){
      const node=await ctx.tx.selectFrom('mind_nodes').select('id').where('id','=',nodeId).where('user_id','=',ctx.owner).where('kind','=','ref').where('deleted_at','is',null).executeTakeFirst()
      if(!node)throw new MindCanvasItemMutationError('只能把项目、文件或活动引用节点放入画布',422)
    }else{
      const node=await ref.create(ctx.canonical,{ref_type:entry.ref_type,ref_id:entry.ref_id},{undoContextId:ctx.context,clientId:null,mutationId:null});nodeId=node.id
    }
    ctx.signal.throwIfAborted()
    const existing=await ctx.tx.selectFrom('mind_canvas_items').select('id').where('canvas_id','=',ctx.canvasId).where('user_id','=',ctx.owner).where('node_id','=',nodeId).where('deleted_at','is',null).executeTakeFirst()
    if(existing){results.push({canvas_id:ctx.canvasId,node:await placedSummary(ctx,Number(existing.id)),created:false});continue}
    const [x,y]=await position(ctx,entry.position)
    const result=await items.add(ctx.canonical,ctx.canvasId,{nodeId,x,y,w:null,h:null,z:0,collapsed:false,dataJson:'{}'},ctx.context)
    results.push({canvas_id:ctx.canvasId,node:await placedSummary(ctx,result.item.id),created:result.created})
    if(result.created)publications.push({ownerId:ctx.canonical,operation:'create',entityId:result.item.id,origin:null,mutationId:null,entity:result.item})
  }
  return {results,publications}
}
/** 调用方已经锁定画布并提供外层事务；新增引用、节点、视图和Undo原子提交。 */
async function placementContext(base:Omit<Context,'data'|'canvasId'>,canvasId:number):Promise<Context> {
  const {tx,owner,signal}=base
  const canvas=await tx.selectFrom('mind_maps').select('data_json').where('id','=',canvasId).where('user_id','=',owner).where('deleted_at','is',null).executeTakeFirst()
  if(!canvas)throw new MindCanvasItemMutationError('画布不存在',404)
  signal.throwIfAborted()
  return {...base,data:parseCanvasData(canvas.data_json),canvasId}
}

export async function resolveCanvasEditPosition(base:Omit<Context,'data'|'canvasId'>,canvasId:number,value:CanvasPosition) {
  return position(await placementContext(base,canvasId),value)
}

export async function applyCanvasPlacements(base:Omit<Context,'data'|'canvasId'>,intent:CanvasPlacementIntent) {
  const ctx=await placementContext(base,intent.canvas_id)
  return intent.action==='create_note'?createNotes(ctx,intent):addReferences(ctx,intent)
}
